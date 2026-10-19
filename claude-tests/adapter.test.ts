import { expect, mock, test } from "claude-code/testing";
import type { TestBody } from "claude-code/testing";
import type { WorkerRequest } from "../src/claude-protocol.ts";

const STATUS = { enabled: true, provider: "openai-codex", model: "gpt-6.1-sol", maxInputChars: 12000, timeoutMs: 1000, configPath: "/tmp/config.json", logPath: "/tmp/claude-feedback.jsonl" };
const CORRECTIONS = ['Correction: “adressing” → “addressing”', "  Use a double d."];
const BAND = {
  plugin: "corrective-feedback", surface: "terminal", component: "AbovePrompt", requestId: "band",
  viewport: { columns: 100, rows: 30, isFullscreen: false },
  props: { hasSurvey: false, isWorking: true, maxRows: 8, bodyColumns: 98, scroll: { offset: 0, bodyRows: 8 }, view: {} },
} as const;
const PROSE = "Anything needs adressing?";
const COMMAND = { command: "feedback", origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 100 } } as const;

let startupClock: ReturnType<typeof mock.clock>;

function setup(on: Parameters<TestBody>[1], options: { lines?: string[]; failReview?: boolean; failStatus?: boolean; crash?: string; drop?: boolean; transform?: boolean; slow?: boolean; persistFirst?: boolean; env?: Record<string, string>; nodePath?: string } = {}, engine?: Parameters<TestBody>[0]) {
  const clock = mock.clock(on);
  startupClock = clock;
  mock.env(on, options.env ?? {});
  on("fs.stat", ($, e) => {
    if (e.path !== options.nodePath) throw new Error("ENOENT");
    return { value: { kind: "file", size: 1, mtimeMs: 0, isLink: false } };
  });
  const executables: string[] = [];
  const requests: WorkerRequest[] = [];
  const logs: string[] = [];
  let stopped = 0;
  on("session.start", () => ({ cwd: "/work" }));
  on("classic.SessionStart", () => ({}));
  on("classic.UserPromptSubmit", () => ({}));
  on("session.end", ($, e) => ({ sessionId: e.sessionId }));
  on("session.id", () => ({ value: "session-id" }));
  on("command.register", ($, e) => ({ value: { command: e.name } }));
  on("prompt.submit", async ($, e) => {
    if (options.persistFirst && engine) {
      await engine.session.append({ door: "prompt", uuid: "inside-submit-uuid", origin: { kind: "composer" }, message: { type: "user", role: "user", content: [{ type: "text", text: e.text }] } });
      await engine.classic.UserPromptSubmit({ prompt: e.text, session_id: "session-id", transcript_path: "/tmp/real-transcript.jsonl", cwd: "/work", permission_mode: "default" });
    }
    return options.drop ? { drop: "blocked" } : { text: e.text };
  });
  on("session.append", ($, e, next) => next(options.transform ? { ...e, message: { ...e.message, content: [{ type: "text", text: "fully transformed" }] } } : e));
  on("turn.start", ($, e) => ({ turnId: e.turnId }));
  on("turn.complete", () => ({ text: "" }));
  on("ui.log", ($, e) => { logs.push(e.text); return { value: undefined }; });
  on("ui.render", () => ({ type: "Text", props: {}, children: ["Other mod's band"] }));
  on("process.spawn", async function* ($, e) {
    executables.push(e.argv[0]!);
    const request = JSON.parse(e.input!) as WorkerRequest;
    requests.push(request);
    expect(e.argv.length).toBe(3);
    expect(e.argv[2]!.endsWith("/src/claude-worker.ts")).toBe(true);
    expect(e.argv.join(" ").includes(PROSE)).toBe(false);
    const fails = request.action === "status" ? options.failStatus : options.failReview;
    if (options.crash !== undefined) {
      if (options.crash) yield { stream: "stderr", text: options.crash };
      return { value: { code: 1, signal: null } };
    }
    try {
      if (request.action === "review" && options.slow) await clock.sleep(500);
      const status = { ...STATUS, ...request.settings };
      const raw = JSON.stringify(fails ? { error: "Reviewer failed" } : { status, lines: request.action === "review" ? options.lines ?? CORRECTIONS : [] });
      // UTF-8 text/JSON may arrive in multiple chunks.
      yield { stream: "stdout", text: raw.slice(0, 20) };
      yield { stream: "stdout", text: raw.slice(20) };
      return { value: { code: fails ? 1 : 0, signal: null } };
    } finally { stopped++; }
  });
  return { clock, requests, logs, executables, get stopped() { return stopped; } };
}

