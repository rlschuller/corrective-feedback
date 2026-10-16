import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const correction = { kind: "error", original: "adressing", corrected: "addressing", category: "spelling", explanation: "Use a double d." };
const response = (corrections = [correction]) => ({
  role: "assistant", content: [{ type: "text", text: JSON.stringify({ corrections }) }],
  stopReason: "stop", usage: { totalTokens: 123 },
});

async function setup(t: TestContext, options: Record<string, unknown> = {}, authorized = (_provider: string) => true) {
  const dir = await mkdtemp(join(tmpdir(), "feedback-extension-"));
  const path = join(dir, "config.json");
  const log = join(dir, "feedback.jsonl");
  await writeFile(path, JSON.stringify({ logPath: log, ...options }));
  const old = process.env.PI_CORRECTIVE_FEEDBACK_CONFIG;
  process.env.PI_CORRECTIVE_FEEDBACK_CONFIG = path;
  const handlers = new Map<string, Function>();
  const commands = new Map<string, Function>();
  const shortcuts = new Map<string, Function>();
  const entries: any[] = [];
  const calls: { model: any; context: any; options: any; resolve: (value: any) => void }[] = [];
  const widgets: (string[] | undefined)[] = [];
  const notices: string[] = [];
  let flag = false;
  let serial = 0;
  const ctx = {
    mode: "tui", hasUI: true,
    ui: {
      setWidget: (_key: string, value: string[] | undefined) => { widgets.push(value); },
      setStatus: () => assert.fail("Feedback must not add a footer status row"),
      setFooter: () => assert.fail("Feedback must preserve the existing footer"),
      notify: (text: string) => { notices.push(text); },
    },
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => "session-1",
      getSessionFile: () => "/session/one.jsonl",
    },
    modelRegistry: {
      find: (provider: string, id: string) => id === "missing" ? undefined : { provider, id },
      hasConfiguredAuth: (model: { provider: string }) => authorized(model.provider),
      streamSimple: (model: any, context: any, options: any) => {
        let resolve!: (value: any) => void;
        const pending = new Promise((done) => { resolve = done; });
        calls.push({ model, context, options, resolve });
        return { result: () => pending };
      },
    },
  };
  const api = {
    on: (event: string, handler: Function) => { handlers.set(event, handler); },
    registerFlag: () => {}, getFlag: () => flag,
    registerCommand: (name: string, command: { handler: Function }) => { commands.set(name, command.handler); },
    registerShortcut: (key: string, shortcut: { handler: Function }) => { shortcuts.set(key, shortcut.handler); },
    sendMessage: () => assert.fail("Feedback must not enter the model context"),
    sendUserMessage: () => assert.fail("Feedback must not trigger another main-agent turn"),
    appendEntry: () => assert.fail("No feedback text should be added to the main session"),
  };
  extension(api as unknown as ExtensionAPI);
  assert.deepEqual([...shortcuts.keys()], ["ctrl+n"]); // Do not intercept Ctrl+H/Backspace.
  const emit = async (name: string, event: any = {}) => handlers.get(name)?.(event, ctx as unknown as ExtensionContext);
  const command = async (args: string) => commands.get("feedback")!(args, ctx);
  const shortcut = async (key: string) => {
    assert.ok(shortcuts.has(key), `Shortcut not registered: ${key}`);
    await shortcuts.get(key)!(ctx);
  };
  async function user(text = "Anything needs adressing?", source = "interactive", start = true) {
    await emit("input", { text, source });
    if (start) await emit("agent_start");
    const message = { role: "user", content: text, timestamp: ++serial };
    await emit("message_end", { message });
    const entry = { type: "message", id: `entry-${serial}`, message };
    entries.push(entry); // Mirrors Pi: persistence follows extension message_end dispatch.
    await tick();
    return entry;
  }
  t.after(async () => {
    await emit("session_shutdown");
    for (const call of calls) call.resolve(response([]));
    await tick();
    if (old === undefined) delete process.env.PI_CORRECTIVE_FEEDBACK_CONFIG;
    else process.env.PI_CORRECTIVE_FEEDBACK_CONFIG = old;
    await rm(dir, { recursive: true, force: true });
  });
  await emit("session_start");
  return { ctx, calls, widgets, notices, log, emit, command, shortcut, user, setFlag: (value: boolean) => { flag = value; } };
}

