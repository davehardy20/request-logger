/**
 * replacements.ts — match-and-replace rules for intercepted traffic.
 *
 * Rules live in replacements.json next to proxy.ts as a JSON array:
 *
 *   [
 *     { "match": "deny",  "replace": "allow" },
 *     { "match": "block", "replace": "pass" }
 *   ]
 *
 * Each rule is a plain, case-sensitive substring substitution. An empty file,
 * an empty array, or no file at all means zero rules — every request and
 * response then passes through byte-for-byte untouched, exactly as before
 * this feature existed.
 *
 * Rules apply top to bottom, so the output of one rule is fed into the next
 * (sed semantics): with rules deny→allow followed by allow→pass, "deny"
 * ends up as "pass". Order the file accordingly.
 *
 * An optional "scope" limits a rule to one direction of traffic:
 *
 *   { "match": "I cannot assist", "replace": "", "scope": "response" }
 *
 * Without a scope a rule applies to both the request body and the response
 * body. Bodies are only rewritten when their content-type looks textual
 * (JSON, text, SSE, XML…) — binary traffic such as images or audio is never
 * touched.
 *
 * Compressed bodies (gzip, brotli, deflate, zstd) are decompressed, replaced,
 * and re-compressed with the same algorithm, so the wire format the other
 * side expects is preserved. An encoding this module cannot decode is left
 * alone rather than corrupted.
 */

import fs from "node:fs";
import zlib from "node:zlib";

export type ReplacementScope = "request" | "response";

export interface ReplacementRule {
  /** The literal substring to find. Case-sensitive. */
  match: string;
  /** What to replace it with. "" deletes the match. */
  replace: string;
  /** Restrict the rule to one direction of traffic. Absent = both. */
  scope?: ReplacementScope;
}

/**
 * Warnings about a malformed replacements file are printed once per unique
 * message, not once per request. A retry storm must not turn a single typo
 * in the JSON into a thousand lines of the same complaint.
 */
const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[request-logger] ${message}`);
}

/** Only for tests: forget which warnings have been printed. */
export function resetReplacementWarnings(): void {
  warned.clear();
}

/**
 * Read and validate the rules file. Anything unreadable, unparsable, or
 * empty yields [] — which the proxy treats as "pass everything through",
 * so a broken rules file can never take traffic down with it.
 */
export function loadReplacements(file: string): ReplacementRule[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return []; // no file yet, or unreadable: nothing to apply
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnOnce(
      `replacements file is not valid JSON (${(err as Error).message}); ` +
        "passing traffic through untouched"
    );
    return [];
  }

  if (parsed == null) return [];
  if (!Array.isArray(parsed)) {
    warnOnce(
      "replacements file must be a JSON array of { match, replace } objects; " +
        "passing traffic through untouched"
    );
    return [];
  }

  const rules: ReplacementRule[] = [];
  parsed.forEach((entry: unknown, index: number) => {
    const ok =
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ReplacementRule).match === "string" &&
      (entry as ReplacementRule).match !== "" &&
      typeof (entry as ReplacementRule).replace === "string";
    if (!ok) {
      warnOnce(
        `replacement rule #${index} ignored: needs a non-empty string "match" ` +
          'and a string "replace"'
      );
      return;
    }
    const scope = (entry as ReplacementRule).scope;
    if (scope !== undefined && scope !== "request" && scope !== "response") {
      warnOnce(`replacement rule #${index} ignored: "scope" must be "request" or "response"`);
      return;
    }
    rules.push(scope ? { ...(entry as ReplacementRule), scope } : (entry as ReplacementRule));
  });
  return rules;
}

/** The rules that apply to one direction of traffic. */
export function rulesForScope(
  rules: ReplacementRule[],
  scope: ReplacementScope
): ReplacementRule[] {
  return rules.filter((rule) => rule.scope === undefined || rule.scope === scope);
}

export interface Replaced {
  text: string;
  /** How many matches were replaced (occurrences, not rules). */
  count: number;
}

/**
 * Apply the rules in order, feeding each rule the output of the last.
 * A rule with no hits costs nothing and leaves the text untouched.
 *
 * An expansionary rule set (longer replacements than matches) must not turn
 * a modest body into an unbounded one: past the output cap the rewrite is
 * abandoned whole — the original text comes back with count 0, because
 * half-rewritten text would be worse than none.
 */
