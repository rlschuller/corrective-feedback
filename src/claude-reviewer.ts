import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expandHome, parseConfig } from "./config.ts";
import type { Config } from "./config.ts";
import type { WorkerReply, WorkerRequest, ReviewerStatus } from "./claude-protocol.ts";
import { appendRecord } from "./log.ts";
import type { FeedbackRecord } from "./log.ts";
import { extractText, feedbackLines, parseReview, prepareText, reviewPrompt, withAbort } from "./review.ts";

export function claudeConfigPath(): string {
  const agentDir = expandHome(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
  return resolve(expandHome(process.env.CLAUDE_CORRECTIVE_FEEDBACK_CONFIG || join(agentDir, "claude-corrective-feedback.json")));
}

export async function loadClaudeConfig(path = claudeConfigPath()): Promise<Config> {
  let value: unknown = {};
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Share Pi's model defaults, but keep Claude's configuration and log separate.
  const config = parseConfig(value, path);
  if (!Object.hasOwn(value as object, "logPath")) config.logPath = join(dirname(path), "corrective-feedback", "claude-feedback.jsonl");
  return config;
}

export function parseWorkerRequest(value: unknown): WorkerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid worker request");
  const r = value as Record<string, unknown>;
  if (r.action !== "status" && r.action !== "review") throw new Error("Invalid worker action");
  if (r.settings !== undefined) {
    if (!r.settings || typeof r.settings !== "object" || Array.isArray(r.settings)) throw new Error("Invalid reviewer settings");
    for (const [key, v] of Object.entries(r.settings)) {
      if (key === "enabled" ? typeof v !== "boolean" : !["provider", "model"].includes(key) || typeof v !== "string" || !v.trim()) {
        throw new Error("Invalid reviewer setting");
      }
    }
  }
  if (r.action === "review") {
    if (typeof r.text !== "string" || r.text.length > 100000 ||
        ![r.sessionId, r.userMessageId].every((v) => typeof v === "string" && v.length > 0 && v.length <= 1024) ||
        !(r.sessionPath === null || (typeof r.sessionPath === "string" && r.sessionPath.length <= 8192))) {
      throw new Error("Invalid review source");
    }
  }
  return value as WorkerRequest;
}

type Runtime = Pick<ModelRuntime, "getModel" | "completeSimple">;
export interface ReviewerDependencies {
  load?: () => Promise<Config>;
  runtime: (signal: AbortSignal, config: Config) => Promise<Runtime>;
  append?: typeof appendRecord;
  path?: string;
}

export async function handleWorkerRequest(request: WorkerRequest, deps: ReviewerDependencies): Promise<WorkerReply> {
  const path = deps.path ?? claudeConfigPath();
  const loaded = await (deps.load ?? (() => loadClaudeConfig(path)))();
  const config = parseConfig({ ...loaded, ...request.settings }, path);
  const status: ReviewerStatus = {
    enabled: config.enabled, provider: config.provider, model: config.model,
    maxInputChars: config.maxInputChars, timeoutMs: config.timeoutMs, configPath: path, logPath: config.logPath,
  };
  const text = request.action === "review" && config.enabled ? prepareText(request.text, config.maxInputChars) : undefined;
  // No runtime or quota for excluded/disabled reviews. Status validates model access without a model call.
  if (request.action === "review" && !text) return { status, lines: [] };
  const signal = AbortSignal.timeout(config.timeoutMs);
  const runtime = await withAbort(deps.runtime(signal, config), signal);
  const model = runtime.getModel(config.provider, config.model);
  if (!model) throw new Error(`Model not found in Pi: ${config.provider}/${config.model}`);
  if (request.action === "status") return { status, lines: [] };
  const started = Date.now();
  const response = await withAbort(runtime.completeSimple(model, {
    systemPrompt: reviewPrompt(config),
    messages: [{ role: "user", content: JSON.stringify(text!), timestamp: started }],
    tools: [],
  }, {
    reasoning: config.reasoning === "off" ? undefined : config.reasoning,
    maxTokens: config.maxOutputTokens, signal, sessionId: randomUUID(), cacheRetention: "none",
  }), signal);
  signal.throwIfAborted();
  if (response.stopReason !== "stop") throw new Error(`Reviewer did not finish (${response.stopReason})`);
  const raw = extractText(response.content);
  const corrections = parseReview(raw, text!, config.includeSuggestions);
  const record: FeedbackRecord = {
    version: 1, id: randomUUID(), timestamp: new Date().toISOString(), host: "claude-code",
    sessionId: request.sessionId, sessionPath: request.sessionPath, userMessageId: request.userMessageId,
    provider: config.provider, model: config.model, responseModel: response.responseModel,
    corrections, reviewerMessages: [{ role: "assistant", content: raw }], usage: response.usage,
    durationMs: Date.now() - started,
  };
  const reply: WorkerReply = { status, lines: feedbackLines(corrections) };
  try {
    (deps.append ?? appendRecord)(config.logPath, record);
  } catch {
    // Never lose valid corrections just because the local log could not be written.
    reply.warning = "Could not write the private feedback log";
  }
  return reply;
}
