/**
 * request-logger — see every request your coding agent sends to the model.
 *
 * It sits between a coding agent and the model provider's API. It forwards
 * every request untouched — auth header and all — streams the response straight
 * back so the agent is unaffected, and writes a readable Markdown document for
 * each request showing exactly what was sent to the model.
 *
 * On the first run it asks which agent you use. It saves the answer, prints the
 * exact command for that agent, and forwards to that agent's one upstream host.
 * Run it with --force to choose again.
 *
 * Run:   npm run request-logger
 *        npm run request-logger -- --force
 *
 * Zero runtime dependencies — Node built-ins only.
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";
import zlib from "node:zlib";
import {
  type AgentChoice,
  type CustomTarget,
  type ResolvedTarget,
  resolveChoice,
  shouldLogRequest,
} from "./agents";
import { askChoice, clearChoice, loadChoice, saveChoice } from "./config";
import { renderMarkdown } from "./render";
import {
  contentTypeIsSse,
  contentTypeIsTextish,
  DEFAULT_LIMITS,
  loadReplacements,
  makeStreamRewriter,
  type ReplacementRule,
  rewriteBody,
  rulesForScope,
} from "./replacements";

/**
 * A resolved target the proxy can actually route to and render: a catalogue
 * ResolvedTarget or a student-typed CustomTarget. The two are used
 * interchangeably everywhere below except upstreamConnection, which is the
 * one place their upstream host is found differently.
 */
type ProxyTarget = ResolvedTarget | CustomTarget;

const PORT = Number(process.env.PORT ?? 8787);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG_DIR = path.join(HERE, "logs");
const STATE_FILE = path.join(HERE, ".agent-choice.json");
// Module-level on purpose, like burstState below: one directory for the
// whole process. Tests swap it for a scratch directory via setLogDir so
// end-to-end runs never write synthetic captures into the real logs/.
let LOG_DIR = DEFAULT_LOG_DIR;

/** Test hook: point the capture writer at a scratch directory. */
export function setLogDir(dir: string): void {
  LOG_DIR = dir;
}

/** Test hook: put captures back where a real run keeps them. */
export function resetLogDir(): void {
  LOG_DIR = DEFAULT_LOG_DIR;
}
// Match-and-replace rules, read from disk on every request so edits apply
// without a restart. Missing or empty file = zero rules = byte-for-byte
// pass-through, exactly as this tool behaved before the feature existed.
const REPLACEMENTS_FILE = path.join(HERE, "replacements.json");

/**
 * Size caps for response handling, shared by every path below: rewriting
 * stops past the decoded cap, and the capture never keeps more than
 * CAPTURE_LIMIT_BYTES of a stream. `decoded` comes from the replacements
 * module so one body obeys one budget everywhere.
 */
const PROXY_LIMITS = { decoded: DEFAULT_LIMITS.decoded };
const CAPTURE_LIMIT_BYTES = 1024 * 1024;

/** A header value, when Node reports it as one value or many. */
function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// ---------------------------------------------------------------------------
// Proxying
// ---------------------------------------------------------------------------

/** Build a filesystem-safe base name: 2026-07-07T14-32-05-123_claude-code */
function baseName(target: ProxyTarget): string {
  const iso = new Date().toISOString(); // 2026-07-07T14:32:05.123Z
  const stamp = iso.replace(/:/g, "-").replace(".", "-").replace("Z", "");
  return `${stamp}_${target.agent}`;
}

/**
 * Where a target's traffic actually goes: a scheme, a host and a port.
 *
 * A catalogue ResolvedTarget is always HTTPS on 443 — every provider in the
 * catalogue is a public HTTPS API, so this has never needed to vary, and
 * still does not: it is read straight off upstreamHost, unchanged. A
 * CustomTarget can be anything the student typed, including plain HTTP on an
 * arbitrary port (a local Ollama server, say), so its scheme and port are
 * parsed from the base URL instead of assumed.
 */