async function start($: Parameters<TestBody>[0], interactive = true) {
  await $.session.start({ cwd: "/work", isInteractive: interactive, surface: interactive ? "terminal" : null });
  await startupClock.settle(); // Configuration runs off-hook.
}
async function submit($: Parameters<TestBody>[0], text = PROSE, origin: "composer" | "plugin" | "sdk" | "bridge" = "composer") {
  return $.prompt.submit({ text, wait: false, origin: origin === "plugin" ? { kind: "plugin", name: "another" } : { kind: origin } });
}
async function append($: Parameters<TestBody>[0], id = "actual-user-uuid", text = PROSE) {
  return $.session.append({ door: "prompt", uuid: id, origin: { kind: "composer" }, message: { type: "user", role: "user", content: [{ type: "text", text }] } });
}

test("review starts off-hook, displays during the main turn, and preserves other mods' band", async ($, on) => {
  const h = setup(on);
  await start($);
  const accepted = await submit($);
  expect(accepted).toEqual({ text: PROSE });
  await $.turn.start({ turnId: "turn-1", text: PROSE });
  const row = await append($);
  expect(row.uuid).toBe("actual-user-uuid");
  expect(h.requests.length).toBe(1); // Only startup status; no blocking review.
  await h.clock.settle();
  const request = h.requests[1]!;
  expect(request.action).toBe("review");
  if (request.action === "review") {
    expect(request.userMessageId).toBe("actual-user-uuid");
    expect(request.sessionId).toBe("session-id");
    expect(request.text).toBe(PROSE);
  }
  const ui = await $.ui.mount(BAND);
  expect(await ui.find({ type: "Text", text: CORRECTIONS[0] })).toBeDefined();
  expect(await ui.find({ type: "Text", text: "Other mod's band" })).toBeDefined();
  expect(h.logs).toEqual([]);
});

test("feedback commands never return context-bearing text; clear/last work while running", async ($, on) => {
  const h = setup(on);
  await start($);
  await submit($); await append($); await h.clock.settle();
  expect(await $.command.run({ ...COMMAND, args: "clear" })).toEqual({});
  const ui = await $.ui.mount(BAND);
  expect(await ui.find({ type: "Text", text: CORRECTIONS[0] })).toBeUndefined();
  expect(await $.command.run({ ...COMMAND, args: "last" })).toEqual({});
  expect(await ui.find({ type: "Text", text: CORRECTIONS[0] })).toBeDefined();
  expect(await $.command.run({ ...COMMAND, args: "status" })).toEqual({});
  expect(h.logs[h.logs.length - 1]).toMatch(/gpt-6\.1-sol/);
});

