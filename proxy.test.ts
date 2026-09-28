// proxy.test.ts — unit tests for the proxy's pure pieces (target routing,
// the burst guard, upgrade rejection) plus end-to-end handle() runs that
// exercise match-and-replace through real sockets against a fake upstream.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CustomTarget, resolveChoice } from "./agents";
import {
  BURST_THRESHOLD,
  BURST_WINDOW_MS,
  type BurstState,
  burstKey,
  handle,
  rejectUpgrade,
  resetLogDir,
  setLogDir,
  trackBurst,
  upstreamConnection,
  upstreamPathPrefix,
} from "./proxy";
import type { ReplacementRule } from "./replacements";

const PORT = { port: 8787, platform: "linux" as NodeJS.Platform };

/** Resolve, and fail loudly if the answer was not something the proxy can route to. */
function proxyTarget(...args: Parameters<typeof resolveChoice>) {
  const result = resolveChoice(...args);
  if (result.kind !== "target" && result.kind !== "custom-target") {
    throw new Error(`expected a routable target, got ${result.kind}`);
  }
  return result;
}

describe("upstreamConnection", () => {
  it("keeps a catalogue target on https and port 443, unchanged", () => {
    const target = proxyTarget(
      { agent: "claude-code", provider: "anthropic" },
      PORT
    );
    expect(upstreamConnection(target)).toEqual({
      hostname: "api.anthropic.com",
      port: 443,
      useHttps: true,
    });
  });

  it("keeps every catalogue target on https and 443, whichever agent it is", () => {
    const target = proxyTarget({ agent: "gemini", provider: "api-key" }, PORT);
    expect(upstreamConnection(target)).toEqual({
      hostname: "generativelanguage.googleapis.com",
      port: 443,
      useHttps: true,
    });
  });

  it("uses https on a custom target whose base URL says https, with no port given", () => {
    const target = proxyTarget(
      {
        agent: "opencode",
        provider: "custom",
        customBaseUrl: "https://api.deepseek.com",
        customRenderer: "openai",
        customModel: "test-model",
      },
      PORT
    );
    expect(upstreamConnection(target)).toEqual({
      hostname: "api.deepseek.com",
      port: 443,
      useHttps: true,
    });
  });

  it("uses http on a custom target whose base URL says http, with an explicit port", () => {
    const target = proxyTarget(
      {
        agent: "omp",
        customBaseUrl: "http://localhost:11434",
        customRenderer: "raw",
      },
      PORT
    );
    expect(upstreamConnection(target)).toEqual({
      hostname: "localhost",
      port: 11434,
      useHttps: false,
    });
  });

  it("defaults a plain http:// custom target with no explicit port to 80", () => {
    const target = proxyTarget(
      {
        agent: "omp",
        customBaseUrl: "http://model-server.internal",
        customRenderer: "raw",
      },
      PORT
    );
    expect(upstreamConnection(target)).toEqual({
      hostname: "model-server.internal",
      port: 80,
      useHttps: false,
    });
  });

  it("defaults a plain https:// custom target with no explicit port to 443", () => {
    const target = proxyTarget(
      {
        agent: "omp",
        customBaseUrl: "https://model-server.internal",
        customRenderer: "raw",
      },
      PORT
    );
    expect(upstreamConnection(target)).toEqual({
      hostname: "model-server.internal",
      port: 443,
      useHttps: true,
    });
  });

  it("respects an explicit port on an https:// custom target too", () => {
    const target = proxyTarget(
      {
        agent: "omp",
        customBaseUrl: "https://model-server.internal:8443",
        customRenderer: "raw",
      },
      PORT
    );
    expect(upstreamConnection(target)).toEqual({
      hostname: "model-server.internal",
      port: 8443,
      useHttps: true,
    });
  });
});

