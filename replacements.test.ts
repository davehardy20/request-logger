import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyReplacements,
  contentTypeIsTextish,
  loadReplacements,
  type ReplacementRule,
  resetReplacementWarnings,
  rewriteBody,
  rulesForScope
} from "./replacements";

/** A rules file in a temp dir, so tests never touch the real one. */
function tempRulesFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replacements-"));
  const file = path.join(dir, "replacements.json");
  fs.writeFileSync(file, content);
  return file;
}

/** Silence the warn-once channel between tests. */
function captureWarn(): string[] {
  const messages: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => messages.push(String(message));
  afterEach(() => {
    console.warn = original;
    resetReplacementWarnings();
  });
  return messages;
}

describe("loadReplacements", () => {
  it("returns no rules when the file does not exist", () => {
    expect(loadReplacements("/nonexistent/replacements.json")).toEqual([]);
  });

  it("returns no rules for an empty array — the documented pass-through default", () => {
    const file = tempRulesFile("[]");
    expect(loadReplacements(file)).toEqual([]);
  });

  it("returns no rules for an empty or whitespace-only file", () => {
    expect(loadReplacements(tempRulesFile(""))).toEqual([]);
    expect(loadReplacements(tempRulesFile("   \n"))).toEqual([]);
  });

  it("reads simple match/replace rules", () => {
    const file = tempRulesFile(
      JSON.stringify([
        { match: "deny", replace: "allow" },
        { match: "block", replace: "pass" }
      ])
    );
    expect(loadReplacements(file)).toEqual([
      { match: "deny", replace: "allow" },
      { match: "block", replace: "pass" }
    ]);
  });

  it("keeps an optional request/response scope and defaults it to both", () => {
    const file = tempRulesFile(JSON.stringify([{ match: "x", replace: "y", scope: "response" }]));
    expect(loadReplacements(file)).toEqual([{ match: "x", replace: "y", scope: "response" }]);
  });

  it("warns once and passes traffic through when the JSON is invalid", () => {
    const warns = captureWarn();
    const file = tempRulesFile("{ not json");
    expect(loadReplacements(file)).toEqual([]);
    expect(loadReplacements(file)).toEqual([]);
    expect(warns.filter((m) => m.includes("not valid JSON"))).toHaveLength(1);
  });

  it("warns once and passes traffic through when the top level is not an array", () => {
    const warns = captureWarn();
    const file = tempRulesFile(JSON.stringify({ match: "deny", replace: "allow" }));
    expect(loadReplacements(file)).toEqual([]);
    expect(warns.some((m) => m.includes("JSON array"))).toBe(true);
  });

  it("skips malformed rules and keeps the well-formed ones", () => {
    const warns = captureWarn();
    const file = tempRulesFile(
      JSON.stringify([
        { match: "deny", replace: "allow" },
        { match: "", replace: "allow" },
        { replace: "allow" },
        { match: "block" },
        "not an object",
        { match: "a", replace: "b", scope: "sideways" },
        { match: "keep", replace: "me" }
      ])
    );
    expect(loadReplacements(file)).toEqual([
      { match: "deny", replace: "allow" },
      { match: "keep", replace: "me" }
    ]);
    expect(warns).toHaveLength(5);
  });
});

describe("rulesForScope", () => {
  const rules: ReplacementRule[] = [
    { match: "a", replace: "b" },
    { match: "c", replace: "d", scope: "request" },
    { match: "e", replace: "f", scope: "response" }
  ];

  it("keeps unscoped rules and the ones scoped to the asked direction", () => {
    expect(rulesForScope(rules, "request")).toEqual([
      { match: "a", replace: "b" },
      { match: "c", replace: "d", scope: "request" }
    ]);
    expect(rulesForScope(rules, "response")).toEqual([
      { match: "a", replace: "b" },
      { match: "e", replace: "f", scope: "response" }
    ]);
  });

  it("returns nothing when there are no rules at all", () => {
    expect(rulesForScope([], "request")).toEqual([]);
  });
});

describe("applyReplacements", () => {
  it("replaces every occurrence of the match", () => {
    const { text, count } = applyReplacements("deny this, deny that", [
      { match: "deny", replace: "allow" }
    ]);
    expect(text).toBe("allow this, allow that");
    expect(count).toBe(2);
  });

  it("applies rules in order, each fed the previous output", () => {
    const { text, count } = applyReplacements("deny", [
      { match: "deny", replace: "allow" },
      { match: "allow", replace: "pass" }
    ]);
    expect(text).toBe("pass");
    expect(count).toBe(2);
  });

  it("is a literal, case-sensitive substring match, not a regex", () => {
    const { text, count } = applyReplacements("Deny DENY deny d.eny", [
      { match: "d.ny", replace: "x" }
    ]);
    expect(text).toBe("Deny DENY deny d.eny");
    expect(count).toBe(0);
  });

  it("counts per match, and zero when nothing matched", () => {
    const { text, count } = applyReplacements("nothing here", [
      { match: "deny", replace: "allow" },
      { match: "block", replace: "pass" }
    ]);
    expect(text).toBe("nothing here");
    expect(count).toBe(0);
  });

  it("replaces with the empty string to delete the match", () => {
    const { text, count } = applyReplacements("I cannot assist with that.", [
      { match: "cannot ", replace: "" }
    ]);
    expect(text).toBe("I assist with that.");
    expect(count).toBe(1);
  });
});

