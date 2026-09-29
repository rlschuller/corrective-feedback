// Explicit, opt-in provider test. Uses subscription quota; never runs as part of npm test.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defaults } from "../src/config.ts";
import { extractText, parseReview, reviewPrompt } from "../src/review.ts";

const config = defaults();
const runtime = await ModelRuntime.create();
const model = runtime.getModel(config.provider, process.argv[2] || config.model);
if (!model) throw new Error("Reviewer model not found");
for (const [text, expected] of [
  ["Anything that needs adressing before we start?", "addressing"],
  ["The main thread handles user input.", null],
] as const) {
  const started = Date.now();
  const response = await runtime.completeSimple(model, {
    systemPrompt: reviewPrompt(config),
    messages: [{ role: "user", content: JSON.stringify(text), timestamp: started }],
    tools: [],
  }, { reasoning: "low", maxTokens: config.maxOutputTokens, signal: AbortSignal.timeout(config.timeoutMs), sessionId: randomUUID(), cacheRetention: "none" });
  assert.equal(response.stopReason, "stop", response.errorMessage);
  const corrections = parseReview(extractText(response.content), text);
  console.log(JSON.stringify({ model: model.id, text, corrections, usage: response.usage, durationMs: Date.now() - started }));
  if (expected) assert(corrections.some((item) => item.corrected.includes(expected)));
  else assert.equal(corrections.length, 0, "Possible overcorrection: inspect the response above");
}