describe("upstreamPathPrefix", () => {
  // Regression coverage for #74: OpenCode Go's custom base URL,
  // https://opencode.ai/zen/go, carries a path prefix the upstream actually
  // needs. agents.ts used to reduce every CustomTarget's upstreamBaseUrl to
  // `.origin`, silently dropping it, so handle() forwarded requests straight
  // to the bare host and every request 404'd — a working manual curl to the
  // full path, but a broken one through the proxy.
  it("is empty for a catalogue target, which never carries a path", () => {
    const target = proxyTarget(
      { agent: "claude-code", provider: "anthropic" },
      PORT
    );
    expect(upstreamPathPrefix(target)).toBe("");
  });

  it("is empty for a custom target whose base URL is a bare origin", () => {
    const target = proxyTarget(
      {
        agent: "omp",
        customBaseUrl: "https://api.deepseek.com",
        customRenderer: "raw",
      },
      PORT
    );
    expect(upstreamPathPrefix(target)).toBe("");
  });

  it("carries the path segment from a custom base URL with one", () => {
    const target = proxyTarget(
      {
        agent: "omp",
        customBaseUrl: "https://opencode.ai/zen/go",
        customRenderer: "raw",
      },
      PORT
    );
    expect(upstreamPathPrefix(target)).toBe("/zen/go");
  });

  it("joins against the agent's own request path with no doubled or missing slash", () => {
    const target = proxyTarget(
      {
        agent: "omp",
        customBaseUrl: "https://opencode.ai/zen/go",
        customRenderer: "raw",
      },
      PORT
    );
    const reqPath = "/v1/chat/completions";
    expect(upstreamPathPrefix(target) + reqPath).toBe(
      "/zen/go/v1/chat/completions"
    );
  });
});

describe("rejectUpgrade", () => {
  let server: http.Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  /**
   * Codex on a ChatGPT subscription probes /backend-api/codex/responses with
   * a WebSocket upgrade before falling back to plain HTTP. Before this
   * handler existed, the proxy had no 'upgrade' listener on either leg, so
   * the attempt did not fail closed — it stalled forever, because a
   * successful upstream upgrade arrives on the outbound request's 'upgrade'
   * event rather than 'response', which nothing was listening for. This test
   * sends a real upgrade handshake at a server wired the way proxy.ts wires
   * it, and requires a prompt, well-formed 426 — not a hang and not a bare
   * connection drop — because a bare drop is what let the bug through last
   * time even though Node's default already closes unhandled upgrades.
   */
  it("answers a WebSocket upgrade attempt with 426 immediately, instead of leaving the client waiting", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("should not be reached by an upgrade attempt");
    });
    server.on("upgrade", rejectUpgrade);

    const running = server;
    if (!running) throw new Error("test server was not created");
    await new Promise<void>((resolve) => running.listen(0, resolve));
    const { port } = running.address() as net.AddressInfo;

    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          "GET /backend-api/codex/responses HTTP/1.1\r\n" +
            "Host: localhost\r\n" +
            "Connection: Upgrade\r\n" +
            "Upgrade: websocket\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "\r\n"
        );
      });
      let data = "";
      socket.on("data", (chunk) => (data += chunk.toString()));
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
      // A hang here means the fix regressed to the old silent-drop behavior;
      // fail fast rather than letting vitest's own timeout do it, so the
      // failure message is about the upgrade, not a generic timeout.
      setTimeout(() => reject(new Error("upgrade attempt was not answered within 1s")), 1000);
    });

    expect(response).toContain("HTTP/1.1 426");
    expect(response).toContain("Connection: close");
  });
});