describe("rewriteBody", () => {
  const rules: ReplacementRule[] = [{ match: "deny", replace: "allow" }];

  it("rewrites plain utf8 text and keeps the bytes honest about length", () => {
    const body = Buffer.from('{"content":"deny it"}');
    const { body: out, count } = rewriteBody(body, undefined, rules);
    expect(out.toString("utf8")).toBe('{"content":"allow it"}');
    expect(out.length).toBe(Buffer.byteLength('{"content":"allow it"}'));
    expect(count).toBe(1);
  });

  it("returns the original bytes untouched when no rule matches", () => {
    const body = Buffer.from('{"content":"fine"}');
    const { body: out, encoding, count } = rewriteBody(body, undefined, rules);
    expect(out).toBe(body); // the very same Buffer: not even copied
    expect(encoding).toBeUndefined();
    expect(count).toBe(0);
  });

  it("returns the original bytes untouched when there are no rules", () => {
    const body = Buffer.from("deny deny");
    const { body: out, count } = rewriteBody(body, undefined, []);
    expect(out).toBe(body);
    expect(count).toBe(0);
  });

  it("decompresses gzip, rewrites, and re-compresses as gzip", () => {
    const plain = Buffer.from('{"content":"deny it"}');
    const gzipped = zlib.gzipSync(plain);
    const { body: out, encoding, count } = rewriteBody(gzipped, "gzip", rules);
    expect(encoding).toBe("gzip");
    expect(zlib.gunzipSync(out).toString("utf8")).toBe('{"content":"allow it"}');
    expect(count).toBe(1);
  });

  it("decompresses brotli and deflate the same way", () => {
    for (const [kind, compress] of [
      ["br", zlib.brotliCompressSync],
      ["deflate", zlib.deflateSync]
    ] as const) {
      const { body: out, count } = rewriteBody(compress(Buffer.from("deny")), kind, rules);
      const decompressed = kind === "br" ? zlib.brotliDecompressSync(out) : zlib.inflateSync(out);
      expect(decompressed.toString("utf8")).toBe("allow");
      expect(count).toBe(1);
    }
  });

  it("never touches a body with an encoding it cannot decode", () => {
    const body = Buffer.from("not really zstd");
    const { body: out, encoding, count } = rewriteBody(body, "zstd", rules);
    expect(out).toBe(body);
    expect(encoding).toBe("zstd");
    expect(count).toBe(0);
  });

  it("never rewrites a textual body that is not clean UTF-8, even on a match", () => {
    // 0xE9 is é in latin-1 — invalid as UTF-8. A rewrite would have to
    // re-encode the whole body, swapping that byte for U+FFFD, so the rule
    // must not apply at all.
    const body = Buffer.from([0x22, 0x64, 0x65, 0x6e, 0x79, 0x22, 0xe9]);
    const { body: out, count } = rewriteBody(body, undefined, rules);
    expect(out).toBe(body);
    expect(count).toBe(0);
  });

  it("treats identity encoding as plain text", () => {
    const { body: out, count } = rewriteBody(Buffer.from("deny"), "identity", rules);
    expect(out.toString("utf8")).toBe("allow");
    expect(count).toBe(1);
  });
});

describe("contentTypeIsTextish", () => {
  it("accepts the content types model APIs actually use", () => {
    expect(contentTypeIsTextish("application/json")).toBe(true);
    expect(contentTypeIsTextish("application/json; charset=utf-8")).toBe(true);
    expect(contentTypeIsTextish("text/event-stream")).toBe(true);
    expect(contentTypeIsTextish("text/plain")).toBe(true);
    expect(contentTypeIsTextish("application/vnd.api+json")).toBe(true);
  });

  it("accepts a missing content type, so unstated does not mean untouched", () => {
    expect(contentTypeIsTextish(undefined)).toBe(true);
    expect(contentTypeIsTextish([])).toBe(true);
  });

  it("rejects binary content types, which are never rewritten", () => {
    expect(contentTypeIsTextish("image/png")).toBe(false);
    expect(contentTypeIsTextish("audio/wav")).toBe(false);
    expect(contentTypeIsTextish("application/octet-stream")).toBe(false);
  });
});
