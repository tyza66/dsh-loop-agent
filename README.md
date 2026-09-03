# dsh-loop-agent

[English](README.md) | [中文](README.zh.md)

A DSH profile bundle for the **web profile** that turns every agent into an
**endless same-session loop**: after every final assistant answer, the loop
automatically injects a user-configurable continuation prompt at the next
turn boundary, forever.

The same Agent and the same Session live for the whole run, so every round
sees the full accumulating transcript — only the *next* user message is
replaced by the template. **User messages take priority by inbox
construction**: client input lands in `next-step` (steer / inject) while the
loop's continuation lands in `next-turn` (followup), and the inbox's
`claim("next-turn")` order always pulls `next-step` first.

The loop never exits on its own. Any failure — turn-level LLM error, a
thrown exception, even a transient context overflow — falls through to
exponential backoff and the previous round's prompt is re-sent. The only
exit is the session being torn down (the web UI's stop button, or the
profile being restarted). The loop is paired with 80% auto-compaction and
the `/compact` command, so a long run is bounded by neither tokens nor
rounds; only your willingness to let it run.

## Install

```sh
dsh plugin --profile web add https://github.com/tyza66/dsh-loop-agent
```

Then start the web profile as usual. Every new agent is automatically
attached to the loop. User messages still go through normally — they will
always be processed before the loop's queued continuation.

## Disable

The bundle's `cordis.patch.yml` inserts the `loop-runner` row with
`disabled: false`. To turn the loop off without uninstalling the bundle,
edit your profile's user-layer patch:

```sh
$DSH_HOME/profiles/web/cordis.patch.yml      # usually ~/.dsh/profiles/web/cordis.patch.yml
```

Add (or uncomment) a row override:

```yaml
- id: loop-runner
  disabled: true
```

The user layer is applied **after** the bundle's patch, so the row-level
`disabled: true` wins. Save the file and **restart the web profile**:

```sh
# kill the running web profile (Ctrl-C in its terminal, or pkill -f 'dsh.*web')
dsh --profile web        # restart; the loop is now off
```

Existing agent loops wind down on their next `agent/disposed` / `session/
disposed` — the disabled flag stops new agents from being attached, but
it does not kill agents that are already looping. Restart the profile to
stop everything cleanly.

To re-enable, set `disabled: false` (or remove the override) and restart.

## Configure

The loop's behavior is controlled by the `loop-runner` row's `config` in
your profile's user-layer patch:

```yaml
- id: loop-runner
  config:
    continuation: 'Please continue from where you left off. (Round {{round}})'
    initialBackoffMs: 1000
    maxBackoffMs: 32000
    backoffFactor: 2
    quiet: false
```

| Field | Default | Meaning |
| --- | --- | --- |
| `continuation` | `Please continue from where you left off. (Round {{round}})` | Prompt template. Supports `{{lastAnswer}}` (previous round's assistant text), `{{round}}` (1-based; round 1 is the first continuation, not the user's first message), `{{task}}` (always empty in web mode). Unknown placeholders are left intact. |
| `initialBackoffMs` | `1000` | Wait this long before the first retry of a failed round. |
| `maxBackoffMs` | `32000` | Cap on the exponential growth. After the cap, every subsequent retry waits the cap. |
| `backoffFactor` | `2` | Multiplier applied per consecutive failure. 2 = the standard 1s → 2s → 4s → 8s → 16s → 32s ladder. 1.5 = slower growth. |
| `quiet` | `false` | When true, the loop only logs warnings and errors; clean runs are silent. Default false: each round boundary logs an info line so a long run leaves a visible trace. |

Restart the web profile to apply config changes. Changing
`continuation` mid-run affects only rounds queued after the restart; the
current loop continues with the old template until the agent is disposed.

## How it works

`cordis.patch.yml` re-enables three rows that the web profile disables by
default:

- `compaction-basic` — auto-compaction at 80% of the model context window,
  retaining the most recent 16% verbatim. Wired with `auto: true,
  thresholdRatio: 0.8, retainRatio: 0.16`.
- `command-compact` — the `/compact` slash command, so the user can
  trigger an immediate compaction in addition to the auto one.
- `tool-result-pruner` — the pruner that keeps overgrown tool results
  from blocking the compactor's threshold.

It then inserts one new row, `loop-runner`, whose host-side `apply`
registers an `agent/created` hook on the host scope. Every new agent is
given a fire-and-forget driver task that:

1. `await agent.whenIdle()` — wait for the current turn (if any) to finish.
2. Slice the durable session log between the previous `turn/end` and the
   current tail to recover the round's assistant text.
3. If the round ended in an error, back off and re-send the previous
   round's prompt.
4. Otherwise, render the continuation template and `agent.followup(...)`
   it into the agent's `next-turn` inbox.
5. Loop back to step 1.

The `agent/inbox/inserted` and `next-step` priority mechanisms of the
core agent inbox guarantee that user messages are always processed
before the loop's queued continuation. The driver only acts on
`whenIdle()`, so it never preempts in-flight work; once the user stops
sending, the agent runs the queued continuation, goes idle, and the loop
queues the next one.

## Compatibility

Built against the same `@deepseek-ai/dsh-*` 0.1.1-rc.2 packages that
ship with `dsh` 0.1.1-rc.2. The peer dependencies are the same ones
the upstream web-app bundle declares; `dsh-base` already provides them
in the web profile, so no extra install step is required.

## License

MIT
