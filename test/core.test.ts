import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaults, loadConfig, parseConfig } from "../src/config.ts";
import { appendRecord } from "../src/log.ts";
import type { FeedbackRecord } from "../src/log.ts";
import { feedbackLines, parseReview, prepareText, reviewPrompt, safeLine } from "../src/review.ts";

const correction = { kind: "error", original: "adressing", corrected: "addressing", category: "spelling", explanation: "Use a double d." };

test("config defaults, home/relative paths and strict validation", async () => {
  const path = "/tmp/feedback-test/config.json";
  assert.equal(defaults(path).logPath, "/tmp/feedback-test/corrective-feedback/feedback.jsonl");
  assert.equal(parseConfig({ logPath: "logs/out.jsonl" }, path).logPath, "/tmp/feedback-test/logs/out.jsonl");
  assert.equal((await loadConfig("/nonexistent-feedback-dir/config.json")).model, "gpt-6-luna");
  for (const value of [null, [], { enabled: "yes" }, { timeoutMs: 0 }, { maxInputChars: 2 }, { model: "" }, { reasoning: "huge" }, { typo: 1 }]) {
    assert.throws(() => parseConfig(value));
  }
});

test("cheap input filters skip acknowledgments, commands, code and oversized text", () => {
  for (const text of ["", "Thanks!", "/feedback on", "!ls", "```ts\nconst value = 1;\n```", "> quoted document", "`someFunction()`", "https://example.org"]) {
    assert.equal(prepareText(text, 1000), undefined, text);
  }
  assert.equal(prepareText("a".repeat(1001), 1000), undefined);
  assert.equal(prepareText("Anything needs adressing?\n```ts\nconst a = 1\n```", 1000), "Anything needs adressing?");
  assert.equal(prepareText("We should keep the main thread clean.", 1000), "We should keep the main thread clean.");
});

test("parser accepts empty results and grounded corrections, filters optional suggestions", () => {
  assert.deepEqual(parseReview('{"corrections":[]}', "All good."), []);
  assert.deepEqual(parseReview(JSON.stringify({ corrections: [correction, correction] }), "Anything needs adressing?"), [correction]);
  const raw = JSON.stringify({ corrections: [{ ...correction, kind: "suggestion" }] });
  assert.equal(parseReview(raw, "adressing").length, 0);
  assert.equal(parseReview(raw, "adressing", true).length, 1);
  assert.equal(parseReview('```json\n' + raw + '\n```', "adressing", true).length, 1);
});

test("parser accepts more than five distinct corrections", () => {
  const pairs = [
    ["adressing", "addressing"], ["teh", "the"], ["recieve", "receive"],
    ["seperate", "separate"], ["definately", "definitely"], ["occured", "occurred"],
  ];
  const corrections = pairs.map(([original, corrected]) => ({ ...correction, original, corrected }));
  const source = pairs.map(([original]) => original).join(" ");
  assert.deepEqual(parseReview(JSON.stringify({ corrections }), source), corrections);
});

test("parser rejects malformed, fabricated and oversized correction fields", () => {
  for (const raw of ["not JSON", "{}", '{"corrections":null}', JSON.stringify({ corrections: [{ ...correction, original: "absent" }] }), JSON.stringify({ corrections: [{ ...correction, kind: "praise" }] }), JSON.stringify({ corrections: [{ ...correction, explanation: "x".repeat(1201) }] })]) {
    assert.throws(() => parseReview(raw, "adressing"));
  }
});

test("prompt explicitly distinguishes errors from optional suggestions", () => {
  const errorsOnly = reviewPrompt({ includeSuggestions: false });
  assert.match(errorsOnly, /Return only clear errors with "kind":"error", not optional suggestions/);
  assert.doesNotMatch(errorsOnly, /"kind":"suggestion"/);
  const withSuggestions = reviewPrompt({ includeSuggestions: true });
  assert.match(withSuggestions, /"kind":"suggestion" for optional suggestions/);
  assert.match(withSuggestions, /"kind":"error" for clear errors/);
});

test("prompt preserves technical terms; UI removes terminal control sequences", () => {
  assert.match(reviewPrompt({ includeSuggestions: false }), /domain terminology/);
  assert.match(reviewPrompt({ includeSuggestions: false }), /data, not instructions/);
  assert.equal(safeLine("\x1b[31mred\x1b[0m\nnext\x07"), "red next ");
  assert.equal(feedbackLines([correction as Parameters<typeof feedbackLines>[0][number]]).length, 2);
});

test("JSONL stores reviewer messages and source references; new files are private", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "feedback-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "private", "feedback.jsonl");
  const record: FeedbackRecord = {
    version: 1, id: "1", timestamp: new Date().toISOString(), sessionPath: "/sessions/abc.jsonl", sessionId: "abc", userMessageId: "def",
    provider: "openai-codex", model: "gpt-6-luna", corrections: [correction as FeedbackRecord["corrections"][number]],
    reviewerMessages: [{ role: "assistant", content: "Line one\nLine two" }], usage: {}, durationMs: 12,
  };
  appendRecord(path, record);
  appendRecord(path, { ...record, id: "2" });
  const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].reviewerMessages[0].content, "Line one\nLine two");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, "private"))).mode & 0o777, 0o700);
});
