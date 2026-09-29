# Pi corrective feedback

An installable Pi extension for selective English feedback, outside the main agent's context.

## Install

Requires Node.js 22.19+ and a current Pi with `agent_settled` and `modelRegistry.streamSimple`
(tested with `@earendil-works/pi-coding-agent` 0.87.1).

```sh
pi install /absolute/path/to/corrective-feedback
```

Run `/reload` in an existing Pi session, or start a new one. Pi loads the root `index.ts`
entry point, displaying the extension as `corrective-feedback` rather than `src`.
The package has no additional runtime dependencies; Pi loads the TypeScript directly. Log into your chosen provider using
Pi's `/login`. The default reviewer is **openai-codex/gpt-6-luna**; no separate API key is needed
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

## Behavior

1. Capture only original interactive user input, not assistant replies, tool results, images,
   extension-injected prompts, project instructions, or conversation history.
2. Match the input to its persisted user-message entry. Unmatched/fully transformed inputs
   are skipped rather than attributed to the wrong session message.
3. Make an independent, tool-free model request containing a small reviewer system prompt and
   a JSON-encoded copy of the submitted prose. This is **not** a child coding-agent session:
   no default coding prompt, AGENTS.md, skills, tools, or Pi-subagents dependency.
4. Run reviews asynchronously, one at a time, while the main agent works.
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
| `/feedback model openai-codex/gpt-6-sol` | Select another model from Pi's catalog |
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
  "model": "gpt-6-luna",
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
{"version":1,"id":"uuid","timestamp":"2026-09-28T00:00:00.000Z","sessionPath":"/path/to/session.jsonl","sessionId":"session-id","userMessageId":"entry-id","provider":"openai-codex","model":"gpt-6-luna","corrections":[{"kind":"error","original":"adressing","corrected":"addressing","category":"spelling","explanation":"Use a double d."}],"reviewerMessages":[{"role":"assistant","content":"{\"corrections\":[...]}"}],"usage":{},"durationMs":2000}
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
npm run check
```

Tests cover parsing, filtering, private JSONL, source attribution, non-blocking lifecycle,
immediate display, shortcut dismissal/recall, settlement ordering, queued/steering input,
cancellation, timeouts, model selection, errors,
and exclusion of headless/extension input. Tests mock model calls and consume no quota.

Optional live checks (consume a small amount of provider quota):

```sh
npm run smoke                 # Luna: spelling error and preservation of “main thread”
npm run smoke -- gpt-6-sol    # same checks with Sol
python3 test/tui-smoke.py     # real Pi regular-mode TUI, widget + JSONL (Unix)
```

The TUI smoke check uses a temporary config/log and an in-memory main session. It runs Pi
with no tools, skills, context files, or other extensions. No test artifacts enter your normal
feedback log. Feedback does not use `sendMessage`, `sendUserMessage`, or `appendEntry`, so
neither correction instructions nor correction text enters the main model's history.