test("review is asynchronous, isolated, linked to persisted ID, and displayed before settlement", async (t) => {
  const h = await setup(t);
  await h.user();
  assert.equal(h.calls.length, 1); // The main input handler returned despite an unfinished model call.
  const call = h.calls[0];
  assert.equal(call.model.id, "gpt-6.1-sol");
  assert.deepEqual(call.context.tools, []);
  assert.equal(call.context.messages.length, 1);
  assert.equal(JSON.parse(call.context.messages[0].content), "Anything needs adressing?");
  assert.doesNotMatch(call.context.systemPrompt, /coding assistant/);
  assert.equal(h.widgets.filter(Boolean).length, 0);
  call.resolve(response());
  await tick();
  assert.match(h.widgets.at(-1)!.join("\n"), /addressing/);
  const record = JSON.parse(await readFile(h.log, "utf8"));
  assert.equal(record.userMessageId, "entry-1");
  assert.equal(record.sessionPath, "/session/one.jsonl");
  assert.equal(record.reviewerMessages[0].role, "assistant");
  assert.equal(record.usage.totalTokens, 123);
  await h.emit("agent_settled");
  assert.match(h.widgets.at(-1)!.join("\n"), /addressing/);
});

test("pending and queued reviews add no UI rows before corrections arrive", async (t) => {
  const h = await setup(t);
  await h.user();
  await h.user("This sentence is correct.", "interactive", false);
  await h.emit("agent_settled");
  assert.equal(h.calls.length, 1);
  assert.equal(h.widgets.filter(Boolean).length, 0);
  assert.equal(h.notices.length, 0);

  h.calls[0].resolve(response([]));
  await tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.widgets.filter(Boolean).length, 0);
  assert.equal(h.notices.length, 0);

  h.calls[1].resolve(response([]));
  await tick();
  assert.equal(h.widgets.filter(Boolean).length, 0);
  assert.equal(h.notices.length, 0);
});

test("feedback is blue on automatic display and recall, but logs remain unstyled", async (t) => {
  const h = await setup(t);
  await h.user();
  h.calls[0].resolve(response());
  await tick();
  await h.emit("agent_settled");
  const automatic = h.widgets.at(-1)!;
  assert.equal(automatic.length, 2);
  assert.doesNotMatch(automatic.join("\n"), /English feedback|message|entry-1/);
  assert.match(automatic[0], /Correction:/);
  assert.match(automatic[1], /Use a double d\./);
  for (const line of automatic) {
    assert.ok(line.startsWith("\u001b[94m"));
    assert.ok(line.endsWith("\u001b[39m"));
  }
  await h.command("clear");
  assert.equal(h.widgets.at(-1), undefined);
  await h.command("last");
  assert.deepEqual(h.widgets.at(-1), automatic);
  const record = JSON.parse(await readFile(h.log, "utf8"));
  assert.deepEqual(record.corrections, [correction]);
  assert.equal(record.reviewerMessages[0].content, JSON.stringify({ corrections: [correction] }));
});

test("a review finishing after the main agent displays without triggering another turn", async (t) => {
  const h = await setup(t);
  await h.user();
  await h.emit("agent_settled");
  h.calls[0].resolve(response());
  await tick();
  assert.match(h.widgets.at(-1)!.join("\n"), /addressing/);
});

test("Ctrl+N toggles feedback without deleting logs, and settlement does not restore it", async (t) => {
  const h = await setup(t);
  await h.user();
  h.calls[0].resolve(response());
  await tick();
  const shown = h.widgets.at(-1);
  assert.ok(shown);
  const log = await readFile(h.log, "utf8");
  await h.shortcut("ctrl+n");
  assert.equal(h.widgets.at(-1), undefined);
  await h.emit("agent_settled");
  assert.equal(h.widgets.at(-1), undefined);
  assert.equal(await readFile(h.log, "utf8"), log);
  await h.shortcut("ctrl+n");
  assert.deepEqual(h.widgets.at(-1), shown);
  await h.shortcut("ctrl+n");
  assert.equal(h.widgets.at(-1), undefined);
  await h.command("last");
  assert.deepEqual(h.widgets.at(-1), shown);
  await h.shortcut("ctrl+n");
  assert.equal(h.widgets.at(-1), undefined);
  await h.shortcut("ctrl+n");
  assert.deepEqual(h.widgets.at(-1), shown);
  await h.command("clear");
  await h.shortcut("ctrl+n");
  assert.deepEqual(h.widgets.at(-1), shown);
});

