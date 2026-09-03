# dsh-loop-agent

[English](README.md) | [中文](README.zh.md)

A DSH profile bundle that turns the `headless` profile into an **endless same-session loop**:
after every final assistant answer, it automatically injects a user-configurable
continuation prompt at the next turn boundary and keeps going. Stop with **Ctrl-C**
(or a matching exit phrase, or hitting `maxRounds`).

The same Agent and the same Session live for the whole run, so every round sees
the full accumulating transcript — only the *next* user message is replaced by
the template. The default `@deepseek-ai/dsh-headless` one-shot runner is
disabled on profiles that mount this bundle, so installing the bundle is
enough to switch the profile from "one task, print, exit" to "keep talking".

## Install

```sh
dsh plugin --profile headless add https://github.com/tyza66/dsh-loop-agent
```

Then start the profile as usual. The positional task and the new flags work
the same way the one-shot profile already accepted them; only the behavior
changes.

## Usage

The shell syntax is identical to `dsh --profile headless`:

```sh
dsh --profile headless "build a snake game"
dsh --profile headless "build a snake game" --max-rounds 5
dsh --profile headless "build a snake game" --continuation "refactor it. Round {{round}}"
dsh --profile headless "build a snake game" --exit-phrase DONE --exit-phrase FINISHED
```

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `[task...]` | *(required)* | The first user message; multiple words are joined by spaces. |
| `--continuation <template>` | `Please continue from where you left off. (Round {{round}})` | Prompt sent at the start of every round after the first. Supports `{{task}}`, `{{lastAnswer}}`, `{{round}}`, `{{turn}}`. |
| `--max-rounds <n>` | `0` | Stop after `n` rounds. `0` (the default) means no cap; the loop runs until a phrase matches, a signal arrives, or you press Ctrl-C. |
| `--exit-phrase <phrases...>` | `[]` | Repeatable. If the last assistant text of a round contains any of these substrings (case-insensitive), the loop ends with exit code 0. |
| `--quiet` | off | Suppress the per-round `── dsh-loop-agent: round N ──` header on stderr. |
| `-h, --help` |  | Show help. |

### Placeholders

`{{lastAnswer}}` is the concatenated assistant text of the previous round
(empty on round 1, since it is unused there). `{{round}}` and `{{turn}}` are
1-based and identical (round 2 = first continuation). `{{task}}` is the
original task. Unknown placeholders are left intact so a typo is visible
in the next prompt rather than silently swallowed.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The loop ended because a phrase matched, `maxRounds` was reached, or the loop ran a clean final round. |
| `1` | The loop ended because a turn finished with an error. The error code and message are written to stderr. |
| `130` | Received `SIGINT` (Ctrl-C). The last assistant text is still written to stdout before exit. |
| `143` | Received `SIGTERM`. Same flush as above. |

## How it works

`cordis.patch.yml` declares two extra rows for the headless profile:

- `loop-startup` — a thin commander program that parses the positional
  `task` plus the loop-only flags and publishes a `loopStartup` service
  holding the resolved values.
- `loop-runner` — replaces the default one-shot runner. It creates one
  Agent through the core registry, sends the first user message, then
  loops: `await agent.whenIdle()`, slice the durable session log between
  the previous `turn/end` and the latest tail to recover the round's
  assistant text, render the continuation template, and call
  `agent.followup(createUserMessage(...))` to start the next round. The
  loop ends on maxRounds, a matched phrase, a turn-level error, or an
  external signal; the runner flushes the session, writes the last
  answer to stdout, and requests a clean exit through the launcher's
  `appExit` service.

The default `headless-runner` row is set to `disabled: true`, so installing
this bundle fully replaces the one-shot behavior. Uninstalling
(`dsh plugin --profile headless remove @tyza66/dsh-loop-agent`) re-enables
the upstream runner on the next profile start.

## Compatibility

Built against the same `@deepseek-ai/dsh-*` 0.1.1-rc.2 packages that
ship with `dsh` 0.1.1-rc.2. The peer dependencies are the same ones
`@deepseek-ai/dsh-headless` declares; `dsh-base` already provides them
in the headless profile, so no extra install step is required.

## License

MIT
