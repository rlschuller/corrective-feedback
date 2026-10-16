import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configPath, defaults, loadConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { appendRecord } from "./log.ts";
import type { FeedbackRecord } from "./log.ts";
import { extractText, feedbackLines, parseReview, prepareText, reviewPrompt, safeLine, withAbort } from "./review.ts";

const WIDGET = "corrective-feedback";
interface PendingInput { raw: string; prose: string }
interface Job {
  text: string;
  entryId: string;
  sessionId: string;
  sessionPath: string | null;
  ctx: ExtensionContext;
}

export default function correctiveFeedback(pi: ExtensionAPI): void {
  let config: Config = defaults();
  let configured = false;
  let epoch = 0;
  let settled = true;
  let inputs: PendingInput[] = [];
  let queue: Job[] = [];
  let active: AbortController | undefined;
  let completed: FeedbackRecord[] = [];
  let last: FeedbackRecord | undefined;
  let feedbackVisible = false;
  let failure: string | undefined;

  pi.registerFlag("feedback-disabled", { description: "Disable automatic English feedback for this Pi invocation", type: "boolean", default: false });

  function enabled(ctx: ExtensionContext): boolean {
    return configured && config.enabled && ctx.mode === "tui" && !pi.getFlag("feedback-disabled");
  }

  /** Why the reviewer cannot run, checked without a model call; undefined when it can. */
  function unavailable(ctx: ExtensionContext, provider: string, id: string): string | undefined {
    const model = ctx.modelRegistry.find(provider, id);
    if (!model) return `Model not found: ${provider}/${id}`;
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) return `No configured authentication for ${provider}; use /login, then /feedback on`;
  }

  function clearUI(ctx: ExtensionContext): void {
    feedbackVisible = false;
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(WIDGET, undefined);
  }

  function dismissFeedback(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    completed = [];
    clearUI(ctx);
  }

  pi.registerShortcut("ctrl+n", {
    description: "Toggle English feedback",
    handler: (ctx) => {
      if (ctx.mode !== "tui") return;
      if (feedbackVisible) dismissFeedback(ctx);
      else if (last) showFeedback(ctx, last);
    },
  });

  function reset(ctx: ExtensionContext): void {
    epoch++;
    active?.abort();
    active = undefined;
    queue = [];
    inputs = [];
    completed = [];
    last = undefined;
    failure = undefined;
    settled = true;
    clearUI(ctx);
  }

  function showFeedback(ctx: ExtensionContext, record: FeedbackRecord): void {
    const lines = feedbackLines(record.corrections);
    // Explicit bright blue, independent of the main thread's theme. Reset each line
    // so the color cannot leak into the editor or transcript; logs stay unstyled.
    ctx.ui.setWidget(WIDGET, lines.map((line) => `\u001b[94m${line}\u001b[39m`), { placement: "aboveEditor" });
    feedbackVisible = true;
  }

  function render(ctx: ExtensionContext): void {
    if (!enabled(ctx)) return;
    if (completed.length) {
      // The compact widget shows the most recent feedback; all records remain in JSONL.
      const record = completed[completed.length - 1];
      showFeedback(ctx, record);
    }
    // Corrections appear immediately; keep warnings until the main run settles.
    if (failure && settled) {
      ctx.ui.notify(`English feedback: ${failure}`, "warning");
      failure = undefined;
    }
  }

  function pump(): void {
    if (active || !queue.length) return;
    const job = queue.shift()!;
    const snapshot = { ...config };
    const generation = epoch;
    const controller = new AbortController();
    active = controller;
    const timeout = setTimeout(() => controller.abort(new Error("Review timed out")), snapshot.timeoutMs);
    timeout.unref();
    render(job.ctx);

    // Deliberately detached from lifecycle handlers: no delay to the main model or settlement.
    void (async () => {
      const started = Date.now();
      const model = job.ctx.modelRegistry.find(snapshot.provider, snapshot.model);
      if (!model) throw new Error(`Model not found: ${snapshot.provider}/${snapshot.model}`);
      if (!job.ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`No configured authentication for ${snapshot.provider}`);
      const response = await withAbort(job.ctx.modelRegistry.streamSimple(model, {
        systemPrompt: reviewPrompt(snapshot),
        messages: [{ role: "user", content: JSON.stringify(job.text), timestamp: started }],
        tools: [],
      }, {
        reasoning: snapshot.reasoning === "off" ? undefined : snapshot.reasoning,
        maxTokens: snapshot.maxOutputTokens,
        signal: controller.signal,
        // A separate routing/cache identity avoids sharing the main model's conversation.
        sessionId: randomUUID(),
        cacheRetention: "none",
      }).result(), controller.signal);
      if (epoch !== generation) return;
      if (controller.signal.aborted) throw new Error("Review timed out or was cancelled");
      if (response.stopReason !== "stop") throw new Error(`Reviewer did not finish (${response.stopReason})`);
      const raw = extractText(response.content);
      const corrections = parseReview(raw, job.text, snapshot.includeSuggestions);
      const record: FeedbackRecord = {
        version: 1,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        sessionPath: job.sessionPath,
        sessionId: job.sessionId,
        userMessageId: job.entryId,
        provider: snapshot.provider,
        model: snapshot.model,
        responseModel: response.responseModel,
        corrections,
        reviewerMessages: [{ role: "assistant", content: raw }],
        usage: response.usage,
        durationMs: Date.now() - started,
      };
      // Keep clean reviews silent and preserve the last correction-bearing review.
      // Display valid corrections even if a disk error prevents logging.
      if (corrections.length) {
        last = record;
        completed.push(record);
      }
      appendRecord(snapshot.logPath, record);
    })().catch((error: unknown) => {
      if (epoch === generation) failure = safeLine(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      clearTimeout(timeout);
      if (epoch !== generation) return;
      active = undefined;
      pump();
      render(job.ctx);
    });
  }

  async function configure(ctx: ExtensionContext): Promise<void> {
    reset(ctx);
    configured = false;
    try {
      config = await loadConfig();
      configured = true;
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`English feedback disabled: ${safeLine(String(error))}`, "warning");
      return;
    }
    // Warn once at startup instead of after every turn.
    const reason = enabled(ctx) ? unavailable(ctx, config.provider, config.model) : undefined;
    if (reason) {
      config.enabled = false;
      ctx.ui.notify(`English feedback disabled: ${safeLine(reason)}`, "warning");
    }
  }

  pi.on("session_start", (_event, ctx) => configure(ctx));
  pi.on("session_shutdown", (_event, ctx) => { reset(ctx); configured = false; });
  pi.on("session_tree", (_event, ctx) => reset(ctx));

  pi.on("input", (event, ctx) => {
    if (!enabled(ctx) || event.source !== "interactive") return;
    const prose = prepareText(event.text, config.maxInputChars);
    if (prose) inputs.push({ raw: event.text.trim(), prose });
    // Bound abandoned/transformed inputs; they are never reviewed without a matching user message.
    if (inputs.length > 32) inputs.shift();
  });

  pi.on("agent_start", (_event, ctx) => {
    settled = false;
    completed = [];
    clearUI(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (!enabled(ctx) || event.message.role !== "user") return;
    const content = extractText(event.message.content);
    const index = inputs.findIndex((input) => content.includes(input.raw));
    if (index < 0) return;
    const input = inputs.splice(index, 1)[0];
    const timestamp = event.message.timestamp;
    const generation = epoch;
    // Pi persists message_end AFTER extension handlers. Defer lookup to obtain its real entry ID.
    setImmediate(() => {
      if (epoch !== generation || !enabled(ctx)) return;
      const entry = [...ctx.sessionManager.getBranch()].reverse().find((entry) =>
        entry.type === "message" && entry.message.role === "user" &&
        entry.message.timestamp === timestamp && extractText(entry.message.content) === content);
      if (!entry) return;
      if (queue.length >= 16) {
        failure = "Review queue is full; this message was skipped";
        render(ctx);
        return;
      }
      queue.push({ text: input.prose, entryId: entry.id, sessionId: ctx.sessionManager.getSessionId(),
        sessionPath: ctx.sessionManager.getSessionFile() ?? null, ctx });
      pump();
    });
  });

  pi.on("agent_settled", (_event, ctx) => { settled = true; render(ctx); });

  pi.registerCommand("feedback", {
    description: "English feedback: status | on | off | clear | last | model provider/id | reload",
    handler: async (args, ctx) => {
      const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (command === "reload") {
        await configure(ctx);
      } else if (command === "on" || command === "off") {
        const reason = command === "on" ? unavailable(ctx, config.provider, config.model) : undefined;
        if (reason) {
          ctx.ui.notify(`English feedback stays off: ${safeLine(reason)}`, "warning");
          return;
        }
        reset(ctx);
        config.enabled = command === "on";
      } else if (command === "clear") {
        dismissFeedback(ctx);
        return;
      } else if (command === "last") {
        if (last && ctx.mode === "tui") {
          showFeedback(ctx, last);
        } else if (ctx.hasUI) ctx.ui.notify("No corrections in this session yet", "info");
        return;
      } else if (command === "model") {
        const value = rest.join(" ");
        const slash = value.indexOf("/");
        const provider = value.slice(0, slash);
        const model = value.slice(slash + 1);
        if (slash < 1 || !ctx.modelRegistry.find(provider, model)) {
          ctx.ui.notify("Use /feedback model provider/model-id (must exist in Pi's model catalog)", "warning");
          return;
        }
        const reason = unavailable(ctx, provider, model);
        if (reason) {
          ctx.ui.notify(`English feedback: ${safeLine(reason)}`, "warning");
          return;
        }
        reset(ctx);
        config.provider = provider;
        config.model = model;
      } else if (command !== "status") {
        ctx.ui.notify("Usage: /feedback status|on|off|clear|last|model provider/id|reload", "info");
        return;
      }
      if (ctx.hasUI) ctx.ui.notify([
        `English feedback: ${enabled(ctx) ? "on" : "off"} · ${config.provider}/${config.model}`,
        `Config: ${configPath()}`,
        `Log: ${config.logPath}`,
        "Changes via commands apply only until reload/session replacement. Automatic review is TUI-only.",
      ].join("\n"), "info");
    },
  });
}
