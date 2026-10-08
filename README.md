# Corrective feedback for Pi and Claude Code

Selective English feedback outside the main agent's context: a Pi extension and a Claude Code
mod backed by Pi's model runtime. Both share the reviewer prompt, filtering, parsing, and
private JSONL writer.

## Install in Pi

Requires Node.js 22.19+ and a current Pi with `agent_settled` and `modelRegistry.streamSimple`
(tested with `@earendil-works/pi-coding-agent` 0.87.1).

```sh
pi install /absolute/path/to/corrective-feedback
```

Run `/reload` in an existing Pi session, or start a new one. Pi loads the root `index.ts`
entry point, displaying the extension as `corrective-feedback` rather than `src`.
The package has no additional runtime dependencies; Pi loads the TypeScript directly. Log into your chosen provider using
Pi's `/login`. The default reviewer is **openai-codex/gpt-6-sol**; no separate API key is needed
when that model is available through your Codex subscription.

To try without installing:

```sh
pi -e /absolute/path/to/corrective-feedback/index.ts
```

For another machine, copy/clone this project and run `pi install /path/to/checkout` there.
Credentials, logs, and machine-specific configuration are intentionally not in the project.
A git URL can also be installed with `pi install git:github.com/OWNER/REPOSITORY` once published.

Remove with `pi remove /absolute/path/to/corrective-feedback`, followed by `/reload`.
Removal does not delete your configuration or logs.

## Use in Claude Code

Requires **Claude Code 2.1.295+**, **Node.js 22.19+** on `PATH`, and Pi's existing provider
login (tested with Pi 0.87.1). The default Claude reviewer is **openai-codex/gpt-6-sol**.
The Claude subscription is not used for reviews; Pi handles the selected provider's credentials,
OAuth refresh, and quota. If Sol 6 works in Pi, no separate API key is needed here.

Install the local worker's dependencies once, then load this checkout as a plugin:

```sh
cd /absolute/path/to/corrective-feedback
npm ci --ignore-scripts
claude --plugin-dir "$PWD"
```

To use it while working in another project, run
`claude --plugin-dir /absolute/path/to/corrective-feedback` from that project. Accept Claude's
workspace trust prompt when appropriate. Check `/plugin` for the active `corrective-feedback`
mod, then use `/feedback status`. This does not install the mod globally or change Claude's
settings. To stop loading it, omit `--plugin-dir` on your next invocation.

### Claude behavior and commands

The mod captures only interactive composer/Remote Control input, then waits for **both prompt
acceptance and its persisted user row**. Blocked, unmatched, fully transformed, headless,
subagent, and injected prompts are skipped. Each review runs in a separate local Node worker
using Pi's `ModelRuntime.completeSimple`: one reviewer system prompt, one JSON-encoded prose
message, no tools, coding-agent session, project instructions, or conversation history.

Reviews run asynchronously and serially, with at most 16 waiting. Corrections appear in blue
above the prompt even while Claude works, without replacing the spinner or another mod's
band. Empty results stay silent but are logged. The band clears on the next main turn; the
latest correction-bearing result remains available through `/feedback last`. Warnings wait
until Claude's main turn ends. Reload, disable, session replacement, and shutdown invalidate
pending work and close worker processes; deadlines release the queue even if cancellation is
slow. A worker is also killed if the mod unloads.

| Command | Effect |
|---|---|
| `/feedback` or `/feedback status` | Show state, model, config and log paths |
| `/feedback on` / `/feedback off` | Enable/disable for this runtime; off cancels pending reviews |
| `/feedback clear` | Hide corrections without deleting logs or cancelling work |
| `/feedback last` | Redisplay the latest corrections in this runtime |
| `/feedback model openai-codex/gpt-6-sol` | Validate/select a model from Pi's catalog |
| `/feedback reload` | Cancel pending work and reload configuration |

Command changes are temporary. There is no Ctrl+H binding in Claude; use `clear` and `last`.
Feedback, warnings, and command status never become Claude messages: drawing uses `ui.render`,
not prompt submission; command handlers return `{}`, not context-bearing text. History is
not replayed on resume/reload. Automatic review requires an interactive terminal or Desktop
surface; the VS Code chat panel and headless jobs are not reviewed.

### Claude configuration and privacy

Optional configuration: **`~/.pi/agent/claude-corrective-feedback.json`**. Copy
`claude-config.example.json` there to customize it. Its schema is the same as the Pi config
below, including the default model `gpt-6-sol`, but its default log is
**`~/.pi/agent/corrective-feedback/claude-feedback.jsonl`**. Pi's existing configuration and
default reviewer are unchanged.

