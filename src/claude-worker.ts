// One isolated, tool-free review per invocation. Prompts travel over stdin, never argv.
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { handleWorkerRequest, parseWorkerRequest } from "./claude-reviewer.ts";
import { safeLine } from "./review.ts";

async function main(): Promise<void> {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    input += chunk.toString("utf8");
    if (input.length > 500000) throw new Error("Worker request is too large");
  }
  const request = parseWorkerRequest(JSON.parse(input));
  const reply = await handleWorkerRequest(request, {
    runtime: async (signal, config) => {
      // Pi owns provider credentials, OAuth refresh, and the cached model catalog.
      // Do not create a coding-agent session or discover tools, AGENTS.md, or extensions.
      const runtime = await ModelRuntime.create({ refreshOnCreate: false, signal });
      const result = await runtime.refresh({ providers: [config.provider], allowNetwork: false, signal });
      if (result.aborted) signal.throwIfAborted();
      if (!runtime.hasConfiguredAuth(config.provider)) throw new Error(`Log into ${config.provider} with Pi's /login first`);
      return runtime;
    },
  });
  process.stdout.write(JSON.stringify(reply) + "\n");
}

main().catch((error: unknown) => {
  process.stdout.write(JSON.stringify({ error: safeLine(error instanceof Error ? error.message : "Reviewer worker failed").slice(0, 500) }) + "\n");
  process.exitCode = 1;
});