test("keyboard toggle is available while hidden, preserves other mods, and never starts a turn", async ($, on) => {
  const h = setup(on);
  await start($);
  const ui = await $.ui.mount(BAND);
  const button = await ui.find({ key: "feedback-toggle" });
  expect(button?.props.action).toBe("confirm:previousField");
  expect(await ui.find({ type: "Box" })).toBeDefined();
  await ui.press({ key: "feedback-toggle" }); // No previous correction: silent no-op.
  expect(h.requests.length).toBe(1);
  expect(h.logs).toEqual([]);

  await submit($); await $.turn.start({ turnId: "turn-1", text: PROSE });
  await append($); await h.clock.settle();
  expect(await ui.find({ type: "Text", text: CORRECTIONS[0] })).toBeDefined(); // Visible by default.
  await ui.press({ key: "feedback-toggle" });
  expect(await ui.find({ type: "Text", text: CORRECTIONS[0] })).toBeUndefined();
  expect(await ui.find({ key: "feedback-toggle" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: "Other mod's band" })).toBeDefined();
  await $.turn.complete({ turnId: "turn-1", answer: "Main answer", durationMs: 100, isAborted: false, reason: "answer" });
  expect(await ui.find({ type: "Text", text: CORRECTIONS[0] })).toBeUndefined();
  await ui.press({ key: "feedback-toggle" });
  expect(await ui.find({ type: "Text", text: CORRECTIONS[0] })).toBeDefined();
  expect(h.requests.length).toBe(2);
  expect(h.logs).toEqual([]);
});

test("toggle command shares shortcut state, returns no context, and resets on reload", async ($, on) => {
  const h = setup(on);
  await start($); await submit($); await append($); await h.clock.settle();
  const ui = await $.ui.mount(BAND);
  expect(await $.command.run({ ...COMMAND, args: "toggle" })).toEqual({});
  expect(await ui.find({ type: "Text", text: CORRECTIONS[0] })).toBeUndefined();
  await ui.press({ key: "feedback-toggle" });
  expect(await ui.find({ type: "Text", text: CORRECTIONS[0] })).toBeDefined();
  await $.command.run({ ...COMMAND, args: "clear" });
  await ui.press({ key: "feedback-toggle" });
  expect(await ui.find({ type: "Text", text: CORRECTIONS[0] })).toBeDefined();
  await $.command.run({ ...COMMAND, args: "reload" });
  await ui.press({ key: "feedback-toggle" });
  expect(await ui.find({ type: "Text", text: CORRECTIONS[0] })).toBeUndefined();
  await submit($); await append($, "after-reload"); await h.clock.settle();
  expect(await ui.find({ type: "Text", text: CORRECTIONS[0] })).toBeDefined();
});

test("hiding feedback does not cancel a pending review; new corrections appear automatically", async ($, on) => {
  const options = { slow: false };
  const h = setup(on, options);
  await start($); await submit($); await append($); await h.clock.settle();
  const ui = await $.ui.mount(BAND);
  options.slow = true;
  await submit($); await append($, "next-uuid"); await h.clock.advance(1);
  await ui.press({ key: "feedback-toggle" });
  expect(await ui.find({ type: "Text", text: CORRECTIONS[0] })).toBeUndefined();
  expect(h.stopped).toBe(2); // Startup + first review; second review still running.
  await h.clock.advance(500);
  expect(h.stopped).toBe(3);
  expect(await ui.find({ type: "Text", text: CORRECTIONS[0] })).toBeDefined();
  expect(h.requests.filter((r) => r.action === "review").length).toBe(2);
  expect(h.logs).toEqual([]);
});

test("shortcut control is terminal-only and absent in headless sessions", async ($, on) => {
  const h = setup(on);
  await start($, false);
  const headless = await $.ui.mount(BAND);
  expect(await headless.find({ key: "feedback-toggle" })).toBeUndefined();
  await headless.unmount();
  await start($);
  const desktop = await $.ui.mount({ ...BAND, surface: "desktop" });
  expect(await desktop.find({ key: "feedback-toggle" })).toBeUndefined();
  expect(h.requests.filter((r) => r.action === "review")).toEqual([]);
});

test("headless prompts, injected prompts, and cheap exclusions never trigger reviews", async ($, on) => {
  const h = setup(on);
  await start($, false);
  await submit($); await append($);
  await start($, true);
  for (const origin of ["plugin", "sdk"] as const) { await submit($, PROSE, origin); await append($); }
  for (const text of ["Thanks!", "/feedback on", "```ts\nconst x = 1\n```", "x".repeat(12001)]) {
    await submit($, text); await append($, "excluded", text);
  }
  await h.clock.settle();
  expect(h.requests.filter((r) => r.action === "review")).toEqual([]);
});

