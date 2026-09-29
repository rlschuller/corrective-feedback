import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface Config {
  enabled: boolean;
  provider: string;
  model: string;
  reasoning: "off" | "minimal" | "low" | "medium" | "high";
  includeSuggestions: boolean;
  maxInputChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
  logPath: string;
}

export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function configPath(): string {
  const agentDir = expandHome(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
  return resolve(expandHome(process.env.PI_CORRECTIVE_FEEDBACK_CONFIG || join(agentDir, "corrective-feedback.json")));
}

export function defaults(path = configPath()): Config {
  return {
    enabled: true,
    provider: "openai-codex",
    model: "gpt-6-sol",
    reasoning: "low",
    includeSuggestions: false,
    maxInputChars: 12000,
    maxOutputTokens: 1800,
    timeoutMs: 60000,
    logPath: join(dirname(path), "corrective-feedback", "feedback.jsonl"),
  };
}

export function parseConfig(value: unknown, path = configPath()): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be an object");
  const base = defaults(path);
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(base, key)) throw new Error(`Unknown setting: ${key}`);
  }
  const config = { ...base, ...input } as Config;
  for (const key of ["enabled", "includeSuggestions"] as const) {
    if (typeof config[key] !== "boolean") throw new Error(`${key} must be a boolean`);
  }
  for (const key of ["provider", "model", "logPath"] as const) {
    if (typeof config[key] !== "string" || !config[key].trim()) throw new Error(`${key} must be a nonempty string`);
  }
  if (!["off", "minimal", "low", "medium", "high"].includes(config.reasoning)) throw new Error("Invalid reasoning level");
  for (const [key, min, max] of [
    ["maxInputChars", 100, 100000], ["maxOutputTokens", 256, 16000], ["timeoutMs", 1000, 300000],
  ] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    }
  }
  const logPath = expandHome(config.logPath);
  config.logPath = isAbsolute(logPath) ? logPath : resolve(dirname(path), logPath);
  return config;
}

export async function loadConfig(path = configPath()): Promise<Config> {
  try {
    return parseConfig(JSON.parse(await readFile(path, "utf8")), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults(path);
    throw error;
  }
}
