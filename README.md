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
exit is the agent leaving the live registry (the web UI stopping or
deleting the session, or the profile being restarted). The loop is paired
with 80% auto-compaction and the `/compact` command, so a long run is
bounded by neither tokens nor rounds; only your willingness to let it run.

## Install

```sh
dsh plugin --profile web add https://github.com/tyza66/dsh-loop-agent
```

Then start the web profile as usual. A supervisor on the host polls the
live agent registry once per second and attaches a driver to every agent —
new conversations take effect immediately, and restored historical
sessions are re-attached after a restart too (but a session that has been
idle longer than `idleGraceMs` waits for the user to speak first instead
of auto-continuing and burning tokens). User messages still go through
normally — they will always be processed before the loop's queued
continuation.

The bundle also ships a browser half: an **Endless loop** entry in the
web UI's Settings sidebar. The switch there is the everyday on/off
control; the patch-file override is the escape hatch. See [Disable](#disable).

## Disable

**In-app (recommended)** — open **Settings → Endless loop** and flip the
switch. The plugin stays mounted; the driver polls a sidecar JSON at
`$DSH_HOME/profiles/<profile>/.dsh-loop-agent.json` and stops queuing
continuations within ~2 seconds of the toggle. Flipping it back resumes
the loop on the same agents. No profile restart is required; the change
takes effect on the next turn boundary.

**Hard kill (escape hatch)** — to take the plugin down entirely (no
settings section, no per-agent loop tasks, no HTTP routes), add a row
override to your profile's user-layer patch:

```sh
$DSH_HOME/profiles/web/cordis.patch.yml      # usually ~/.dsh/profiles/web/cordis.patch.yml
```

```yaml
- id: loop-runner
  disabled: true
```

The user layer is applied **after** the bundle's patch, so the row-level
`disabled: true` wins. Restart the web profile to apply:

```sh
# kill the running web profile (Ctrl-C in its terminal, or pkill -f 'dsh.*web')
dsh --profile web        # restart; the loop is now off
```

`disabled` only stops new continuations from being queued; it does not
kill agents that are already looping. Existing loops wind down the next
time the supervisor sees the agent leave the registry. To re-enable, set
`disabled: false` (or remove the override) and restart.

## Where the state lives

The in-app controls (the enable switch and the continuation-prompt editor)
write to:

```
$DSH_HOME/profiles/<profile>/.dsh-loop-agent.json
```

The file is plain JSON; a missing or unreadable file means "enabled, no
prompt override":

```json
{ "disabled": false, "updatedAt": "2026-09-04T00:00:00.000Z" }
```

You can also hand-edit this file. The driver re-reads it on every phase
boundary, so a change takes effect within ~2 seconds without a restart.

The browser half reaches the host through three webserver routes the host
half registers on `ctx.webServer`:

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET`  | `/api/loop-agent/state`   | — | `{ enabled, attachedAgents, profile, continuation, defaultContinuation }` |
| `POST` | `/api/loop-agent/enabled` | `{ "enabled": boolean }` | snapshot + `{ path, changed }` |
| `POST` | `/api/loop-agent/continuation` | `{ "continuation": string }` | snapshot + `{ path, changed }` |

`attachedAgents` is the live count of agents currently holding a running
driver task on the host scope. `continuation` is the effective prompt
(runtime override if set, else the configured default);
`defaultContinuation` is the row-config default. `path` is the sidecar
file the write landed in; `changed` is `false` when the new value
matched the file.

The state file may carry an override alongside `disabled`:

```json
{ "disabled": false, "continuation": "继续，并深度检查暗病，遇到暗病和缺陷就修复", "updatedAt": "2026-09-04T00:00:00.000Z" }
```

Remove `continuation` (or set it to an empty string) to fall back to the
row-config default.

## Configure

The loop's behavior is controlled by the `loop-runner` row's `config` in
your profile's user-layer patch:

```yaml
- id: loop-runner
  config:
    continuation: '继续，并深度检查暗病，遇到暗病和缺陷就修复'
    initialBackoffMs: 1000
    maxBackoffMs: 32000
    backoffFactor: 2
    quiet: false
```

| Field | Default | Meaning |
| --- | --- | --- |
| `continuation` | `继续，并深度检查暗病，遇到暗病和缺陷就修复` | Default prompt template. Supports `{{lastAnswer}}` (previous round's assistant text), `{{round}}` (1-based; round 1 is the first continuation, not the user's first message), `{{task}}` (always empty in web mode). Unknown placeholders are left intact. A runtime override set from **Settings → Endless loop** wins over this default until it is cleared. |
| `initialBackoffMs` | `1000` | Wait this long before the first retry of a failed round. |
| `maxBackoffMs` | `32000` | Cap on the exponential growth. After the cap, every subsequent retry waits the cap. |
| `backoffFactor` | `2` | Multiplier applied per consecutive failure. 2 = the standard 1s → 2s → 4s → 8s → 16s → 32s ladder. 1.5 = slower growth. |
| `idleGraceMs` | `300000` | On every dsh boot the supervisor re-attaches every restored historical session. If a session's most recent event is older than this window (default 5 minutes), the loop waits for a fresh user message before auto-continuing, so a restart cannot set every old session burning tokens at once. `0` disables the guard (stale sessions resume immediately). |
| `quiet` | `false` | When true, the loop only logs warnings and errors; clean runs are silent. Default false: each round boundary logs an info line so a long run leaves a visible trace. |

Config changes to the retry fields need a profile restart to apply. The
continuation template is re-read at every turn boundary: a runtime
override lands on the very next round without a restart, and changing
`config.continuation` in the patch affects rounds queued after the next
restart.

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

It then inserts one new row, `loop-runner`. Its host-side `apply` starts a
**registry supervisor** (`ctx.effect` + a 1-second `setInterval`) that
polls `ctx.agents.list()` and gives every not-yet-attached agent a
fire-and-forget driver task that:

1. `await agent.whenIdle()` — wait for the current turn (if any) to finish.
2. Slice the durable session log between the previous `turn/end` and the
   current tail to recover the round's assistant text.
3. If the round ended in an error, back off and re-send the previous
   round's prompt.
4. Otherwise, render the continuation template and `agent.followup(...)`
   it into the agent's `next-turn` inbox.
5. Loop back to step 1.

**Why polling instead of an `agent/created` event**: every dsh agent
lifecycle event (`agent/created` / `agent/disposed` / `session/disposed`)
is scope-filtered (`this: Scoped<Agent>`, see `dsh-agent`'s
runtime-types) — it dispatches only to listeners registered inside that
agent's own scope chain. A third-party plugin sitting on the root context
never receives `ctx.on("agent/created", ...)`. The official
`dsh-agent-loop` can rely on those events only because it IS the agent
factory (`agents.setFactory()`) and registers inside each agent's scope.
The only public surface a root-context plugin can depend on is the agent
registry itself — `ctx.agents.list()` shows every live agent regardless
of scope — so the supervisor polls it once a second and de-duplicates by
agent reference (`agent.whenIdle()` / `agent.followup()` are public
methods and need no scope). An agent leaving the registry is likewise
discovered by polling (it disappears from `list()` → the driver is
disarmed), which replaces the never-delivered `agent/disposed` signal.

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