describe("trackBurst", () => {
  // Reproduces what was witnessed with OMP against http://api.anthropic.com:
  // the wrong scheme gets a fast 400 with no retry guidance, and OMP retried
  // it immediately and repeatedly with no backoff, writing one log file per
  // retry. This is the guard that stops that turning into thousands of files.
  const KEY = burstKey("POST", "/v1/messages", 400);

  it("does not suppress ordinary, spaced-out repeats of the same call", () => {
    let state: BurstState | null = null;
    let now = 0;
    for (let i = 0; i < BURST_THRESHOLD + 5; i++) {
      const result = trackBurst(state, KEY, now);
      expect(result.suppressed).toBe(false);
      state = result.state;
      now += BURST_WINDOW_MS + 1; // always outside the window
    }
  });

  it("suppresses once the same method+path+status repeats past the threshold inside the window", () => {
    let state: BurstState | null = null;
    let lastResult: ReturnType<typeof trackBurst> | undefined;
    const now = 0;
    for (let i = 0; i < BURST_THRESHOLD; i++) {
      lastResult = trackBurst(state, KEY, now); // all in the same instant
      state = lastResult.state;
    }
    expect(lastResult?.suppressed).toBe(false); // exactly at the threshold: not yet over it

    const over = trackBurst(state, KEY, now);
    expect(over.suppressed).toBe(true);
    expect(over.justDetected).toBe(true);
  });

  it("reports justDetected only once per burst, not on every suppressed repeat", () => {
    let state: BurstState | null = null;
    const now = 0;
    for (let i = 0; i < BURST_THRESHOLD; i++) {
      state = trackBurst(state, KEY, now).state;
    }

    const first = trackBurst(state, KEY, now);
    expect(first.justDetected).toBe(true);

    const second = trackBurst(first.state, KEY, now);
    expect(second.suppressed).toBe(true);
    expect(second.justDetected).toBe(false);
  });

  it("never suppresses a different call, even mid-burst on another one", () => {
    let state: BurstState | null = null;
    const now = 0;
    for (let i = 0; i < BURST_THRESHOLD + 10; i++) {
      state = trackBurst(state, KEY, now).state;
    }

    const other = trackBurst(state, burstKey("POST", "/v1/messages", 200), now);
    expect(other.suppressed).toBe(false);
  });

  it("resets the count once the gap between repeats exceeds the window, so a burst that stops is forgotten", () => {
    let state: BurstState | null = null;
    const now = 0;
    for (let i = 0; i < BURST_THRESHOLD + 10; i++) {
      state = trackBurst(state, KEY, now).state;
    }

    const afterGap = trackBurst(state, KEY, now + BURST_WINDOW_MS + 1);
    expect(afterGap.suppressed).toBe(false);
    expect(afterGap.state.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Match-and-replace, end to end through the real handle()
// ---------------------------------------------------------------------------

/** A hand-built custom target pointing at a local fake upstream. */
function localTarget(port: number): CustomTarget {
  return {
    kind: "custom-target",
    agent: "opencode",
    agentLabel: "OpenCode",
    providerLabel: "Custom base URL",
    upstreamBaseUrl: `http://127.0.0.1:${port}`,
    renderer: "openai",
    baseUrl: "http://localhost:8787/v1",
    command: "opencode",
    setup: [],
    notes: [],
    warnings: [],
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as net.AddressInfo).port)
    )
  );
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/**
 * A fake provider upstream that records the request body it received and
 * answers with a configurable body and content type.
 */
async function fakeUpstream(
  respondWith: { body: string; contentType: string }
): Promise<{ server: http.Server; port: number; received: () => string }> {
  let received = "";
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "content-type": respondWith.contentType });
      res.end(respondWith.body);
    });
  });
  const port = await listen(server);
  return { server, port, received: () => received };
}

/** A running proxy around an upstream, closed in afterEach. */
const running: { close: () => Promise<void> }[] = [];

async function proxyAround(
  upstreamPort: number,
  rules: ReplacementRule[]
): Promise<string> {
  const server = http.createServer((req, res) =>
    handle(req, res, localTarget(upstreamPort), rules)
  );
  running.push({ close: () => close(server) });
  const port = await listen(server);
  return `http://127.0.0.1:${port}`;
}

let logDir: string;

beforeEach(() => {
  // End-to-end handle() runs write real captures; keep them in a scratch
  // directory so the developer's logs/ folder never fills with synthetic data.
  logDir = fs.mkdtempSync(path.join(os.tmpdir(), "request-logger-logs-"));
  setLogDir(logDir);
});