export function applyReplacements(
  text: string,
  rules: ReplacementRule[],
  limits: RewriteLimits = DEFAULT_LIMITS
): Replaced {
  let out = text;
  let count = 0;
  for (const rule of rules) {
    if (rule.match === "") continue;
    const hits = out.split(rule.match).length - 1;
    if (hits === 0) continue;
    out = out.replaceAll(rule.match, rule.replace);
    count += hits;
    if (out.length > limits.output) return { text, count: 0 };
  }
  return { text: out, count };
}

/** Size caps that keep one pathological body from eating the process. */
export interface RewriteLimits {
  /** A compressed body that would decode larger than this is passed through compressed, untouched. */
  decoded: number;
  /** A body larger than this (after decompression) is never rewritten. */
  input: number;
  /** A rewrite whose output would grow past this is abandoned; the original text comes back. */
  output: number;
}

/** Caps sized for a single-user local proxy: generous, but never unbounded. */
export const DEFAULT_LIMITS: RewriteLimits = {
  decoded: 64 * 1024 * 1024,
  input: 64 * 1024 * 1024,
  output: 256 * 1024 * 1024
};

/** Decompressors for the encodings this module can rewrite, all bounded by the decoded cap. */
function decodeBody(body: Buffer, kind: string, limits: RewriteLimits): Buffer | null {
  const options = { maxOutputLength: limits.decoded };
  try {
    if (kind === "gzip") return zlib.gunzipSync(body, options);
    if (kind === "br") return zlib.brotliDecompressSync(body, options);
    if (kind === "deflate") return zlib.inflateSync(body, options);
    if (kind === "zstd" && typeof zlib.zstdDecompressSync === "function") {
      return (
        zlib as unknown as { zstdDecompressSync: (b: Buffer, o: object) => Buffer }
      ).zstdDecompressSync(body, options);
    }
  } catch {
    return null; // claims that encoding but does not decode as it — or it would decode past the cap
  }
  return null;
}

/** Re-compress with the same algorithm, so the declared encoding stays true. */
function encodeBody(body: Buffer, kind: string): Buffer | null {
  try {
    if (kind === "gzip") return zlib.gzipSync(body);
    if (kind === "br") return zlib.brotliCompressSync(body);
    if (kind === "deflate") return zlib.deflateSync(body);
    if (kind === "zstd" && typeof zlib.zstdCompressSync === "function") {
      return (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync(
        body
      );
    }
  } catch {
    return null;
  }
  return null;
}

export interface RewrittenBody {
  body: Buffer;
  /** The content-encoding of the returned body (always the input one). */
  encoding: string | undefined;
  count: number;
}

/**
 * Rewrite a whole request or response body under the given rules.
 *
 * The three outcomes are:
 *  - rules applied: decompressed if needed, replaced, re-compressed the same
 *    way, with count > 0.
 *  - rules matched nothing (count 0): the original bytes come straight back.
 *  - body cannot be decoded (unknown or corrupt encoding): the original
 *    bytes come straight back. Never corrupt, never guess.
 */
export function rewriteBody(
  body: Buffer,
  encoding: string | undefined,
  rules: ReplacementRule[],
  limits: RewriteLimits = DEFAULT_LIMITS
): RewrittenBody {
  const passthrough: RewrittenBody = {
    body,
    encoding,
    count: 0
  };
  if (rules.length === 0 || body.length === 0) return passthrough;

  const kind = (encoding ?? "").trim().toLowerCase();
  let plain: Buffer;
  if (kind === "" || kind === "identity") {
    plain = body;
  } else {
    const decoded = decodeBody(body, kind, limits);
    if (decoded === null) return passthrough;
    plain = decoded;
  }
  if (plain.length > limits.input) return passthrough; // too big to rewrite: forward as-is

  // A body that is not clean UTF-8 would be silently corrupted by a rewrite
  // it never asked for — toString swaps invalid bytes for U+FFFD. Only rewrite
  // a body that decodes and re-encodes back to the very same bytes; anything
  // else passes through untouched, whatever its rules matched.
  const text = plain.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(plain)) return passthrough;

  const { text: replaced, count } = applyReplacements(text, rules, limits);
  if (count === 0) return passthrough;
  const rewritten = Buffer.from(replaced, "utf8");

  if (kind === "" || kind === "identity") {
    return { body: rewritten, encoding, count };
  }
  const encoded = encodeBody(rewritten, kind);
  if (encoded === null) return passthrough; // cannot re-compress: leave untouched
  return { body: encoded, encoding, count };
}