export function upstreamConnection(target: ProxyTarget): {
  hostname: string;
  port: number;
  useHttps: boolean;
} {
  if (target.kind === "target") {
    return { hostname: target.upstreamHost, port: 443, useHttps: true };
  }
  const url = new URL(target.upstreamBaseUrl);
  const useHttps = url.protocol === "https:";
  return {
    hostname: url.hostname,
    port: url.port ? Number(url.port) : useHttps ? 443 : 80,
    useHttps,
  };
}

/**
 * The path prefix a CustomTarget's base URL carries, if any — e.g.
 * "/zen/go" for https://opencode.ai/zen/go. Empty for a bare origin, and
 * always empty for a catalogue ResolvedTarget, which never carries one (see
 * upstreamHost). handle() prepends this to each request's own path so a
 * student-typed base URL with a path segment is not silently dropped —
 * without it, https://opencode.ai/zen/go would forward to
 * https://opencode.ai/v1/chat/completions instead of
 * https://opencode.ai/zen/go/v1/chat/completions, a 404.
 *
 * agents.ts already strips a trailing slash and collapses a bare "/" to ""
 * before this is stored, so plain concatenation against a leading-slash
 * request path never produces a doubled or missing slash — but the
 * stripping is repeated here too, since nothing stops a test or a future
 * caller from constructing a CustomTarget by hand with a trailing slash.
 */
export function upstreamPathPrefix(target: ProxyTarget): string {
  if (target.kind === "target") return "";
  const { pathname } = new URL(target.upstreamBaseUrl);
  return pathname === "/" ? "" : pathname.replace(/\/+$/, "");
}

/**
 * Headers forwarded upstream. We strip hop-by-hop headers, and we ask for an
 * uncompressed response so the capture is readable, then recompute the length
 * against the buffered body.
 *
 * We deliberately keep `content-encoding`. Some agents compress the request
 * body, and the upstream must receive those bytes exactly as the agent produced
 * them. Only the copy we write to disk is decoded.
 *
 * Auth headers pass through untouched so the real request still authenticates.
 */
function forwardHeaders(
  headers: http.IncomingHttpHeaders,
  body: Buffer
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers };
  delete out.host;
  delete out.connection;
  delete out["accept-encoding"]; // force identity so we can read the stream
  delete out["transfer-encoding"];
  delete out["content-length"];
  if (body.length > 0) out["content-length"] = String(body.length);
  return out;
}

/**
 * One request: buffer the agent's body, rewrite it if request rules apply,
 * forward it upstream, then either stream the response straight back (no
 * response rules — the agent is unaffected) or buffer and rewrite the
 * response before returning it (response rules exist).
 *
 * The rules are read from disk on every call, so edits to replacements.json
 * take effect on the next request without a restart. Tests pass rules
 * directly instead.
 */
