import { closeSync, constants, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { Correction } from "./review.ts";

export interface FeedbackRecord {
  version: 1;
  id: string;
  timestamp: string;
  sessionPath: string | null;
  sessionId: string;
  userMessageId: string;
  provider: string;
  model: string;
  responseModel?: string;
  corrections: Correction[];
  reviewerMessages: { role: "assistant"; content: string }[];
  usage: unknown;
  durationMs: number;
}

/** One bounded O_APPEND write: concurrent local Pi processes cannot interleave JSON lines. */
export function appendRecord(path: string, record: FeedbackRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const line = Buffer.from(JSON.stringify(record) + "\n");
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (writeSync(fd, line) !== line.length) throw new Error("Incomplete feedback log write");
  } finally {
    closeSync(fd);
  }
}