test("blocked, unmatched, and transformed prompts are never reviewed", async ($, on) => {
  const h = setup(on, { drop: true, transform: true });
  await start($);
  await submit($); await append($);
  await append($, "never-submitted", "unmatched prose");
  await h.clock.settle();
  expect(h.requests.filter((r) => r.action === "review")).toEqual([]);
});

test("persistence inside submission waits for acceptance and records late transcript metadata", async ($, on) => {
  const h = setup(on, { persistFirst: true }, $);
  await start($); await submit($);
  expect(h.requests.length).toBe(1);
  await h.clock.settle();
  const review = h.requests.find((r) => r.action === "review")!;
  expect(review.userMessageId).toBe("inside-submit-uuid");
  expect(review.sessionPath).toBe("/tmp/real-transcript.jsonl");
});

test("a prompt rejected after persistence is not sent to the reviewer", async ($, on) => {
  const h = setup(on, { persistFirst: true, drop: true }, $);
  await start($); await submit($); await h.clock.settle();
  expect(h.requests.filter((r) => r.action === "review")).toEqual([]);
});

test("stored transformation after capture is skipped", async ($, on) => {
  const h = setup(on, { transform: true });
  await start($); await submit($); await append($); await h.clock.settle();
  expect(h.requests.filter((r) => r.action === "review")).toEqual([]);
});

test("queue is bounded and attributes duplicate inputs to distinct persisted IDs", async ($, on) => {
  const h = setup(on);
  await start($);
  for (let i = 0; i < 20; i++) { await submit($); await append($, "id-" + i); }
  await h.clock.settle();
  const reviews = h.requests.filter((r) => r.action === "review");
  expect(reviews.length).toBe(17); // One scheduled active review + sixteen waiting.
  expect(reviews.map((r) => r.userMessageId)).toEqual(Array.from({ length: 17 }, (_, i) => "id-" + i));
  expect(h.logs.some((line) => line.includes("queue is full"))).toBe(true);
});

test("off cancels scheduled reviews and enabling validates model without a review", async ($, on) => {
  const h = setup(on);
  await start($); await submit($); await append($);
  expect(await $.command.run({ ...COMMAND, args: "off" })).toEqual({});
  await h.clock.settle();
  expect(h.requests.filter((r) => r.action === "review")).toEqual([]);
  expect(await $.command.run({ ...COMMAND, args: "on" })).toEqual({});
  await submit($); await append($); await h.clock.settle();
  expect(h.requests.filter((r) => r.action === "review").length).toBe(1);
});

test("model selection remains in the reviewer and commands never start a main turn", async ($, on) => {
  const h = setup(on);
  await start($);
  expect(await $.command.run({ ...COMMAND, args: "model openai-codex/another-model" })).toEqual({});
  await submit($); await append($); await h.clock.settle();
  const review = h.requests.find((r) => r.action === "review")!;
  expect(review.settings?.model).toBe("another-model");
  expect(await $.command.run({ ...COMMAND, args: "model invalid" })).toEqual({});
  expect(h.logs[h.logs.length - 1]).toMatch(/provider\/model-id/);
});

test("clean reviews have no UI and no transcript output", async ($, on) => {
  const h = setup(on, { lines: [] });
  await start($); await submit($); await append($); await h.clock.settle();
  const ui = await $.ui.mount(BAND);
  expect(await ui.find({ type: "Text", text: /Correction/ })).toBeUndefined();
  expect(h.logs).toEqual([]);
});

test("review failures wait for the main turn to settle", async ($, on) => {
  const h = setup(on, { failReview: true });
  await start($); await submit($); await $.turn.start({ turnId: "turn-1", text: PROSE });
  await append($); await h.clock.settle();
  expect(h.logs).toEqual([]);
  await $.turn.complete({ turnId: "turn-1", answer: "Main answer", durationMs: 100, isAborted: false, reason: "answer" });
  expect(h.logs).toEqual(["English feedback: Reviewer failed"]);
});

