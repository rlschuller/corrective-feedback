# Corrective feedback

Since we are deep into the sci-fi journey of talking to computers in natural
language, why not learn a few tricks along the way? This plugin spawns a
subagent to correct your English without polluting the main conversation:

![A spelling correction appears in Pi and Claude Code while the agent responds; Ctrl+N hides and recalls it.](docs/assets/demo.gif)

It also logs your prompts to JSONL files, so you can plot your mistakes and
train your own flashy neural network.

## Quick start

Just send `https://github.com/rlschuller/corrective-feedback` to your agent and
ask it to adapt the project to your setup. I recommend using GPT Sol 6.1 or
better to correct your English, since GPT Luna 6 is not reliable enough for
this task. My own setup is a bit unusual: I use Pi with
`openai-codex/gpt-6.1-sol` to correct what I write in both Claude Code and Pi,
so technically Pi is an "obligatory" dependency. Until your agent fixes it.

## Use

Reviews are on by default; suggestions are off. When the reviewer spots an
error, the correction appears above the input field as blue text. If no
corrections appear, either your setup is broken or you made no mistakes.

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

The default reviewer is GPT Sol 6.1; availability depends on your account.
Choose another available model with `/feedback model provider/id` or customize the
[Pi](config.example.json) / [Claude](claude-config.example.json) configuration.
See [configuration paths and options](docs/guide.md#configuration).

## Privacy and cost

Obligatory warning, since my agents are **very** worried about it:

Please turn off feedback (`/feedback off`) before sending messages with
sensitive information. Your messages are sent to whichever service you chose
for corrections. Naturally, these subagent corrections will consume tokens.
Additionally, the log feature stores your messages locally. 

PS: Now even the humans will understand how the log feature works, right, Claude?

## More

- [Full guide](docs/guide.md): installation, configuration, commands, and troubleshooting details.
- [Development and tests](docs/guide.md#development-and-verification).
- [Local statistics and plots](docs/guide.md#update-the-time-series-plot) (generated files are ignored by Git).