export function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: ProxyTarget,
  rules: ReplacementRule[] = loadReplacements(REPLACEMENTS_FILE)
): void {
  const reqPath = req.url ?? "/";
  // The path actually sent upstream: the agent's own request path, prefixed
  // with whatever path segment the student's custom base URL carried (e.g.
  // "/zen/go" + "/v1/chat/completions"). Empty prefix, catalogue target or
  // path-free custom target alike, leaves reqPath untouched — see
  // upstreamPathPrefix.
  const upstreamPath = upstreamPathPrefix(target) + reqPath;

  const bodyChunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(bodyChunks);
    const timestamp = new Date().toISOString();
    const base = baseName(target);
    const requestEncoding = header(req.headers["content-encoding"]);
    const { hostname, port, useHttps } = upstreamConnection(target);

    // Match-and-replace on the way out. The capture below logs the bytes
    // that were actually forwarded, so the .md shows the model what it
    // really received.
    const requestRules = rulesForScope(rules, "request");
    const responseRules = rulesForScope(rules, "response");
    let forwardBody: Buffer = body;
    let requestReplacements = 0;
    if (
      requestRules.length > 0 &&
      contentTypeIsTextish(req.headers["content-type"])
    ) {
      const rewritten = rewriteBody(body, requestEncoding, requestRules);
      forwardBody = rewritten.body;
      requestReplacements = rewritten.count;
    }

    const onUpstreamResponse = (upstreamRes: http.IncomingMessage) => {
      const statusCode = upstreamRes.statusCode ?? 502;
      const contentType = upstreamRes.headers["content-type"];
      // A bodyless response (HEAD, 204, 304) carries nothing to rewrite, and
      // its content-length describes a body that will never arrive — forward
      // it verbatim rather than rewriting its headers around an empty body.
      const bodyless =
        req.method === "HEAD" || statusCode === 204 || statusCode === 304;
      // An SSE stream whose content-encoding has no streaming decoder here
      // cannot be safely rewritten — treating compressed bytes as text is
      // guessing. Stream it through verbatim with a warning instead.
      const encKind = (header(upstreamRes.headers["content-encoding"]) ?? "")
        .trim()
        .toLowerCase();
      const streamingDecoder: (() => zlib.Gunzip) | (() => zlib.Inflate) | (() => zlib.BrotliDecompress) | undefined =
        encKind === "gzip"
          ? zlib.createGunzip
          : encKind === "deflate"
            ? zlib.createInflate
            : encKind === "br"
              ? zlib.createBrotliDecompress
              : undefined;
      const sseEncodingUnreadable =
        contentTypeIsSse(contentType) &&
        encKind !== "" &&
        encKind !== "identity" &&
        !streamingDecoder;
      if (sseEncodingUnreadable) {
        console.warn(
          `[request-logger] SSE response arrived ${encKind}-compressed; this tool has no streaming decoder for it, so the stream passes through untouched.`
        );
      }
      const canRewrite =
        responseRules.length > 0 &&
        !bodyless &&
        contentTypeIsTextish(contentType) &&
        !sseEncodingUnreadable;

      // No response rules, a binary body, or nothing to rewrite: stream
      // straight back to the agent, unbuffered, exactly as this tool behaved
      // before match-and-replace existed.
      if (!canRewrite) {
        res.writeHead(statusCode, upstreamRes.headers);
        // The capture keeps at most CAPTURE_LIMIT_BYTES of a stream that may
        // never end; the bytes themselves still all flow through.
        const responseChunks: Buffer[] = [];
        let captured = 0;
        upstreamRes.on("data", (chunk: Buffer) => {
          if (captured < CAPTURE_LIMIT_BYTES) {
            responseChunks.push(chunk);
            captured += chunk.length;
          }
          res.write(chunk); // stream straight back to the agent, unbuffered
        });
        upstreamRes.on("end", () => {
          res.end();
          writeCapture({
            base,
            target,
            timestamp,
            method: req.method ?? "POST",
            path: reqPath,
            statusCode: upstreamRes.statusCode ?? 0,
            headers: req.headers,
            requestBody: forwardBody,
            requestEncoding,
            responseRaw: Buffer.concat(responseChunks).toString("utf8"),
            requestReplacements,
            responseReplacements: 0,
          });
        });
        return;
      }

      // A Server-Sent Events stream may never end, so it can never be
      // buffered whole: waiting for the end would hang the agent forever.
      // Instead each chunk is rewritten as it arrives and sent on at once,
      // with the last few bytes withheld until the next chunk shows what
      // follows — see makeStreamRewriter.
      if (contentTypeIsSse(contentType)) {
        const rewriter = makeStreamRewriter(responseRules);
        const headers = { ...upstreamRes.headers };
        delete headers["content-length"];
        delete headers["transfer-encoding"];
        // An upstream that compresses despite the stripped accept-encoding
        // (rare, but it happens) must not feed the rewriter compressed
        // bytes: it would find no matches and pass the rules by silently.
        // Decode the stream on the way through and send it on as identity.
        // Validators that describe the compressed representation (ETag,
        // Digest, Content-MD5) no longer describe what the agent receives,
        // so they go the same way as on the buffered path.
        let source: NodeJS.ReadableStream = upstreamRes;
        if (encKind !== "" && encKind !== "identity" && streamingDecoder) {
          const decoder = streamingDecoder();
          source = upstreamRes.pipe(decoder);
          delete headers["content-encoding"];
          delete headers.etag;
          delete headers.digest;
          delete headers["content-md5"];
        }
        res.writeHead(statusCode, headers);
        // A stream can outlive any buffer: the capture keeps at most
        // CAPTURE_LIMIT_BYTES of it, and rewriting stops (with the withheld
        // tail flushed, in order) once the decoded stream passes the
        // decoded cap. Progress and bounded memory beat completeness on a
        // stream that was never going to be reasonably rewritable anyway.
        const written: Buffer[] = [];
        let captured = 0;
        let fed = 0;
        let rewriteAbandoned = false;
        const push = (out: Buffer): void => {
          res.write(out);
          if (captured < CAPTURE_LIMIT_BYTES) {
            written.push(out);
            captured += out.length;
          }
        };
        const finish = (): void => {
          const tail = rewriter.flush();
          if (tail.length > 0) push(tail);
          res.end();
          writeCapture({
            base,
            target,
            timestamp,
            method: req.method ?? "POST",
            path: reqPath,
            statusCode: upstreamRes.statusCode ?? 0,
            headers: req.headers,
            requestBody: forwardBody,
            requestEncoding,
            responseRaw: Buffer.concat(written).toString("utf8"),
            requestReplacements,
            responseReplacements: rewriter.count(),
          });
        };
        source.on("data", (chunk: Buffer) => {
          fed += chunk.length;
          if (rewriteAbandoned) {
            push(chunk);
            return;
          }
          if (fed > PROXY_LIMITS.decoded) {
            rewriteAbandoned = true;
            console.warn(
              "[request-logger] SSE stream passed the rewrite size cap; rewriting stops, the rest passes through untouched."
            );
            const tail = rewriter.flush();
            if (tail.length > 0) push(tail);
            push(chunk);
            return;
          }
          const out = rewriter.push(chunk);
          if (out.length > 0) push(out);
        });
        source.on("end", finish);
        source.on("error", (err: Error) => {
          // A truncated or corrupt compressed stream: flush what was
          // withheld, close cleanly, and still write the capture.
          console.error(`[request-logger] SSE stream error: ${err.message}`);
          finish();
        });
        return;
      }

      // Everything else is a whole body: buffer it, because a match can
      // straddle chunks, so none of the body is safe to send until all of
      // it is read. The agent's streaming is traded for a correct rewrite,
      // and only while response rules exist. A body that outgrows the
      // rewrite cap mid-buffer stops being buffered: headers go out as they
      // arrived, what was already read is written straight through, and the
      // rest streams — a body too big to rewrite is still a body the agent
      // must receive. Nothing matched: the response is forwarded exactly as
      // it arrived, headers and all. Something matched: lengths and digests
      // that described the original bytes (content-length, ETag, Digest,
      // Content-MD5) would misdescribe the rewritten ones, so length is
      // recomputed and the digests dropped; the declared content-encoding
      // stays true because rewriteBody re-compresses with the same algorithm.
      const responseChunks: Buffer[] = [];
      let oversized = false;
      upstreamRes.on("data", (chunk: Buffer) => {
        if (oversized) {
          res.write(chunk);
          return;
        }
        if (
          responseChunks.reduce((n, b) => n + b.length, 0) + chunk.length >
          PROXY_LIMITS.decoded
        ) {
          oversized = true;
          console.warn(
            "[request-logger] response body passed the rewrite size cap; it is forwarded untouched instead of rewritten."
          );
          res.writeHead(statusCode, upstreamRes.headers);
          for (const buffered of responseChunks) res.write(buffered);
          res.write(chunk);
          return;
        }
        responseChunks.push(chunk);
      });
      upstreamRes.on("end", () => {
        if (oversized) {
          res.end();
          writeCapture({
            base,
            target,
            timestamp,
            method: req.method ?? "POST",
            path: reqPath,
            statusCode: upstreamRes.statusCode ?? 0,
            headers: req.headers,
            requestBody: forwardBody,
            requestEncoding,
            responseRaw: "(response exceeded the rewrite size cap; forwarded untouched, not captured)",
            requestReplacements,
            responseReplacements: 0,
          });
          return;
        }
        const raw = Buffer.concat(responseChunks);
        const rewritten = rewriteBody(
          raw,
          header(upstreamRes.headers["content-encoding"]),
          responseRules
        );
        if (rewritten.count === 0) {
          res.writeHead(statusCode, upstreamRes.headers);
          res.end(raw);
        } else {
          const headers = { ...upstreamRes.headers };
          delete headers["content-length"];
          delete headers["transfer-encoding"];
          delete headers.etag;
          delete headers.digest;
          delete headers["content-md5"];
          if (rewritten.body.length > 0) {
            headers["content-length"] = String(rewritten.body.length);
          }
          res.writeHead(statusCode, headers);
          res.end(rewritten.body);
        }
        writeCapture({
          base,
          target,
          timestamp,
          method: req.method ?? "POST",
          path: reqPath,
          statusCode: upstreamRes.statusCode ?? 0,
          headers: req.headers,
          requestBody: forwardBody,
          requestEncoding,
          responseRaw: (rewritten.count === 0 ? raw : rewritten.body).toString("utf8"),
          requestReplacements,
          responseReplacements: rewritten.count,
        });
      });
    };

    const requestOptions: http.RequestOptions = {
      hostname,
      port,
      path: upstreamPath,
      method: req.method,
      headers: {
        ...forwardHeaders(req.headers, forwardBody),
        host: hostname,
      },
    };
    const upstreamReq = useHttps
      ? https.request(requestOptions, onUpstreamResponse)
      : http.request(requestOptions, onUpstreamResponse);

    upstreamReq.on("error", (err) => {
      console.error(`[request-logger] upstream error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(
        JSON.stringify({ error: `request-logger upstream error: ${err.message}` })
      );
    });

    if (forwardBody.length > 0) upstreamReq.write(forwardBody);
    upstreamReq.end();
  });
}

/**
 * Some agents probe the upstream with a WebSocket upgrade before falling
 * back to plain HTTP — Codex on a ChatGPT subscription does this against
 * /backend-api/codex/responses. This proxy is HTTP-only end to end, and
 * letting the attempt through does not fail closed, it stalls forever: a
 * successful upstream upgrade arrives on the outbound request's 'upgrade'
 * event, not 'response', and nothing here listens for it, so Node just
 * closes that socket with no response and no error. Nothing ever calls
 * res.end() on the agent's connection, so the agent is left waiting on a
 * reply that will never come.
 *
 * Answering every upgrade attempt with 426 here, immediately, gives the
 * agent's own fallback logic something concrete to react to instead of
 * silence, so it retries over plain HTTP right away rather than hanging or
 * waiting out its own timeout.
 */
export function rejectUpgrade(req: http.IncomingMessage, socket: Duplex): void {
  console.log(
    dim(
      `[request-logger] ${req.method ?? "GET"} ${req.url ?? "/"} tried a WebSocket upgrade -> 426 (forcing HTTP fallback)`
    )
  );
  socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

interface Capture {
  base: string;
  target: ProxyTarget;
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  requestBody: Buffer;
  requestEncoding?: string;
  responseRaw: string;
  /** How many match-and-replace substitutions were applied each way. */
  requestReplacements: number;
  responseReplacements: number;
}

// ---------------------------------------------------------------------------
// Retry-burst guard
// ---------------------------------------------------------------------------

/**
 * Tell a tight client-side retry loop apart from ordinary traffic, so one can
 * be throttled without touching the other.
 *
 * This exists because a wrong scheme or bad credentials against a
 * fast-failing endpoint can make an agent retry immediately and forever
 * instead of giving up on a 4xx — witnessed with OMP against
 * `http://api.anthropic.com` (should have been `https://`): Anthropic's edge
 * rejects plaintext HTTP in ~30ms with a 400 that carries none of the
 * `x-should-retry` guidance its real API responses do, and OMP's retry policy
 * reads the absence of that header as "retry", producing thousands of
 * identical requests within seconds. Every one of them is a real POST, so
 * `shouldLogRequest` alone cannot tell it apart from real traffic — this can.
 *
 * A well-behaved agent, and a human retrying by hand, never produce the same
 * method+path+status more than a handful of times in a couple of seconds. A
 * retry loop with no backoff does. Once a signature crosses BURST_THRESHOLD
 * inside BURST_WINDOW_MS, further repeats come back `suppressed`. A fresh
 * signature, or a gap wider than the window, restarts the count from zero —
 * this only ever fires on requests that are actually piling up fast.
 */
export const BURST_THRESHOLD = 20;
export const BURST_WINDOW_MS = 2_000;

export interface BurstState {
  key: string;
  windowStart: number;
  count: number;
  warned: boolean;
}

export interface BurstResult {
  state: BurstState;
  suppressed: boolean;
  /** True on the one call that crosses the threshold — print the warning here, not every time. */
  justDetected: boolean;
}

export function burstKey(method: string, reqPath: string, statusCode: number): string {
  return `${method} ${reqPath} ${statusCode}`;
}

export function trackBurst(
  state: BurstState | null,
  key: string,
  now: number
): BurstResult {
  // Carried: the same signature still inside its window, so the count keeps
  // climbing. Anything else — first sighting, a new signature, or a gap
  // wider than the window — starts a fresh window at one.
  const carried =
    state !== null && state.key === key && now - state.windowStart <= BURST_WINDOW_MS;
  if (carried && state !== null) {
    const count = state.count + 1;
    const suppressed = count > BURST_THRESHOLD;
    return {
      state: {
        key,
        windowStart: state.windowStart,
        count,
        warned: state.warned || suppressed,
      },
      suppressed,
      justDetected: suppressed && !state.warned,
    };
  }
  return {
    state: { key, windowStart: now, count: 1, warned: false },
    suppressed: false,
    justDetected: false,
  };
}

/** Module-level on purpose: one guard for the whole process, the same as LOG_DIR. */
let burstState: BurstState | null = null;

function writeCapture(c: Capture): void {
  const label = c.target.agentLabel;

  if (!shouldLogRequest(c.method, c.path, c.target.renderer)) {
    console.log(
      dim(
        `[request-logger] ${label}  ${c.method} ${c.path} -> ${c.statusCode}  (housekeeping, not logged)`
      )
    );
    return;
  }

  const burst = trackBurst(
    burstState,
    burstKey(c.method, c.path, c.statusCode),
    Date.now()
  );
  burstState = burst.state;

  if (burst.justDetected) {
    console.warn("");
    console.warn(
      `[request-logger] ${label}  ${c.method} ${c.path} -> ${c.statusCode} has repeated ` +
        `${BURST_THRESHOLD}+ times in under ${BURST_WINDOW_MS / 1000}s.`
    );
    console.warn(
      "[request-logger] That is almost always your agent retrying a failing call with no " +
        "backoff, not real traffic — a wrong scheme (http:// where the provider needs " +
        "https://), a bad model ID, or bad credentials are the usual causes. Further " +
        "repeats of this exact call are forwarded but not written to disk until it stops."
    );
    console.warn("");
  }

  if (burst.suppressed) {
    // Still a whole capture every 500, so a burst that runs for a while stays visible
    // without going back to writing one file per repeat.
    if (burst.state.count % 500 === 0) {
      console.log(
        dim(
          `[request-logger] ${label}  ${c.method} ${c.path} -> ${c.statusCode}  (${burst.state.count} repeats suppressed so far)`
        )
      );
    }
    return;
  }

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // The .request/.response files keep the bytes that were actually
    // forwarded upstream and returned to the agent — rewritten, if
    // match-and-replace rules matched — so a capture replays what really
    // went over the wire. Only the .md is decoded.
    fs.writeFileSync(path.join(LOG_DIR, `${c.base}.request.txt`), c.requestBody);
    fs.writeFileSync(path.join(LOG_DIR, `${c.base}.response.txt`), c.responseRaw);
    fs.writeFileSync(
      path.join(LOG_DIR, `${c.base}.md`),
      renderMarkdown({
        agent: label,
        renderer: c.target.renderer,
        timestamp: c.timestamp,
        method: c.method,
        path: c.path,
        statusCode: c.statusCode,
        headers: c.headers,
        requestBody: c.requestBody,
        requestEncoding: c.requestEncoding,
        responseRaw: c.responseRaw,
      })
    );
    console.log(
      `${dim(`[request-logger] ${label}  ${c.method} ${c.path} ->`)} ${c.statusCode}  ${bold(
        `logs/${c.base}.md`
      )}`
    );
    if (c.requestReplacements > 0 || c.responseReplacements > 0) {
      console.log(
        dim(
          `           rewrote: request ${c.requestReplacements} match(es), response ${c.responseReplacements} match(es)`
        )
      );
    }
  } catch (err) {
    console.error(
      `[request-logger] failed to write logs: ${(err as Error).message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const dim = (text: string) => styleText("dim", text);
const bold = (text: string) => styleText("bold", text);

/** A field in the banner: a dim label, then the value it describes. */
function field(label: string, value: string): void {
  console.log(`  ${dim(label.padEnd(10))} ${value}`);
}

function printBanner(target: ProxyTarget, replacementRules: ReplacementRule[]): void {
  const rule = dim("-".repeat(72));
  const forwards =
    target.kind === "target" ? `https://${target.upstreamHost}` : target.upstreamBaseUrl;
  console.log("");
  console.log(rule);
  field("Agent", bold(`${target.agentLabel} (${target.providerLabel})`));
  field("Listening", `http://localhost:${PORT}`);
  field("Forwards", forwards);
  field("Logs", dim(LOG_DIR));
  field(
    "Rewrites",
    replacementRules.length > 0
      ? `${replacementRules.length} rule(s) from replacements.json`
      : dim("off — replacements.json empty, traffic passes through")
  );
  console.log(rule);

  for (const file of target.setup) {
    console.log("");
    console.log(`  Put this in ${bold(file.path)}:`);
    console.log("");
    for (const line of file.body.split("\n")) {
      console.log(dim(`      ${line}`));
    }
  }

  console.log("");
  console.log(
    target.setup.length > 0
      ? "  Then run your agent in another terminal with:"
      : "  Run your agent in another terminal with:"
  );
  console.log("");
  console.log(`      ${bold(target.command)}`);
  console.log("");

  for (const note of target.notes) printWrapped("Note", note);
  for (const warning of target.warnings) printWrapped("Warning", warning);

  console.log(
    dim("  Using a different agent now? Run: npm run request-logger -- --force")
  );
  // The tool waits on a port, so nothing tells the student it is finished.
  // Say how to stop it here, where they are already reading.
  // The styles are not nested. Both dim and bold close with the same code, so
  // a bold word inside a dim string ends the dim early.
  console.log(dim("  Press ") + bold("Ctrl+C") + dim(" to stop logging."));
  console.log(rule);
  console.log("");
}

/**
 * Ask the wizard, and keep the answer only if it is to be kept.
 *
 * `offerToRemember` is false when the student has already answered that
 * question: --force replaces a preference they chose to keep, so the new answer
 * simply takes its place. An agent that cannot be logged is never saved.
 */
async function ask(offerToRemember: boolean): Promise<AgentChoice> {
  const { choice, remember } = await askChoice({ offerToRemember });
  if (remember) saveChoice(STATE_FILE, choice);
  return choice;
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  // --force forgets the old answer before it asks. The new answer then replaces
  // it, and a choice that is never saved, such as an agent that cannot be
  // logged, leaves nothing stale behind.
  if (force) clearChoice(STATE_FILE);

  let choice = force ? null : loadChoice(STATE_FILE);
  if (!choice) choice = await ask(!force);

  let resolution = resolveChoice(choice, { port: PORT, platform: process.platform });

  // A saved choice the catalogue no longer understands is not the student's
  // fault. Ask again rather than making them find the flag.
  if (resolution.kind === "error") {
    console.log("");
    console.log(`[request-logger] ${resolution.message}`);
    // A saved file exists, so the student already asked to be remembered.
    choice = await ask(false);
    resolution = resolveChoice(choice, { port: PORT, platform: process.platform });
  }

  if (resolution.kind === "error") {
    console.error(`[request-logger] ${resolution.message}`);
    process.exit(1);
  }

  if (resolution.kind === "request") {
    const rule = dim("-".repeat(72));
    const what = resolution.agentLabel
      ? `${resolution.agentLabel} in that setup is`
      : "Your agent is";
    console.log("");
    console.log(rule);
    console.log(`  ${bold(`${what} not in this list yet.`)}`);
    console.log(rule);
    console.log("");
    for (const line of wrap(
      "This list holds the setups that have been tested. Yours can be added. " +
        "Each one needs three facts: the host your agent talks to, the wire " +
        "format it uses, and the command that points it at this tool.",
      68
    )) {
      console.log(`  ${line}`);
    }
    console.log("");
    console.log("  Ask for it here, and say which agent you use:");
    console.log("");
    console.log(`      ${bold(resolution.url)}`);
    console.log("");
    return;
  }

  if (resolution.kind === "refusal") {
    const rule = dim("-".repeat(72));
    console.log("");
    console.log(rule);
    console.log(`  ${bold(resolution.agentLabel)} cannot be logged by this tool.`);
    console.log(rule);
    console.log("");
    for (const line of wrap(resolution.reason, 68)) console.log(`  ${line}`);
    console.log("");
    console.log(
      dim("  This is worth knowing on its own: some tools send the system")
    );
    console.log(
      dim("  prompt from your machine, and some build it on their servers.")
    );
    console.log(dim("  Only the first kind can ever be inspected."));
    console.log("");
    console.log("  To follow the lesson, install one of the other agents, then run:");
    console.log("");
    console.log(`      ${bold("npm run request-logger")}`);
    console.log("");
    return;
  }

  const target = resolution;
  // Read once here only to describe the setup in the banner; handle() re-reads
  // the file on every request so edits apply without a restart.
  const replacementRules = loadReplacements(REPLACEMENTS_FILE);
  const server = http.createServer((req, res) => handle(req, res, target));
  server.on("upgrade", rejectUpgrade);
  server.listen(PORT, () => {
    printBanner(target, replacementRules);
  });
}

/** Print a labelled paragraph, indented and wrapped. */
function printWrapped(label: string, text: string): void {
  const lines = wrap(text, 66);
  console.log(`  ${bold(`${label}:`)} ${lines[0] ?? ""}`);
  for (const line of lines.slice(1)) console.log(`        ${line}`);
  console.log("");
}

/** Wrap prose to a width, so a long reason reads as a paragraph. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Only start the wizard and the server when this file is run directly (`npm
// run request-logger`, or `tsx request-logger/proxy.ts`), not when it is
// imported — the tests import pure functions like upstreamConnection from
// this module, and must not trigger the interactive wizard by doing so.
const isMain = path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`[request-logger] ${(err as Error).message}`);
    process.exit(1);
  });
}