test("configuration errors fail closed without blocking normal prompts", async ($, on) => {
  const h = setup(on, { failStatus: true });
  await start($);
  expect(await submit($)).toEqual({ text: PROSE });
  await append($); await h.clock.settle();
  expect(h.requests.filter((r) => r.action === "review")).toEqual([]);
  expect(h.logs[0]).toMatch(/disabled/);
});

test("session replacement cancels stale reviews and reloads config and transcript attribution", async ($, on) => {
  const h = setup(on);
  await start($); await submit($); await append($);
  await $.session.end({ reason: "clear", sessionId: "session-id", resume: { id: "session-id" } });
  await $.classic.SessionStart({ source: "clear", session_id: "new-session", transcript_path: "/tmp/new-session.jsonl", cwd: "/work", permission_mode: "default" });
  await h.clock.settle();
  expect(h.requests.filter((r) => r.action === "review")).toEqual([]);
  await submit($); await append($, "new-uuid"); await h.clock.settle();
  const r = h.requests.find((r) => r.action === "review")!;
  expect(r.sessionId).toBe("new-session"); expect(r.sessionPath).toBe("/tmp/new-session.jsonl");
});

test("headless sessions never start the reviewer worker", async ($, on) => {
  const h = setup(on);
  await start($, false);
  await submit($); await append($); await h.clock.settle();
  expect(h.requests).toEqual([]);
});

test("a worker that crashes on start explains missing dependencies", async ($, on) => {
  const h = setup(on, { crash: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@earendil-works/pi-coding-agent'\n" });
  await start($);
  expect(h.logs.length).toBe(1);
  expect(h.logs[0]).toMatch(/disabled: .*npm ci --ignore-scripts/);
});

test("a worker that crashes silently reports its exit code", async ($, on) => {
  const h = setup(on, { crash: "" });
  await start($);
  expect(h.logs[0]).toMatch(/failed to start \(exit code 1\)$/);
});

test("discovers Pi's stable Node path when Claude inherited a stale PATH", async ($, on) => {
  const nodePath = "/home/test/.local/share/pi-node/current/bin/node";
  const h = setup(on, { env: { HOME: "/home/test", PATH: "/deleted/node-v22/bin:/usr/bin" }, nodePath });
  await start($); await submit($); await append($); await h.clock.settle();
  expect(h.executables).toEqual([nodePath, nodePath]);
  expect(h.logs).toEqual([]);
});

test("honors XDG_DATA_HOME for Pi's managed Node", async ($, on) => {
  const nodePath = "/data/pi-node/current/bin/node";
  const h = setup(on, { env: { HOME: "/home/test", XDG_DATA_HOME: "/data" }, nodePath });
  await start($);
  expect(h.executables).toEqual([nodePath]);
});

test("explicit Node override wins over Pi's managed runtime", async ($, on) => {
  const h = setup(on, { env: { HOME: "/home/test", CLAUDE_CORRECTIVE_FEEDBACK_NODE: "/custom/node" },
    nodePath: "/home/test/.local/share/pi-node/current/bin/node" });
  await start($);
  expect(h.executables).toEqual(["/custom/node"]);
});

test("falls back to PATH when managed Node is absent", async ($, on) => {
  const h = setup(on, { env: { HOME: "/home/test" } });
  await start($);
  expect(h.executables).toEqual(["node"]);
});

test("missing Node explains how to select a runtime without blocking prompts", async ($, on) => {
  const h = setup(on, { crash: "spawn node ENOENT" });
  await start($);
  expect(h.logs[0]).toMatch(/Cannot start reviewer.*CLAUDE_CORRECTIVE_FEEDBACK_NODE/);
  expect(await submit($)).toEqual({ text: PROSE });
});

test("old Node explains the minimum version", async ($, on) => {
  const h = setup(on, { crash: "node: bad option: --experimental-strip-types\n" });
  await start($);
  expect(h.logs[0]).toMatch(/Node.js 22.19\+/);
});
