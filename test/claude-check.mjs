// Stage only Claude's tests: its runner recursively finds *.test.ts, whereas the
// existing Pi/worker tests need Node APIs and run under node --test instead.
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "corrective-feedback-claude-tests-"));
try {
  await mkdir(join(dir, ".claude-plugin"));
  await mkdir(join(dir, "src"));
  for (const [source, target] of [
    [".claude-plugin/plugin.json", ".claude-plugin/plugin.json"],
    ["hooks", "hooks"], ["src/text.ts", "src/text.ts"],
    ["src/claude-protocol.ts", "src/claude-protocol.ts"], ["claude-tests", "tests"],
  ]) await cp(join(root, source), join(dir, target), { recursive: true });
  for (const args of [["plugin", "validate", dir, "--strict"], ["plugin", "test", dir]]) {
    const result = spawnSync("claude", args, { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
