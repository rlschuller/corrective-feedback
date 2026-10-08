import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from "claude-code";
import { displayLine, parseWorkerReply } from "../src/claude-protocol.ts";
import type { ReviewerSettings, ReviewerStatus, WorkerReply, WorkerRequest } from "../src/claude-protocol.ts";
import { prepareText } from "../src/text.ts";

interface Input { raw: string; accepted: boolean; job?: Job }
interface Job { text: string; sessionId: string; sessionPath: string | null; userMessageId: string }
let status: ReviewerStatus | undefined;
let settings: ReviewerSettings = {};
let interactive = false;
let sessionId = "";
let sessionPath: string | null = null;
let node = "node";
let epoch = 0;
let pending: Input[] = [];
let queue: Job[] = [];
let pumping = false;
let settled = true;
let lines: string[] = [];
let last: string[] = [];
let failure: string | undefined;
const streams = new Set<HookStream<ProcessSpawnChunk, ProcessSpawnResult>>();

function reset($: EngineInterface, forgetLast = true): void {
  epoch++;
  pending = [];
  queue = [];
  pumping = false;
  failure = undefined;
  lines = [];
  if (forgetLast) last = [];
  for (const stream of streams) void stream.return({ code: null, signal: "SIGTERM" }).catch(() => {});
  streams.clear();
  $.ui.invalidate("ui.render");
}

async function worker($: EngineInterface, request: WorkerRequest, timeoutMs: number): Promise<WorkerReply> {
  const stream = $.process.spawn({
    argv: [node, "--experimental-strip-types", $.plugin.root + "/src/claude-worker.ts"],
    cwd: $.plugin.root,
    input: JSON.stringify(request),
  });
  // Closing a spawn stream kills its child, including on reload/unload.
  void stream.result.catch(() => {});
  streams.add(stream);
  let rejectDeadline: (reason: Error) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const timer = $.clock.after(timeoutMs, () => {
    rejectDeadline(new Error("Review timed out"));
    void stream.return({ code: null, signal: "SIGTERM" }).catch(() => {});
  });
  const read = async () => {
    let output = "";
    for await (const chunk of stream) {
      if (chunk.stream === "stdout") output += chunk.text;
      if (output.length > 200000) throw new Error("Reviewer worker output is too large");
    }
    const result = await stream.result;
    const reply = parseWorkerReply(output);
    if ("error" in reply) throw new Error(reply.error);
    if (result.code !== 0) throw new Error("Reviewer worker failed");
    return reply;
  };
  try {
    // Release the queue even if an intervening mod is slow to close a spawn stream.
    return await Promise.race([read(), deadline]);
  } finally {
    timer.cancel();
    streams.delete(stream);
    void stream.return({ code: null, signal: "SIGTERM" }).catch(() => {});
  }
}

function warn($: EngineInterface): void {
  if (failure && settled) {
    $.ui.log("English feedback: " + displayLine(failure));
    failure = undefined;
  }
}

function pump($: EngineInterface): void {
  if (pumping || !queue.length || !status?.enabled) return;
  pumping = true;
  const generation = epoch;
  const job = queue.shift()!;
  const snapshot = { ...settings };
  const timeoutMs = status.timeoutMs + 10000; // Allow bounded Node/Pi startup overhead.
  // The timer callback, not the prompt/append hook, waits on the reviewer process.
  $.clock.after(0, async () => {
    if (epoch !== generation) return;
    try {
      const reply = await worker($, { action: "review", ...job, settings: snapshot }, timeoutMs);
      if (epoch !== generation || "error" in reply) return;
      if (reply.lines.length) {
        last = reply.lines.map(displayLine);
        lines = last;
        $.ui.invalidate("ui.render");
      }
      if (reply.warning) failure = reply.warning;
    } catch (error) {
      if (epoch === generation) failure = error instanceof Error ? error.message : "Reviewer worker failed";
    } finally {
      if (epoch === generation) {
        pumping = false;
        warn($);
        pump($);
      }
    }
  });
}

function enqueue($: EngineInterface, input: Input): void {
  if (!input.accepted || !input.job || !interactive || !status?.enabled) return;
  const job = input.job;
  input.job = undefined;
  // Classic.UserPromptSubmit supplies metadata before prompt.submit resolves.
  job.sessionId = sessionId;
  job.sessionPath = sessionPath;
  if (!job.sessionId) return;
  if (queue.length >= 16) { failure = "Review queue is full; this message was skipped"; warn($); }
  else { queue.push(job); pump($); }
}