- `PI_CODING_AGENT_DIR` selects Pi's credentials/catalog directory and the default config directory.
- `CLAUDE_CORRECTIVE_FEEDBACK_CONFIG` selects a different Claude feedback config file.
- `CLAUDE_CORRECTIVE_FEEDBACK_NODE` selects the worker's Node executable, if it is not on `PATH`.

Workers reread configuration for each request. `/feedback reload` also resets command overrides
and refreshes the mod's cached input limit, deadline, and displayed status. Invalid config,
unavailable models, or missing Pi authentication fail closed; the main Claude session still
works, and there is no silent fallback to another model.

Claude JSONL records use the schema below with `host: "claude-code"`, Claude's session ID,
transcript path, and the actual user-row UUID. Prompts travel over worker stdin, not command
arguments. The full original prompt is not duplicated in feedback logs. Logs are created with
the same 0700 directory/0600 file permissions as Pi's logs. The same privacy caveats apply:
your prose is sent separately to the reviewer provider, consumes its quota, and corrections
can contain sensitive excerpts. Use `/feedback off` before submitting sensitive prose.

Claude Code's [mods documentation](https://code.claude.com/docs/en/plugins/mods/overview)
describes plugin loading and supported surfaces.

## Behavior (Pi)

1. Capture only original interactive user input, not assistant replies, tool results, images,
   extension-injected prompts, project instructions, or conversation history.
2. Match the input to its persisted user-message entry. Unmatched/fully transformed inputs
   are skipped rather than attributed to the wrong session message.
3. Make an independent, tool-free model request containing a small reviewer system prompt and
   a JSON-encoded copy of the submitted prose. This is **not** a child coding-agent session:
   no default coding prompt, AGENTS.md, skills, tools, or Pi-subagents dependency.
4. Run reviews asynchronously, one at a time, while the main agent works. Pending reviews
   stay silent: no “English: reviewing…” status row or replacement of Pi's footer.
5. Show corrections as soon as the review finishes, even while the main answer is running,
   in a bright-blue widget above the editor (including `/feedback last` recalls). It never
   makes the main agent wait or starts another turn. Warnings wait until the main run settles.
6. Append one JSONL record per successfully completed, valid review, including token usage
   and estimated costs. No-correction results are logged with `corrections: []` but stay silent
   in the UI.

The reviewer is instructed to preserve domain terminology (including "main thread"), meaning,
register, dialect, and valid stylistic choices. Optional suggestions are off by default and,
when enabled, explicitly labeled separately from errors. Feedback is probabilistic: it can
miss a mistake or make an unnecessary suggestion. Nothing changes your original message.

Fenced code, inline code, Markdown blockquotes, URLs, common acknowledgments, shell/slash
commands, and overly long inputs are cheaply excluded before a request. The model is also
instructed to ignore non-English text, quoted examples, pasted documents, and logs. These
latter exclusions are best-effort—not a reliable language detector or sensitive-data filter.

The widget shows only blue corrections and explanations, without a header or message ID.
It clears on the next main run. For multiple inputs in one run, it shows the newest
correction-bearing review; all reviews and their message IDs remain available in the JSONL.
Press **Ctrl+H** to toggle feedback: hide it, then press again to show the latest corrections.
`/feedback clear` hides it too. Neither deletes logs nor cancels reviews. Hidden feedback
stays hidden when the main run finishes; new corrections still appear automatically.
`/feedback last` recalls the latest
correction-bearing review from this extension runtime. Some terminals cannot distinguish
Ctrl+H from Backspace; use `/feedback clear` if the shortcut conflicts with editing.
History is not replayed/re-reviewed on resume or reload.

Automatic review is **TUI-only**, not print/JSON/RPC/SDK runs, to avoid unexpected costs from
headless jobs and subagents. Both regular and fullscreen TUI use Pi's standard widget API.
Outstanding work is cancelled on shutdown, reload, session replacement, tree navigation,
or disabling/changing the reviewer. A maximum of 16 waiting reviews bounds rapid input;
additional messages are skipped with a warning. Reviews have a configurable timeout.

## Commands

| Command | Effect |
|---|---|
| `/feedback` or `/feedback status` | Show enabled state, model, config and log paths |
| `/feedback on` / `/feedback off` | Enable/disable for this runtime; off cancels pending work |
| `/feedback model openai-codex/gpt-6-luna` | Select another model from Pi's catalog |
| `/feedback clear` | Clear the widget; does not delete logs or cancel pending work |
| `/feedback last` | Redisplay the most recent corrections in this runtime |
| `/feedback reload` | Reload configuration and cancel pending reviews |

Command changes are temporary: edit the config for persistence across sessions and reloads.
`pi --feedback-disabled` overrides automatic review for the invocation, including `/feedback on`.
A configuration error disables reviews until fixed and reloaded.

## Configuration

