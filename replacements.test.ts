import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyReplacements,
  contentTypeIsSse,
  contentTypeIsTextish,
  headWithinByteBudget,
  loadReplacements,
  makeStreamRewriter,
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
    expect(contentTypeIsTextish("application/xml")).toBe(true);
    expect(contentTypeIsTextish("application/atom+xml")).toBe(true);
    expect(contentTypeIsTextish("application/rss+xml; charset=utf-8")).toBe(true);
    expect(contentTypeIsTextish("application/x-ndjson")).toBe(true);
    expect(contentTypeIsTextish("application/ndjson; charset=utf-8")).toBe(true);
    expect(contentTypeIsTextish("application/jsonl")).toBe(true);
    expect(contentTypeIsTextish("application/vnd.api+ndjson")).toBe(true);
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

describe("caps (RewriteLimits)", () => {
  it("abandons an expansionary rewrite whole when the output cap is exceeded", () => {
    const tiny = { decoded: 1024, input: 1024, output: 32, carry: 1024 };
    const result = applyReplacements(
      "aaaaaaaaaaaaaaaa",
      [{ match: "a", replace: "aaaaaaaaaa" }],
      tiny
    );
    expect(result.count).toBe(0);
    expect(result.text).toBe("aaaaaaaaaaaaaaaa");
  });

  it("does not skip a valid rewrite when surrogate pairs compose across rules", () => {
    // \uD83D + \uDE00 encode as ONE 4-byte character (\u{1F600}), not two
    // 3-byte ones; a byte estimate that cannot see the pairing would count
    // 6 bytes and bail a rewrite whose true output is 4 bytes.
    const caps = { decoded: 1024, input: 1024, output: 5, carry: 1024 };
    const result = applyReplacements(
      "XY",
      [
        { match: "X", replace: "\uD83D" },
        { match: "Y", replace: "\uDE00" }
      ],
      caps
    );
    expect(result.count).toBe(2);
    expect(result.text).toBe("\uD83D\uDE00");
  });

  it("still abandons the rewrite when the true surrogate output exceeds the cap", () => {
    const caps = { decoded: 1024, input: 1024, output: 3, carry: 1024 };
    const result = applyReplacements(
      "XY",
      [
        { match: "X", replace: "\uD83D" },
        { match: "Y", replace: "\uDE00" }
      ],
      caps
    );
    expect(result.count).toBe(0);
    expect(result.text).toBe("XY");
  });

  it("counts the output cap in encoded bytes, not string characters", () => {
    // 10 characters, 20 encoded UTF-8 bytes: a character-counted cap would
    // let it through; a byte-counted cap bails and returns the original.
    const tiny = { decoded: 1024, input: 1024, output: 10, carry: 1024 };
    const result = applyReplacements("aaaaaaaaaa", [{ match: "a", replace: "\u00e9" }], tiny);
    expect(result.count).toBe(0);
    expect(result.text).toBe("aaaaaaaaaa");
  });

  it("passes a body larger than the input cap through untouched", () => {
    const tiny = { decoded: 1024, input: 8, output: 1024, carry: 1024 };
    const body = Buffer.from("deny deny deny deny");
    const { body: out, count } = rewriteBody(
      body,
      undefined,
      [{ match: "deny", replace: "allow" }],
      tiny
    );
    expect(out).toBe(body);
    expect(count).toBe(0);
  });

  it("passes a compressed body that would decompress past the cap through compressed, untouched", () => {
    const tiny = { decoded: 256, input: 65536, output: 65536, carry: 1024 };
    // 4096 zero bytes gzip to a few dozen; the decoded size is what trips the cap.
    const bomb = zlib.gzipSync(Buffer.alloc(4096));
    const {
      body: out,
      encoding,
      count
    } = rewriteBody(bomb, "gzip", [{ match: "\0", replace: "x" }], tiny);
    expect(out).toBe(bomb);
    expect(encoding).toBe("gzip");
    expect(count).toBe(0);
  });
});

describe("contentType parsing", () => {
  it("never lets a parameter turn a binary media type into text", () => {
    expect(contentTypeIsTextish("application/octet-stream; filename=config.json")).toBe(false);
    expect(contentTypeIsTextish("image/png; name=text.png")).toBe(false);
  });

  it("keeps accepting the textual media types, parameters included", () => {
    expect(contentTypeIsTextish("application/json; charset=utf-8")).toBe(true);
    expect(contentTypeIsTextish("Text/Plain; charset=latin-1")).toBe(true);
    expect(contentTypeIsTextish("application/vnd.api+json")).toBe(true);
  });

  it("recognises SSE by media type only", () => {
    expect(contentTypeIsSse("text/event-stream")).toBe(true);
    expect(contentTypeIsSse("text/event-stream; charset=utf-8")).toBe(true);
    expect(contentTypeIsSse("application/json")).toBe(false);
    expect(contentTypeIsSse("text/event-streamx")).toBe(false);
  });
});

