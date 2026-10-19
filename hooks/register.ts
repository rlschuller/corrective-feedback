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
let epoch = 0;
let pending: Input[] = [];
let queue: Job[] = [];
let pumping = false;
let settled = true;
let lines: string[] = [];
let last: string[] = [];
let failure: string | undefined;
const streams = new Set<HookStream<ProcessSpawnChunk, ProcessSpawnResult>>();

function toggleFeedback($: EngineInterface): void {
  lines = lines.length ? [] : last;
  $.ui.invalidate("ui.render");
}

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

/** Pi's managed Node is not necessarily on Claude's inherited PATH. Keep the
 * stable `current` link: version-specific paths disappear after Pi updates.
 */
async function workerNode($: EngineInterface): Promise<string> {
  const override = await $.env.get("CLAUDE_CORRECTIVE_FEEDBACK_NODE");
  if (override) return override;
  const home = await $.env.get("HOME");
  const dataHome = (await $.env.get("XDG_DATA_HOME")) || (home ? home + "/.local/share" : undefined);
  if (dataHome) {
    const candidate = dataHome + "/pi-node/current/bin/node";
    const stat = await $.fs.stat(candidate).catch(() => undefined);
    if (stat?.kind === "file") return candidate;
  }
  return "node";
}

async function worker($: EngineInterface, request: WorkerRequest, timeoutMs: number): Promise<WorkerReply> {
  const generation = epoch;
  const node = await workerNode($);
  if (generation !== epoch) throw new Error("Review cancelled");
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
    let errors = "";
    for await (const chunk of stream) {
      if (chunk.stream === "stdout") output += chunk.text;
      else errors = (errors + chunk.text).slice(-4000);
      if (output.length > 200000) throw new Error("Reviewer worker output is too large");
    }
    const result = await stream.result;
    if (!output.trim()) throw new Error(startFailure($, errors, result.code));
    const reply = parseWorkerReply(output);
    if ("error" in reply) throw new Error(reply.error);
    if (result.code !== 0) throw new Error("Reviewer worker failed");
    return reply;
  };
  try {
    // Release the queue even if an intervening mod is slow to close a spawn stream.
    return await Promise.race([read(), deadline]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT|executable.*not found|command not found/i.test(message)) {
      throw new Error(`Cannot start reviewer with ${node}; install Node.js 22.19+ or set CLAUDE_CORRECTIVE_FEEDBACK_NODE to its executable, then run /feedback reload`);
    }
    throw error;
  } finally {
    timer.cancel();
    streams.delete(stream);
    void stream.return({ code: null, signal: "SIGTERM" }).catch(() => {});
  }
}

/** The worker printed nothing: it crashed before main(), usually on a missing dependency. */
function startFailure($: EngineInterface, errors: string, code: number | null): string {
  if (/bad option.*experimental-strip-types|unknown.*experimental-strip-types/i.test(errors)) {
    return "Reviewer requires Node.js 22.19+; set CLAUDE_CORRECTIVE_FEEDBACK_NODE to a supported executable, then run /feedback reload";
  }
  if (/ERR_MODULE_NOT_FOUND|Cannot find (package|module)/.test(errors)) {
    return `Reviewer worker is missing dependencies; run "npm ci --ignore-scripts" in ${$.plugin.root}`;
  }
  const detail = errors.trim().split("\n").filter(Boolean).pop();
  return `Reviewer worker failed to start (exit code ${code ?? "none"})` + (detail ? ": " + detail.slice(0, 300) : "");
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
    // Headless sessions are never reviewed, so they never start a worker. Interactive
    // sessions configure off-hook; prompts sent before it finishes are not reviewed.
    status = undefined;
    if (interactive) $.clock.after(0, () => configure($));
    await $.command.register({ name: "feedback", description: "Private English feedback: status | on | off | toggle | clear | last | model provider/id | reload", immediate: true });
    return next(e);
  });

  on("classic.SessionStart", async ($, e, next) => {
    sessionId = e.session_id;
    sessionPath = e.transcript_path || null;
    if (interactive && ["clear", "resume", "fork"].includes(e.source)) {
      settled = true;
      status = undefined;
      $.clock.after(0, () => configure($));
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
    const keyboard = interactive && e.surface === "terminal";
    if (!lines.length && !keyboard) return theirs;
    const { Box, Text, Button } = $.ui.resolve(e);
    return Box({ flexDirection: "column", children: [
      theirs,
      // Claude cannot register custom keybinding actions. Route Ctrl+N through
      // this documented, unbound/no-op engine action (see the example bindings).
      // Keep the control mounted even when feedback is hidden, without a UI row.
      ...(keyboard ? [Box({ height: 0, children: [Button({
        key: "feedback-toggle", label: "Toggle English feedback", plain: true,
        action: "confirm:previousField", onPress: () => toggleFeedback($),
      })] })] : []),
      ...lines.map((line) => Text({ color: "#5599ff", children: [line] })),
    ] });
  });

  on("command.run", { command: "feedback" }, async ($, e) => {
    const [command = "status", value, ...extra] = e.args.trim().split(/\s+/).filter(Boolean);
    if (command === "toggle") { toggleFeedback($); return {}; }
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
      $.ui.log("Usage: /feedback status|on|off|toggle|clear|last|model provider/id|reload");
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