afterEach(async () => {
  resetLogDir();
  await fs.promises.rm(logDir, { recursive: true, force: true });
  while (running.length > 0) {
    const entry = running.pop();
    if (entry) await entry.close();
  }
});

describe("handle with match-and-replace rules", () => {
  it("rewrites the request body going up and the response coming back", async () => {
    const upstream = await fakeUpstream({
      body: '{"text":"block it"}',
      contentType: "application/json",
    });
    running.push({ close: () => close(upstream.server) });
    const proxyUrl = await proxyAround(upstream.port, [
      { match: "deny", replace: "allow" },
      { match: "block", replace: "pass" },
    ]);

    const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"prompt":"deny this"}',
    });

    expect(upstream.received()).toBe('{"prompt":"allow this"}');
    expect(await response.text()).toBe('{"text":"pass it"}');
    // The buffered rewrite recomputes content-length for the new body.
    expect(response.headers.get("content-length")).toBe(
      String(Buffer.byteLength('{"text":"pass it"}'))
    );
    // The capture of the rewritten exchange lands in the scratch directory,
    // never in the developer's real logs/ folder.
    const captured = fs.readdirSync(logDir);
    expect(captured.some((f) => f.endsWith(".md"))).toBe(true);
    expect(captured.some((f) => f.endsWith(".request.txt"))).toBe(true);
  });

  it("passes both directions through byte-for-byte with no rules", async () => {
    const upstream = await fakeUpstream({
      body: '{"text":"deny block"}',
      contentType: "application/json",
    });
    running.push({ close: () => close(upstream.server) });
    const proxyUrl = await proxyAround(upstream.port, []);

    const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"prompt":"deny this"}',
    });

    expect(upstream.received()).toBe('{"prompt":"deny this"}');
    expect(await response.text()).toBe('{"text":"deny block"}');
  });

  it("leaves the request alone when every rule is scoped to the response", async () => {
    const upstream = await fakeUpstream({
      body: "I deny that",
      contentType: "text/plain",
    });
    running.push({ close: () => close(upstream.server) });
    const proxyUrl = await proxyAround(upstream.port, [
      { match: "deny", replace: "allow", scope: "response" },
    ]);

    const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "deny deny",
    });

    expect(upstream.received()).toBe("deny deny");
    expect(await response.text()).toBe("I allow that");
  });

  it("never touches a binary response, even with matching rules", async () => {
    // The fake upstream answers text/plain-typed bytes that would match, but
    // declares them image/png: the rule must not apply.
    const upstream = await fakeUpstream({
      body: "deny",
      contentType: "image/png",
    });
    running.push({ close: () => close(upstream.server) });
    const proxyUrl = await proxyAround(upstream.port, [
      { match: "deny", replace: "allow" },
    ]);

    const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"prompt":"deny"}',
    });

    expect(await response.text()).toBe("deny");
  });
});