/** The media type of a content-type header, lowercased, without parameters. */
function mediaType(contentType: string | string[] | undefined): string {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return (value ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * Should a body of this content-type be considered rewritable text? Only the
 * media type decides — parameters never do, so
 * `application/octet-stream; filename=config.json` is binary and stays
 * untouched. A missing content-type is treated as text: model APIs
 * sometimes omit it, and a rule that matches nothing costs nothing anyway.
 */
export function contentTypeIsTextish(contentType: string | string[] | undefined): boolean {
  const type = mediaType(contentType);
  if (type === "") return true;
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/javascript" ||
    type === "application/xml" ||
    type === "application/xhtml+xml" ||
    type === "application/x-www-form-urlencoded" ||
    type.endsWith("+json")
  );
}

/** Is this a Server-Sent Events stream, which must be rewritten while streaming? */
export function contentTypeIsSse(contentType: string | string[] | undefined): boolean {
  return mediaType(contentType) === "text/event-stream";
}

export interface StreamRewriter {
  /** Rewrite one chunk as it arrives; returns the bytes safe to send now. */
  push(chunk: Buffer): Buffer;
  /** Rewrite the withheld tail. Call once, when the stream ends. */
  flush(): Buffer;
  /** Total matches replaced so far, the flush included. */
  count(): number;
}

/**
 * Rewrites a chunked text stream (SSE) without waiting for it to end.
 *
 * A never-ending stream can never be buffered whole, so each chunk is
 * rewritten as it arrives and forwarded immediately. The tail of every
 * chunk is withheld until it is provably safe to emit: never in the middle
 * of a multi-byte UTF-8 character, and never ending with the beginning of
 * a match whose remainder has not arrived yet. A chunk whose ready region
 * is not clean UTF-8 switches the rewriter to verbatim pass-through for
 * the rest of the stream — never corrupt beats always rewrite.
 */
export function makeStreamRewriter(
  rules: ReplacementRule[],
  limits: RewriteLimits = DEFAULT_LIMITS
): StreamRewriter {
  const matchBuffers = rules.filter((r) => r.match !== "").map((r) => Buffer.from(r.match, "utf8"));
  let carry = Buffer.alloc(0);
  let count = 0;
  let verbatim = false;

  /**
   * The length of the longest suffix of `bytes` that is a proper prefix of
   * some rule's match — i.e. how many trailing bytes could be the beginning
   * of a match whose remainder has not arrived yet. Zero means the region
   * ends cleanly and is safe to emit.
   */
  function partialMatchSuffix(bytes: Buffer): number {
    let best = 0;
    for (const match of matchBuffers) {
      const take = Math.min(match.length - 1, bytes.length);
      for (let n = take; n > best; n--) {
        if (bytes.subarray(bytes.length - n).equals(match.subarray(0, n))) {
          best = n;
          break;
        }
      }
    }
    return best;
  }

  function rewriteReady(ready: Buffer): Buffer {
    if (ready.length === 0) return Buffer.alloc(0);
    const text = ready.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(ready)) {
      verbatim = true;
      return ready;
    }
    const { text: out, count: hits } = applyReplacements(text, rules, limits);
    if (hits === 0) return ready; // nothing matched: the original bytes, unchanged
    count += hits;
    return Buffer.from(out, "utf8");
  }

  return {
    push(chunk: Buffer): Buffer {
      if (verbatim) {
        // Verbatim from here on, but the withheld tail still precedes this
        // chunk in stream order — emit it first, or the client would see
        // bytes arrive out of order.
        const out = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
        carry = Buffer.alloc(0);
        return out;
      }
      const combined = Buffer.concat([carry, chunk]);
      if (combined.length <= 4) {
        carry = combined;
        return Buffer.alloc(0);
      }
      let cut = combined.length - 4;
      // An emitted region must never END with the start of a match: a match
      // straddling the emitted/withheld boundary would have its first half
      // gone for good and could never be rewritten. Withhold byte by byte
      // until the region's suffix is not a proper prefix of any match.
      for (;;) {
        const overlap = partialMatchSuffix(combined.subarray(0, cut));
        if (overlap === 0) break;
        cut -= overlap;
        if (cut <= 0) {
          carry = combined;
          return Buffer.alloc(0);
        }
      }
      // Never split a multi-byte UTF-8 character: step back over continuation bytes.
      while (cut > 0 && (combined[cut] & 0xc0) === 0x80) cut--;
      if (cut <= 0) {
        carry = combined;
        return Buffer.alloc(0);
      }
      const ready = combined.subarray(0, cut);
      carry = combined.subarray(cut);
      return rewriteReady(ready);
    },
    flush(): Buffer {
      if (verbatim) {
        const out = carry;
        carry = Buffer.alloc(0);
        return out;
      }
      const out = rewriteReady(carry);
      carry = Buffer.alloc(0);
      return out;
    },
    count: () => count
  };
}