test("Ctrl+N is harmless without feedback and resets visibility on a new run", async (t) => {
  const h = await setup(t);
  await h.shortcut("ctrl+n");
  assert.equal(h.widgets.at(-1), undefined);
  assert.equal(h.notices.length, 0);
  await h.user();
  h.calls[0].resolve(response());
  await tick();
  const shown = h.widgets.at(-1);
  assert.ok(shown);
  await h.emit("agent_start");
  assert.equal(h.widgets.at(-1), undefined);
  await h.shortcut("ctrl+n");
  assert.deepEqual(h.widgets.at(-1), shown);
  await h.emit("session_tree");
  await h.shortcut("ctrl+n");
  assert.equal(h.widgets.at(-1), undefined);
});

test("dismissal does not cancel pending work; a new correction appears immediately", async (t) => {
  const h = await setup(t);
  await h.user();
  await h.user("This also needs adressing.", "interactive", false);
  h.calls[0].resolve(response());
  await tick();
  await h.shortcut("ctrl+n");
  assert.equal(h.widgets.at(-1), undefined);
  assert.equal(h.calls[1].options.signal.aborted, false);
  h.calls[1].resolve(response());
  await tick();
  assert.match(h.widgets.at(-1)![0], /addressing/);
  assert.equal(h.widgets.at(-1)!.length, 2);
  const rows = (await readFile(h.log, "utf8")).trim().split("\n");
  assert.equal(rows.length, 2);
});

test("a clean queued review does not restore dismissed feedback", async (t) => {
  const h = await setup(t);
  await h.user();
  await h.user("This sentence is correct.", "interactive", false);
  h.calls[0].resolve(response());
  await tick();
  await h.command("clear");
  h.calls[1].resolve(response([]));
  await tick();
  await h.emit("agent_settled");
  assert.equal(h.widgets.at(-1), undefined);
  await h.command("last");
  assert.match(h.widgets.at(-1)![0], /addressing/);
});

test("empty corrections stay silent but log source, reviewer response, tokens, and costs", async (t) => {
  const h = await setup(t);
  await h.user("This sentence is correct.");
  const usage = {
    input: 100, output: 23, cacheRead: 0, cacheWrite: 0, totalTokens: 123,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  };
  h.calls[0].resolve({ ...response([]), usage });
  await tick();
  await h.emit("agent_settled");
  assert.equal(h.widgets.filter(Boolean).length, 0);
  assert.equal(h.notices.length, 0);
  const record = JSON.parse(await readFile(h.log, "utf8"));
  assert.deepEqual(record.corrections, []);
  assert.deepEqual(record.usage, usage);
  assert.equal(record.userMessageId, "entry-1");
  assert.equal(record.sessionPath, "/session/one.jsonl");
  assert.equal(record.reviewerMessages[0].content, JSON.stringify({ corrections: [] }));
  await h.command("last");
  assert.match(h.notices.at(-1)!, /No corrections/);
});

test("clean reviews do not replace prior feedback", async (t) => {
  const h = await setup(t);
  await h.user();
  await h.user("This sentence is correct.", "interactive", false);
  h.calls[0].resolve(response());
  await tick();
  h.calls[1].resolve(response([]));
  await tick();
  await h.emit("agent_settled");
  assert.match(h.widgets.at(-1)![0], /addressing/);
  assert.equal(h.widgets.at(-1)!.length, 2);
  await h.command("clear");
  await h.command("last");
  assert.match(h.widgets.at(-1)![0], /addressing/);
  const rows = (await readFile(h.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.userMessageId), ["entry-1", "entry-2"]);
  assert.deepEqual(rows.map((row) => row.corrections.length), [1, 0]);
});

test("off cancels in-flight work and ignores late results", async (t) => {
  const h = await setup(t);
  await h.user();
  await h.command("off");
  assert.equal(h.calls[0].options.signal.aborted, true);
  h.calls[0].resolve(response());
  await tick();
  await h.emit("agent_settled");
  await assert.rejects(readFile(h.log), { code: "ENOENT" });
  assert.equal(h.widgets.filter(Boolean).length, 0);
  await h.user();
  assert.equal(h.calls.length, 1);
});

