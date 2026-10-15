# Corrective feedback for Pi and Claude Code

English corrections alongside your coding agent—not in its conversation.
Feedback appears in blue while the agent keeps working, without editing your prompt
or adding corrections to the main model's context.

![A spelling correction appears in Pi and Claude Code while the agent responds; Ctrl+N hides and recalls it.](docs/assets/demo.gif)

## Quick start

Requires **Node.js 22.19+**, **Pi** with a configured reviewer provider (`/login` in Pi),
and, for the Claude plugin, **Claude Code 2.1.295+**. Tested with Pi **0.87.1**.
Both plugins use Pi's provider credentials; the Claude subscription is not used for reviews.

```sh
git clone https://github.com/rlschuller/corrective-feedback.git
cd corrective-feedback
```

### Pi

```sh
pi install "$PWD"
```

Run `/reload` in Pi, or start a new session.

### Claude Code

```sh
npm ci --ignore-scripts
claude --plugin-dir "$PWD"
```

From another project, use `claude --plugin-dir /absolute/path/to/corrective-feedback`.
See the [guide](docs/guide.md#use-in-claude-code) for permanent installation across projects.

## Use

Reviews are on by default. Submit a prompt normally; clear English errors get a short
correction and explanation. No corrections means no extra UI. Suggestions are off by default.

| Command | Action |
|---|---|
| `/feedback` | Show status and configuration paths |
| `/feedback off` / `/feedback on` | Disable / enable reviews |
| `/feedback clear` / `/feedback last` | Hide / recall corrections |
| `/feedback model provider/id` | Change the reviewer for this session |
| `/feedback reload` | Reload configuration |

**Ctrl+N** hides or recalls feedback without changing your draft.
[Set up the Claude shortcut](docs/guide.md#claude-behavior-and-commands) and
[avoid Pi's shortcut conflict](docs/guide.md#behavior-pi) before using it.

The default reviewer is `openai-codex/gpt-6.1-sol`; availability depends on your account.
Choose another available model with `/feedback model provider/id` or customize the
[Pi](config.example.json) / [Claude](claude-config.example.json) configuration.
See [configuration paths and options](docs/guide.md#configuration).

## Privacy and cost

Your prose is sent separately to the reviewer provider and consumes its quota.
Local feedback logs can contain sensitive excerpts. Filtering is **not** a secret scrubber:
use `/feedback off` before submitting sensitive text. Feedback can be wrong; your original
message is never changed. [Privacy details](docs/guide.md#jsonl-and-privacy).

## More

- [Full guide](docs/guide.md): installation, configuration, commands, and troubleshooting details.
- [Development and tests](docs/guide.md#development-and-verification).
- [Local statistics and plots](docs/guide.md#update-the-time-series-plot) (generated files are ignored by Git).