describe("makeStreamRewriter", () => {
  const rules: ReplacementRule[] = [{ match: "deny", replace: "allow" }];

  it("rewrites a match that straddles a chunk boundary", () => {
    const rewriter = makeStreamRewriter(rules);
    const first = rewriter.push(Buffer.from("data: de"));
    const second = rewriter.push(Buffer.from("ny it\n\n"));
    const tail = rewriter.flush();
    expect(Buffer.concat([first, second, tail]).toString("utf8")).toBe("data: allow it\n\n");
    expect(rewriter.count()).toBe(1);
  });

  it("returns unmatched regions byte-identical", () => {
    const rewriter = makeStreamRewriter(rules);
    const chunk = Buffer.from("event: message\n\ndata: fine\n\n");
    const out = rewriter.push(chunk);
    const tail = rewriter.flush();
    expect(Buffer.concat([out, tail]).equals(Buffer.concat([chunk, Buffer.alloc(0)]))).toBe(true);
    expect(rewriter.count()).toBe(0);
  });

  it("keeps a multi-byte UTF-8 character split across chunks intact", () => {
    const rewriter = makeStreamRewriter(rules);
    // "dény" with the two-byte é split across the boundary. é is not e, so
    // "deny" does not match — the test is that é survives the split intact.
    const whole = Buffer.from("dény", "utf8");
    const first = rewriter.push(whole.subarray(0, 2));
    const second = rewriter.push(whole.subarray(2));
    const tail = rewriter.flush();
    expect(Buffer.concat([first, second, tail]).toString("utf8")).toBe("dény");
    expect(rewriter.count()).toBe(0);
  });

  it("switches to verbatim pass-through when a chunk is not clean UTF-8", () => {
    const rewriter = makeStreamRewriter(rules);
    const bad = Buffer.from([0x64, 0x65, 0xe9]); // "de" + invalid latin-1 é
    const out1 = rewriter.push(bad);
    const good = rewriter.push(Buffer.from("deny after"));
    const tail = rewriter.flush();
    // The invalid chunk and everything after pass through untouched.
    expect(Buffer.concat([out1, good, tail]).toString("latin1")).toBe("deédeny after");
    expect(rewriter.count()).toBe(0);
  });
});

describe("makeStreamRewriter boundary correctness (Greptile round 2)", () => {
  it("rewrites a match that starts in an emitted region and completes in the next chunk", () => {
    // abcSECRETxyz split as abcSEC | RETxyz: the match starts inside the
    // region that would be emitted on the first push. It must not escape.
    const rewriter = makeStreamRewriter([{ match: "SECRET", replace: "[redacted]" }]);
    const out = [
      rewriter.push(Buffer.from("abcSEC")),
      rewriter.push(Buffer.from("RETxyz")),
      rewriter.flush()
    ];
    expect(Buffer.concat(out).toString("utf8")).toBe("abc[redacted]xyz");
    expect(rewriter.count()).toBe(1);
  });

  it("withholds an entire match that arrives one push at a time, rewriting at flush", () => {
    const rewriter = makeStreamRewriter([{ match: "deny", replace: "allow" }]);
    const out = [
      rewriter.push(Buffer.from("x d")),
      rewriter.push(Buffer.from("e")),
      rewriter.push(Buffer.from("n")),
      rewriter.push(Buffer.from("y x")),
      rewriter.flush()
    ];
    expect(Buffer.concat(out).toString("utf8")).toBe("x allow x");
    expect(rewriter.count()).toBe(1);
  });

  it("emits withheld bytes before later chunks when it switches to verbatim, preserving order", () => {
    const rewriter = makeStreamRewriter([{ match: "deny", replace: "allow" }]);
    // First chunk emits a rewritten region and withholds a tail.
    const first = rewriter.push(Buffer.from("XXdeny YYYY"));
    // Second chunk contains an invalid UTF-8 byte: the rewriter goes
    // verbatim mid-stream, but the withheld tail must still come out first.
    const second = rewriter.push(Buffer.concat([Buffer.from([0xe9]), Buffer.from("abc")]));
    const third = rewriter.push(Buffer.from("def"));
    const tail = rewriter.flush();
    const joined = Buffer.concat([first, second, third, tail]);
    expect(joined.toString("latin1")).toBe("XXallow YYYYéabcdef");
    expect(joined.indexOf("YYYY")).toBeLessThan(joined.indexOf("abcdef"));
  });
});