test("session shutdown and tree navigation invalidate old results", async (t) => {
  const h = await setup(t);
  await h.user();
  await h.emit("session_tree");
  h.calls[0].resolve(response());
  await tick();
  await h.user();
  assert.equal(h.calls.length, 2);
  await h.emit("session_shutdown");
  h.calls[1].resolve(response());
  await tick();
  await assert.rejects(readFile(h.log), { code: "ENOENT" });
});

test("multiple and steering messages are serialized and retain separate source IDs", async (t) => {
  const h = await setup(t);
  await h.user();
  await h.user("This also needs adressing.", "interactive", false);
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve(response());
  await tick();
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve(response([{ ...correction, explanation: "Second review explanation." }]));
  await tick();
  await h.emit("agent_settled");
  const rows = (await readFile(h.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.userMessageId), ["entry-1", "entry-2"]);
  assert.equal(h.widgets.at(-1)!.length, 2);
  assert.match(h.widgets.at(-1)![1], /Second review explanation/);
  assert.doesNotMatch(h.widgets.at(-1)!.join("\n"), /English feedback|message|earlier|entry-/);
});

test("skip headless, extension-injected, disabled, and trivial messages", async (t) => {
  const h = await setup(t);
  await h.user("Thanks!");
  await h.user("Anything needs adressing?", "extension");
  h.ctx.mode = "print";
  await h.user();
  h.ctx.mode = "tui";
  h.setFlag(true);
  await h.user();
  assert.equal(h.calls.length, 0);
});

test("bad output warns after settlement without logging fabricated corrections", async (t) => {
  const h = await setup(t);
  await h.user();
  h.calls[0].resolve(response([{ ...correction, original: "absent" }]));
  await tick();
  assert.equal(h.notices.length, 0);
  await h.emit("agent_settled");
  assert.match(h.notices[0], /absent/);
  await assert.rejects(readFile(h.log), { code: "ENOENT" });
});

test("model command selects Sol and rejects unknown models", async (t) => {
  const h = await setup(t, { model: "gpt-6-luna" });
  await h.command("model openai-codex/gpt-6.1-sol");
  await h.user();
  assert.equal(h.calls[0].model.id, "gpt-6.1-sol");
  await h.command("model openai-codex/missing");
  assert.match(h.notices.at(-1)!, /must exist/);
});

test("timeout releases the queue even when the provider ignores cancellation", async (t) => {
  const h = await setup(t, { timeoutMs: 1000 });
  await h.user();
  await h.user("It needs adressing.", "interactive", false);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve(response());
  await tick();
  h.calls[0].resolve(response()); // An abandoned response must never be logged later.
  await tick();
  const rows = (await readFile(h.log, "utf8")).trim().split("\n");
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0]).userMessageId, "entry-2");
  await h.emit("agent_settled");
  assert.match(h.notices[0], /timed out/);
});

test("review failure does not prevent subsequent queued reviews", async (t) => {
  const h = await setup(t);
  await h.user();
  await h.user("It needs adressing.", "interactive", false);
  h.calls[0].resolve({ ...response(), stopReason: "error" });
  await tick();
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve(response());
  await tick();
  await h.emit("agent_settled");
  assert.match(h.widgets.at(-1)!.join("\n"), /addressing/);
  assert.match(h.notices[0], /did not finish/);
});

test("missing reviewer login disables feedback once at startup instead of warning every turn", async (t) => {
  let loggedIn = false;
  const h = await setup(t, {}, () => loggedIn);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /disabled: No configured authentication for openai-codex; use \/login/);
  await h.user();
  await h.emit("agent_settled");
  await h.user("It needs adressing.");
  await h.emit("agent_settled");
  assert.equal(h.calls.length, 0);
  assert.equal(h.notices.length, 1);
  await h.command("on");
  assert.match(h.notices.at(-1)!, /stays off/);
  loggedIn = true;
  await h.command("on");
  await h.user();
  assert.equal(h.calls.length, 1);
});

test("model command rejects a model without configured authentication", async (t) => {
  const h = await setup(t, {}, (provider) => provider === "openai-codex");
  await h.command("model other/some-model");
  assert.match(h.notices.at(-1)!, /No configured authentication for other/);
  await h.user();
  assert.equal(h.calls[0].model.provider, "openai-codex");
});
