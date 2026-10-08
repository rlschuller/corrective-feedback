// Pure data contract: safe to import in Claude's hooks-module environment (no Node APIs).
export interface ReviewerSettings {
  enabled?: boolean;
  provider?: string;
  model?: string;
}

export interface ReviewerStatus {
  enabled: boolean;
  provider: string;
  model: string;
  maxInputChars: number;
  timeoutMs: number;
  configPath: string;
  logPath: string;
}

export type WorkerRequest = {
  action: "status";
  settings?: ReviewerSettings;
} | {
  action: "review";
  text: string;
  sessionId: string;
  sessionPath: string | null;
  userMessageId: string;
  settings?: ReviewerSettings;
};

export type WorkerReply = { status: ReviewerStatus; lines: string[]; warning?: string } | { error: string };

export function parseWorkerReply(raw: string): WorkerReply {
  if (raw.length > 200000) throw new Error("Reviewer worker output is too large");
  const reply = JSON.parse(raw);
  if (typeof reply?.error === "string") return { error: reply.error };
  const s = reply?.status;
  if (!s || typeof s.enabled !== "boolean" ||
      ![s.provider, s.model, s.configPath, s.logPath].every((v) => typeof v === "string" && v.length > 0) ||
      !Number.isSafeInteger(s.maxInputChars) || s.maxInputChars < 100 || s.maxInputChars > 100000 ||
      !Number.isSafeInteger(s.timeoutMs) || s.timeoutMs < 1000 || s.timeoutMs > 300000 ||
      !Array.isArray(reply.lines) || reply.lines.length > 200 ||
      !reply.lines.every((v: unknown) => typeof v === "string" && v.length <= 4000) ||
      (reply.warning !== undefined && typeof reply.warning !== "string")) {
    throw new Error("Invalid reviewer worker output");
  }
  return reply as WorkerReply;
}

/** Worker text is already sanitized; remove controls again at the display boundary. */
export function displayLine(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");
}
