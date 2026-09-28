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
 */
export function applyReplacements(text: string, rules: ReplacementRule[]): Replaced {
  let out = text;
  let count = 0;
  for (const rule of rules) {
    if (rule.match === "") continue;
    const hits = out.split(rule.match).length - 1;
    if (hits === 0) continue;
    out = out.replaceAll(rule.match, rule.replace);
    count += hits;
  }
  return { text: out, count };
}

/** Decompressors for the encodings this module can rewrite. */
function decodeBody(body: Buffer, kind: string): Buffer | null {
  try {
    if (kind === "gzip") return zlib.gunzipSync(body);
    if (kind === "br") return zlib.brotliDecompressSync(body);
    if (kind === "deflate") return zlib.inflateSync(body);
    if (kind === "zstd" && typeof zlib.zstdDecompressSync === "function") {
      return (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer }).zstdDecompressSync(
        body
      );
    }
  } catch {
    return null; // claims that encoding but does not decode as it
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
  rules: ReplacementRule[]
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
    const decoded = decodeBody(body, kind);
    if (decoded === null) return passthrough;
    plain = decoded;
  }

  const { text, count } = applyReplacements(plain.toString("utf8"), rules);
  if (count === 0) return passthrough;
  const replaced = Buffer.from(text, "utf8");

  if (kind === "" || kind === "identity") {
    return { body: replaced, encoding, count };
  }
  const encoded = encodeBody(replaced, kind);
  if (encoded === null) return passthrough; // cannot re-compress: leave untouched
  return { body: encoded, encoding, count };
}

const TEXTUAL = /text|json|event-stream|javascript|xml|urlencoded/i;

/**
 * Should a body of this content-type be considered rewritable text? A missing
 * content-type is treated as text: model APIs sometimes omit it, and a rule
 * that matches nothing costs nothing anyway.
 */
export function contentTypeIsTextish(contentType: string | string[] | undefined): boolean {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  if (!value) return true;
  return TEXTUAL.test(value);
}