describe("makeStreamRewriter carry cap (Greptile round 3)", () => {
  it("keeps making progress on a pathological prefix run, and still rewrites a match that completes inside the carry window", () => {
    // Rule aab->x against a long run of "a": every suffix of the run is a
    // genuine match start, so an unbounded rewriter would hold the whole
    // run forever. With carry capped at 8 bytes, bytes must keep flowing
    // out — and a match that completes within 8 bytes of the frontier is
    // still rewritten, because it never left the carry.
    const tiny = { decoded: 1024, input: 1024, output: 1024, carry: 8 };
    const rewriter = makeStreamRewriter([{ match: "aab", replace: "x" }], tiny);
    const out1 = rewriter.push(Buffer.from("a".repeat(64)));
    expect(out1.length).toBeGreaterThan(0); // progress, not an unbounded hold
    const out2 = rewriter.push(Buffer.from("b")); // the match completes late
    const tail = rewriter.flush();
    // 64 a's + b: "aab" completes 1 byte past the frontier, inside the
    // carry, so it rewrites: 62 a's survive and "aab" became "x".
    const expected = `${"a".repeat(62)}x`;
    expect(Buffer.concat([out1, out2, tail]).toString("utf8")).toBe(expected);
  });

  it("lets a match spanning further than the carry cap go unrewritten, rather than withholding forever", () => {
    // A 13-byte match against carry=8: holding the whole run for it would
    // break the cap, so the run flows and the match escapes — the
    // documented trade: progress beats completeness at the cap.
    const tiny = { decoded: 1024, input: 1024, output: 1024, carry: 8 };
    const long = `${"a".repeat(12)}b`;
    const rewriter = makeStreamRewriter([{ match: long, replace: "HIT" }], tiny);
    const out = [
      rewriter.push(Buffer.from("a".repeat(64))),
      rewriter.push(Buffer.from("b")),
      rewriter.flush()
    ];
    expect(Buffer.concat(out).toString("utf8")).toBe(`${"a".repeat(64)}b`);
    expect(rewriter.count()).toBe(0);
  });

  it("still rewrites an ordinary match with a small carry cap", () => {
    const tiny = { decoded: 1024, input: 1024, output: 1024, carry: 8 };
    const rewriter = makeStreamRewriter([{ match: "deny", replace: "allow" }], tiny);
    const out = [
      rewriter.push(Buffer.from("keep this: ")),
      rewriter.push(Buffer.from("deny please")),
      rewriter.flush()
    ];
    expect(Buffer.concat(out).toString("utf8")).toBe("keep this: allow please");
  });
});

describe("headWithinByteBudget", () => {
  it("returns the whole text when it fits the byte budget", () => {
    expect(headWithinByteBudget("0123456789", 10).toString("utf8")).toBe("0123456789");
    expect(headWithinByteBudget("a\u00e9b", 10).toString("utf8")).toBe("a\u00e9b");
  });

  it("cuts ASCII text at the budget exactly", () => {
    expect(headWithinByteBudget("0123456789ABC", 10).toString("utf8")).toBe("0123456789");
  });

  it("never splits a multi-byte character at the budget", () => {
    // \u00e9 is 2 bytes: a budget of 3 keeps "a\u00e9" exactly; a budget of
    // 2 would split the \u00e9, so it lands on the character boundary.
    expect(headWithinByteBudget("a\u00e9", 3).toString("utf8")).toBe("a\u00e9");
    expect(headWithinByteBudget("a\u00e9", 2).toString("utf8")).toBe("a");
  });

  it("counts the budget in bytes, not characters, for multibyte-heavy text", () => {
    // 8 \u00e9 characters = 16 bytes; budget 11 cuts mid-character and must
    // step back to 10 bytes (5 characters), not return 11 characters.
    const out = headWithinByteBudget("\u00e9".repeat(8), 11);
    expect(out.length).toBe(10);
    expect(out.toString("utf8")).toBe("\u00e9".repeat(5));
  });

  it("returns an empty buffer for a zero budget", () => {
    expect(headWithinByteBudget("anything", 0).length).toBe(0);
  });
});

describe("stream rewriter invalid UTF-8", () => {
  it("delivers a stream of invalid UTF-8 bytes instead of withholding it whole", () => {
    // Before the clamp: the UTF-8 step-back walked past the carry floor on
    // continuation bytes, withholding the entire stream (here: 64 bytes,
    // deliverable: zero). With the clamp, the ready region stops at the
    // floor, ends mid-character, and the rewriter switches to verbatim.
    const tiny = { decoded: 1024, input: 1024, output: 2048, carry: 8 };
    const rewriter = makeStreamRewriter([{ match: "deny", replace: "allow" }], tiny);
    const first = rewriter.push(Buffer.alloc(64, 0x80));
    expect(first.length).toBe(56); // 64 minus the 8-byte carry window
    // Verbatim from here: the withheld tail plus the chunk, unrewritten.
    const second = rewriter.push(Buffer.from("deny"));
    expect(Buffer.concat([first, second])).toEqual(
      Buffer.concat([Buffer.alloc(64, 0x80), Buffer.from("deny")])
    );
  });
});
