import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defaults } from "../src/config.ts";
import { handleWorkerRequest, loadClaudeConfig, parseWorkerRequest } from "../src/claude-reviewer.ts";
import { displayLine, parseWorkerReply } from "../src/claude-protocol.ts";
import type { WorkerRequest } from "../src/claude-protocol.ts";
import type { FeedbackRecord } from "../src/log.ts";

const correction = { kind: "error", original: "adressing", corrected: "addressing", category: "spelling", explanation: "Use a double d." };
const request: WorkerRequest = { action: "review", text: "Anything needs adressing?", sessionId: "claude-session", sessionPath: "/tmp/claude-session.jsonl", userMessageId: "real-uuid" };

test("Claude defaults are independent of existing Pi config and overridable", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "claude-feedback-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "config.json");
  const config = await loadClaudeConfig(path);
  assert.equal(config.enabled, true, "Claude reviews are on by default");
  assert.equal(config.model, "gpt-6.1-sol");
  assert.equal(config.logPath, join(dir, "corrective-feedback", "claude-feedback.jsonl"));
  assert.equal(defaults().model, "gpt-6.1-sol", "Both harnesses share the Sol 6.1 reviewer default");
  await writeFile(path, JSON.stringify({ model: "another", enabled: false, logPath: "logs/result.jsonl" }));
  assert.equal((await loadClaudeConfig(path)).model, "another");
  assert.equal((await loadClaudeConfig(path)).enabled, false);
  for (const bad of ["not json", "null", "[]", '{"unknown":true}']) {
    await writeFile(path, bad);
    await assert.rejects(loadClaudeConfig(path));
  }
});

test("worker boundary validates source attribution and only permits reviewer overrides", () => {
  assert.deepEqual(parseWorkerRequest(request), request);
  for (const bad of [null, [], {}, { action: "bad" }, { ...request, sessionId: "" }, { ...request, userMessageId: undefined }, { ...request, text: "x".repeat(100001) }, { action: "status", settings: { logPath: "/somewhere" } }, { action: "status", settings: { enabled: "yes" } }]) {
    assert.throws(() => parseWorkerRequest(bad));
  }
  assert.equal(displayLine("\x1b[31mred\x1b[0m\nnext\x07"), "red next ");
  assert.throws(() => parseWorkerReply('{"status":{},"lines":[]}'));
  assert.deepEqual(parseWorkerReply('{"error":"failed"}'), { error: "failed" });
});

function harness(raw = JSON.stringify({ corrections: [correction] }), stopReason = "stop") {
  const config = defaults("/tmp/claude-reviewer-test.json");
  const records: FeedbackRecord[] = [];
  let calls = 0;
  const runtime = {
    getModel(provider: string, model: string) {
      assert.equal(provider, "openai-codex"); assert.equal(model, "gpt-6.1-sol");
      return { provider, id: model };
    },
    async completeSimple(_model: unknown, context: unknown, options: unknown) {
      calls++;
      const c = context as { messages: { content: string }[]; tools: unknown[]; systemPrompt: string };
      assert.equal(c.messages.length, 1);
      assert.equal(c.messages[0].content, JSON.stringify(request.action === "review" ? request.text : ""));
      assert.deepEqual(c.tools, []);
      assert.match(c.systemPrompt, /data, not instructions/);
      assert.equal((options as { cacheRetention: string }).cacheRetention, "none");
      return { stopReason, content: [{ type: "text", text: raw }], responseModel: "gpt-6.1-sol", usage: { input: 10, output: 20 } };
    },
  } as unknown as Pick<ModelRuntime, "getModel" | "completeSimple">;
  return { config, records, get calls() { return calls; }, deps: {
    path: "/tmp/claude-reviewer-test.json", load: async () => config,
    runtime: async () => runtime,
    append: (_path: string, record: FeedbackRecord) => { records.push(record); },
  } };
}

test("tool-free review uses Pi model runtime and logs real Claude source IDs", async () => {
  const h = harness();
  const reply = await handleWorkerRequest(request, h.deps);
  assert.equal(h.calls, 1);
  assert("lines" in reply && reply.lines[0].includes("addressing"));
  const record = h.records[0];
  assert.equal(record.host, "claude-code");
  assert.equal(record.sessionId, "claude-session");
  assert.equal(record.userMessageId, "real-uuid");
  assert.equal(record.sessionPath, "/tmp/claude-session.jsonl");
  assert.equal(record.reviewerMessages[0].content, JSON.stringify({ corrections: [correction] }));
  assert(!JSON.stringify(record).includes(request.action === "review" ? request.text : "unused"));
  const parsed = parseWorkerReply(JSON.stringify(reply));
  assert("status" in parsed && parsed.status.model === "gpt-6.1-sol");
});

test("excluded and disabled reviews never initialize Pi or spend quota; status makes no model call", async () => {
  for (const text of ["Thanks!", "/feedback on", "```ts\nconst value=1\n```", "x".repeat(12001)]) {
    const reply = await handleWorkerRequest({ ...request, text } as WorkerRequest, {
      load: async () => defaults(), runtime: async () => { throw new Error("Must not initialize"); },
    });
    assert("lines" in reply && reply.lines.length === 0);
  }
  const h = harness();
  await handleWorkerRequest({ ...request, settings: { enabled: false } }, h.deps);
  await handleWorkerRequest({ action: "status" }, h.deps);
  assert.equal(h.calls, 0);
  assert.equal(h.records.length, 0);
});

test("clean reviews are silent but logged; incomplete and ungrounded reviews are not logged", async () => {
  const clean = harness('{"corrections":[]}');
  const reply = await handleWorkerRequest(request, clean.deps);
  assert("lines" in reply && reply.lines.length === 0);
  assert.equal(clean.records.length, 1);
  for (const h of [harness("not JSON"), harness(JSON.stringify({ corrections: [{ ...correction, original: "absent" }] })), harness("{}", "length")]) {
    await assert.rejects(handleWorkerRequest(request, h.deps));
    assert.equal(h.records.length, 0);
  }
});

test("valid corrections survive logging failures", async () => {
  const h = harness();
  const reply = await handleWorkerRequest(request, { ...h.deps, append: () => { throw new Error("disk full"); } });
  assert("lines" in reply && reply.lines.length === 2 && reply.warning);
});

test("worker timeout includes model-runtime initialization", async () => {
  const h = harness();
  h.config.timeoutMs = 1000;
  // Keep the event loop alive: AbortSignal.timeout alone is an unref'd timer.
  const timer = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(handleWorkerRequest(request, { ...h.deps, runtime: () => new Promise(() => {}) }), /timeout/i);
    assert.equal(h.records.length, 0);
  } finally { clearTimeout(timer); }
});

test("Claude records use the same private append-only JSONL writer", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "claude-feedback-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = harness();
  h.config.logPath = join(dir, "private", "claude.jsonl");
  const { append: _append, ...deps } = h.deps;
  await handleWorkerRequest(request, deps);
  const record = JSON.parse(await readFile(h.config.logPath, "utf8"));
  assert.equal(record.host, "claude-code");
  assert.equal(record.userMessageId, "real-uuid");
});