async function configure($: EngineInterface): Promise<void> {
  reset($);
  settings = {};
  status = undefined;
  const generation = epoch;
  try {
    const reply = await worker($, { action: "status" }, 30000);
    if (epoch === generation && !("error" in reply)) status = reply.status;
  } catch (error) {
    if (epoch === generation) $.ui.log("English feedback disabled: " + displayLine(error instanceof Error ? error.message : "Configuration failed"));
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    interactive = e.isInteractive && (e.surface === "terminal" || e.surface === "desktop");
    sessionId = await $.session.id();
    sessionPath = null;
    settled = true;
    node = (await $.env.get("CLAUDE_CORRECTIVE_FEEDBACK_NODE")) || "node";
    await configure($);
    await $.command.register({ name: "feedback", description: "Private English feedback: status | on | off | clear | last | model provider/id | reload", immediate: true });
    return next(e);
  });

  on("classic.SessionStart", async ($, e, next) => {
    sessionId = e.session_id;
    sessionPath = e.transcript_path || null;
    if (["clear", "resume", "fork"].includes(e.source)) {
      settled = true;
      await configure($);
    }
    return next(e);
  });

  on("classic.UserPromptSubmit", async ($, e, next) => {
    sessionId = e.session_id;
    sessionPath = e.transcript_path || null;
    return next(e);
  });

  on("session.end", async ($, e, next) => {
    reset($);
    return next(e);
  });

  on("prompt.submit", async ($, e, next) => {
    if (!interactive || !status?.enabled || !["composer", "bridge"].includes(e.origin.kind) || !prepareText(e.text, status.maxInputChars)) return next(e);
    const generation = epoch;
    const input: Input = { raw: e.text, accepted: false };
    pending.push(input);
    if (pending.length > 32) pending.shift();
    const result = await next(e);
    if (epoch === generation) {
      if (result.drop || result.text !== input.raw) {
        pending = pending.filter((item) => item !== input);
        input.job = undefined;
      } else {
        input.accepted = true;
        enqueue($, input);
      }
    }
    return result;
  });

  on("session.append", { door: "prompt" }, async ($, e, next) => {
    const generation = epoch;
    const text = e.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const input = !e.agentId && !e.message.isMeta && e.message.type === "user" && ["composer", "bridge"].includes(e.origin.kind)
      ? pending.find((item) => item.raw === text) : undefined;
    if (input) pending = pending.filter((item) => item !== input);
    const result = await next(e);
    if (input && epoch === generation && interactive && status?.enabled && result.message && result.uuid) {
      const stored = result.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      // Fully transformed/unmatched prompts are skipped, never attributed to another row.
      if (stored === input.raw) {
        input.job = { text: input.raw, sessionId, sessionPath, userMessageId: result.uuid };
        // Persistence can happen inside next(prompt.submit), before its gate finishes.
        // Do not review until BOTH the real row and prompt acceptance are known.
        enqueue($, input);
      }
    }
    return result;
  });

  on("turn.start", async ($, e, next) => {
    if (!("agentId" in e && e.agentId)) {
      settled = false;
      lines = [];
      $.ui.invalidate("ui.render");
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (!e.agentId) { settled = true; warn($); }
    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const theirs = await next(e);
    if (!lines.length) return theirs;
    const { Box, Text } = $.ui.resolve(e);
    return Box({ flexDirection: "column", children: [
      theirs,
      ...lines.map((line) => Text({ color: "#5599ff", children: [line] })),
    ] });
  });

  on("command.run", { command: "feedback" }, async ($, e) => {
    const [command = "status", value, ...extra] = e.args.trim().split(/\s+/).filter(Boolean);
    if (command === "clear") { lines = []; $.ui.invalidate("ui.render"); return {}; }
    if (command === "last") {
      lines = last;
      $.ui.invalidate("ui.render");
      if (!lines.length) $.ui.log("No corrections in this session yet");
      return {};
    }
    if (command === "reload") await configure($);
    else if (command === "off") { reset($); settings.enabled = false; if (status) status.enabled = false; }
    else if (command === "on" || command === "model") {
      if (command === "model" && (!value || !/^[^/]+\/.+$/.test(value) || extra.length)) {
        $.ui.log("Use /feedback model provider/model-id (from Pi's model catalog)");
        return {};
      }
      reset($);
      const generation = epoch;
      const candidate: ReviewerSettings = command === "on" ? { ...settings, enabled: true }
        : { ...settings, provider: value!.slice(0, value!.indexOf("/")), model: value!.slice(value!.indexOf("/") + 1) };
      try {
        const reply = await worker($, { action: "status", settings: candidate }, 30000);
        if (epoch === generation && !("error" in reply)) { settings = candidate; status = reply.status; }
      } catch (error) {
        if (epoch === generation) $.ui.log(displayLine(error instanceof Error ? error.message : "Configuration failed"));
      }
    } else if (command !== "status") {
      $.ui.log("Usage: /feedback status|on|off|clear|last|model provider/id|reload");
      return {};
    }
    if (status) $.ui.log([
      `English feedback: ${status.enabled ? "on" : "off"} · ${status.provider}/${status.model}`,
      "Config: " + status.configPath, "Log: " + status.logPath,
      "Automatic reviews are interactive-only; command changes last until reload/session replacement.",
    ].map(displayLine).join("\n"));
    else $.ui.log("English feedback is disabled; fix the configuration and run /feedback reload");
    // Command output's text field would enter Claude's context. Always return an empty result.
    return {};
  });
};
