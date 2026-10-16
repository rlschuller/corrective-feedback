import { expect, mock, test } from "claude-code/testing";
import type { TestBody } from "claude-code/testing";

const STATUS = { enabled: true, provider: "openai-codex", model: "gpt-6.1-sol", maxInputChars: 12000, timeoutMs: 1000, configPath: "/tmp/config.json", logPath: "/tmp/claude.jsonl" };
const COMMAND = { command: "feedback", origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 100 } } as const;
const BAND = { plugin: "corrective-feedback", surface: "terminal", component: "AbovePrompt", requestId: "band", props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 98, scroll: { offset: 0, bodyRows: 8 }, view: {} } } as const;

function setup(on: Parameters<TestBody>[1]) {
  const clock = mock.clock(on);
  mock.env(on, {});
  const reviews: string[] = [];
  const logs: string[] = [];
  on("session.start", () => ({ cwd: "/work" }));
  on("session.id", () => ({ value: "session-id" }));
  on("session.end", ($, e) => ({ sessionId: e.sessionId }));
  on("command.register", ($, e) => ({ value: { command: e.name } }));
  on("prompt.submit", ($, e) => ({ text: e.text }));
  on("ui.render", () => ({ type: "Text", props: {}, children: ["Empty band"] }));
  on("ui.log", ($, e) => { logs.push(e.text); return { value: undefined }; });
  on("process.spawn", async function* ($, e) {
    const request = JSON.parse(e.input!);
    if (request.action === "review") {
      reviews.push(request.userMessageId);
      if (request.userMessageId === "slow") await clock.sleep(20000);
    }
    yield { stream: "stdout", text: JSON.stringify({ status: STATUS, lines: request.action === "review" ? ["Correction from " + request.userMessageId] : [] }) };
    return { value: { code: 0, signal: null } };
  });
  return { clock, reviews, logs };
}

async function add($: Parameters<TestBody>[0], id: string) {
  const text = "We needs adressing this issue.";
  await $.prompt.submit({ text, wait: false, origin: { kind: "composer" } });
  await $.session.append({ door: "prompt", uuid: id, origin: { kind: "composer" }, message: { type: "user", role: "user", content: [{ type: "text", text }] } });
}

test("off invalidates an in-flight review, even if its process returns late", async ($, on) => {
  const h = setup(on);
  await $.session.start({ cwd: "/work", isInteractive: true, surface: "terminal" });
  await h.clock.settle();
  await add($, "slow");
  await h.clock.advance(1);
  expect(h.reviews).toEqual(["slow"]);
  expect(await $.command.run({ ...COMMAND, args: "off" })).toEqual({});
  await h.clock.advance(20000);
  const ui = await $.ui.mount(BAND);
  expect(await ui.find({ type: "Text", text: /Correction/ })).toBeUndefined();
  expect(h.logs.some((line) => line.includes("Correction"))).toBe(false);
});

test("process deadline releases the next queued review and rejects late output", async ($, on) => {
  const h = setup(on);
  await $.session.start({ cwd: "/work", isInteractive: true, surface: "terminal" });
  await h.clock.settle();
  await add($, "slow"); await add($, "fast");
  await h.clock.advance(12000);
  expect(h.reviews).toEqual(["slow", "fast"]);
  const ui = await $.ui.mount(BAND);
  expect(await ui.find({ type: "Text", text: "Correction from slow" })).toBeUndefined();
  expect(await ui.find({ type: "Text", text: "Correction from fast" })).toBeDefined();
  expect(h.logs.some((line) => line.includes("timed out"))).toBe(true);
  await h.clock.advance(10000);
  expect(await ui.find({ type: "Text", text: "Correction from slow" })).toBeUndefined();
});