Optional file: `~/.pi/agent/corrective-feedback.json`.
Uses `PI_CODING_AGENT_DIR` if set. Set `PI_CORRECTIVE_FEEDBACK_CONFIG` to use a different file.
Missing files use the defaults below; malformed files/unknown keys fail closed.

Copy `config.example.json` to the configuration path and edit it:

```json
{
  "enabled": true,
  "provider": "openai-codex",
  "model": "gpt-6-sol",
  "reasoning": "low",
  "includeSuggestions": false,
  "maxInputChars": 12000,
  "maxOutputTokens": 1800,
  "timeoutMs": 60000,
  "logPath": "corrective-feedback/feedback.jsonl"
}
```

Relative log paths resolve beside the config file, not against the working project.
`~` is supported. Model IDs depend on what your Pi/provider account exposes; no silent
fallback occurs. `reasoning` accepts off/minimal/low/medium/high (provider support varies).

## JSONL and privacy

Default log: `~/.pi/agent/corrective-feedback/feedback.jsonl`.
One line per successfully completed, valid review (including those with no corrections), with a schema version:

```json
{"version":1,"id":"uuid","timestamp":"2026-09-28T00:00:00.000Z","sessionPath":"/path/to/session.jsonl","sessionId":"session-id","userMessageId":"entry-id","provider":"openai-codex","model":"gpt-6-sol","corrections":[{"kind":"error","original":"adressing","corrected":"addressing","category":"spelling","explanation":"Use a double d."}],"reviewerMessages":[{"role":"assistant","content":"{\"corrections\":[...]}"}],"usage":{},"durationMs":2000}
```

`reviewerMessages` contains the reviewer's full visible textual response, not reasoning,
provider signatures, or the main agent's response. `responseModel` is included when supplied.
Only relevant excerpts are stored; the full original prompt is not duplicated. The session
path + message ID locate it in Pi's existing session file. In-memory sessions have a null path.
Session files can subsequently be moved/deleted, making that reference unavailable.

New log directories/files use permissions 0700/0600; existing permissions are not changed.
Each record uses one append write to avoid interleaving between local Pi processes. Prefer a
local filesystem: network filesystems may not provide equivalent append semantics. The log
has no automatic rotation or retention policy; back it up or remove records as desired.

**Privacy:** submitted prose is sent to the selected provider separately from the main agent
request. Logs contain your excerpts and corrections, possibly sensitive ones. The reviewer
has no tools but still sees the prose. Use `/feedback off` before sending sensitive text.
There is no secret-detection guarantee. No log data is uploaded for analytics by this extension.

Calls consume provider/subscription quota even when no corrections result. This version does
not add reviewer usage to Pi's main-session totals; JSONL records include the returned token
usage and estimated costs even when no corrections result. Failed, cancelled, or invalid-output
reviews are not logged, so the log is not a complete billing ledger. Provider dollar estimates
are not necessarily additional subscription charges.

## Development and verification

```sh
npm ci --ignore-scripts
npm run check                 # Pi + worker tests and Node type checking
npm run claude:check          # Claude's native validator/test kit; no model calls
python3 test/claude-tui-smoke.py # real Unix Claude TUI, both model paths stubbed
```

After loading the mod once in an interactive `claude --plugin-dir` session, Claude writes its
version-specific type declarations into ignored `.claude-plugin/types/`. Run
`npm run claude:typecheck` to check the mod against those exact declarations.
`claude:check` stages only the Claude test files, because Claude's recursive test runner cannot
run this repository's existing Node/Pi tests. The TUI smoke uses a generated temporary workspace
and trusts only that workspace; it submits one synthetic prompt, removes its transcript, and
makes no model calls. Real worker status/authentication can be checked without model quota:

```sh
printf '%s' '{"action":"status"}' | node --experimental-strip-types src/claude-worker.ts
```

Tests cover parsing, filtering, private JSONL, source attribution, non-blocking lifecycle,
immediate display, shortcut dismissal/recall, settlement ordering, queued/steering input,
cancellation, timeouts, model selection, errors,
and exclusion of headless/extension input. Tests mock model calls and consume no quota.

Optional live checks (consume a small amount of provider quota):

```sh
npm run smoke                 # Sol: spelling error and preservation of “main thread”
npm run smoke -- gpt-6-luna   # same checks with Luna
python3 test/tui-smoke.py     # real Pi regular-mode TUI, widget + JSONL (Unix)
```

The TUI smoke check uses a temporary config/log and an in-memory main session. It runs Pi
with no tools, skills, context files, or other extensions. No test artifacts enter your normal
feedback log. Feedback does not use `sendMessage`, `sendUserMessage`, or `appendEntry`, so
neither correction instructions nor correction text enters the main model's history.