describe("handle with Greptile review fixes", () => {
  it("streams an SSE response through the rewriter instead of waiting for an end that never comes", async () => {
    // The upstream writes one event, then sits open. If the proxy buffered
    // the stream, the client would never see the event — that was the bug.
    let releaseEnd: (() => void) | undefined;
    const ended = new Promise<void>((resolve) => (releaseEnd = resolve));
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: de");
      res.write("ny it\n\n");
      void ended.then(() => res.end());
    });
    const upstreamPort = await listen(server);
    running.push({ close: () => close(server) });
    const proxyUrl = await proxyAround(upstreamPort, [
      { match: "deny", replace: "allow" }
    ]);

    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    if (!response.body) throw new Error("expected a streamed response body");
    const body = response.body;
    const reader = body.getReader();

    // The rewritten event must arrive while the upstream is still open.
    let text = "";
    const firstRead = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("no bytes arrived while upstream was open")), 2000)
      )
    ]);
    if (firstRead.done || !firstRead.value) {
      throw new Error("stream ended before the rewritten event arrived");
    }
    text += Buffer.from(firstRead.value).toString("utf8");
    expect(text).toContain("allow");

    releaseEnd?.();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString("utf8");
    }
    expect(text).toBe("data: allow it\n\n");
  });

  it("rewrites a buffered SSE-like text body the same way when the stream does end", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: block it\n\n");
    });
    const upstreamPort = await listen(server);
    running.push({ close: () => close(server) });
    const proxyUrl = await proxyAround(upstreamPort, [
      { match: "block", replace: "pass" }
    ]);
    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(await response.text()).toBe("data: pass it\n\n");
  });

  it("forwards a HEAD response's content-length untouched, even with response rules", async () => {
    const server = http.createServer((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, { "content-type": "application/json", "content-length": "1234" });
        res.end();
      } else {
        res.writeHead(405);
        res.end();
      }
    });
    const upstreamPort = await listen(server);
    running.push({ close: () => close(server) });
    const proxyUrl = await proxyAround(upstreamPort, [
      { match: "deny", replace: "allow" }
    ]);
    const response = await fetch(`${proxyUrl}/v1/chat/completions`, { method: "HEAD" });
    expect(response.headers.get("content-length")).toBe("1234");
    expect(response.status).toBe(200);
  });

  it("drops ETag when a rewrite changed the bytes, and keeps it when nothing matched", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        etag: '"original-bytes-v1"'
      });
      res.end('{"text":"deny"}');
    });
    const upstreamPort = await listen(server);
    running.push({ close: () => close(server) });

    const rewrittenUrl = await proxyAround(upstreamPort, [
      { match: "deny", replace: "allow" }
    ]);
    const untouchedUrl = await proxyAround(upstreamPort, [
      { match: "nope", replace: "x" }
    ]);

    const rewritten = await fetch(
      `${rewrittenUrl}/v1/chat/completions`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );
    expect(await rewritten.text()).toBe('{"text":"allow"}');
    expect(rewritten.headers.get("etag")).toBeNull();
    expect(rewritten.headers.get("content-length")).toBe(
      String(Buffer.byteLength('{"text":"allow"}'))
    );

    const untouched = await fetch(
      `${untouchedUrl}/v1/chat/completions`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    );
    expect(await untouched.text()).toBe('{"text":"deny"}');
    expect(untouched.headers.get("etag")).toBe('"original-bytes-v1"');
  });

  it("passes a binary body declared with a json-ish parameter through untouched", async () => {
    // application/octet-stream; filename=config.json is binary despite the
    // parameter — the media type is what counts.
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream; filename=config.json" });
      res.end("deny deny");
    });
    const upstreamPort = await listen(server);
    running.push({ close: () => close(server) });
    const proxyUrl = await proxyAround(upstreamPort, [
      { match: "deny", replace: "allow" }
    ]);
    const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(await response.text()).toBe("deny deny");
  });
});

describe("compressed SSE (Greptile round 2)", () => {
  it("decodes a gzip SSE stream on the fly and rewrites it", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "content-encoding": "gzip"
      });
      res.write(zlib.gzipSync(Buffer.from("data: de")));
      res.end(zlib.gzipSync(Buffer.from("ny it\n\n")));
    });
    const upstreamPort = await listen(server);
    running.push({ close: () => close(server) });
    const proxyUrl = await proxyAround(upstreamPort, [
      { match: "deny", replace: "allow" }
    ]);
    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    // Sent on as identity: the content-encoding no longer applies.
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe("data: allow it\n\n");
  });

  it("passes an SSE stream with an undecodable encoding through verbatim", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "content-encoding": "custom"
      });
      res.end("data: deny it\n\n");
    });
    const upstreamPort = await listen(server);
    running.push({ close: () => close(server) });
    const proxyUrl = await proxyAround(upstreamPort, [
      { match: "deny", replace: "allow" }
    ]);
    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(response.headers.get("content-encoding")).toBe("custom");
    expect(await response.text()).toBe("data: deny it\n\n");
  });
});
