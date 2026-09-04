# dsh-loop-agent

[English](README.md) | [中文](README.zh.md)

A DSH profile bundle for the **web profile** that turns every agent into an
**endless same-session loop**: after every final assistant answer, the loop
automatically injects a user-configurable continuation prompt at the next
turn boundary, forever.

The same Agent and the same Session live for the whole run, so every round
sees the full accumulating transcript — only the *next* user message is
replaced by the template. **User messages take priority**, enforced at
three layers: steering input (Cmd/Ctrl+Enter) lands in `next-step` and
the inbox's `claim("next-turn")` always pulls `next-step` first, so a
steer jumps ahead of everything; ordinary Enter input lands in the same
`next-turn` queue as the continuation, but the agent loop drains the
queue at every turn boundary before going idle, and the loop only queues
a continuation after `whenIdle()` **and** after checking that no real
user message is pending in the inbox — a queued user input always runs
before the next continuation does. If nothing human is queued, the
continuation runs and the loop keeps going forever.

The loop never exits on its own. Any failure — turn-level LLM error, a
thrown exception, even a transient context overflow — falls through to
exponential backoff and the prompt that triggered the failed round is
**actually re-sent** (retries never give up: once the ladder hits the
`maxBackoffMs` cap, it keeps retrying at that interval until a turn
succeeds; a message you send while a retry is asleep supersedes the stale
one). Even a mid-error process restart heals itself — a fresh driver that
finds a stalled error round replays the last user message that led into it
and keeps retrying. There are exactly three exits: the user clicks the
**stop** button in a conversation (that round's `turn/end` arrives as
`aborted`, and the driver halts on the spot instead of queueing the next
continuation — the "manual stop" of "endless until you manually stop"),
the conversation is **archived** in the UI (archiving hides a session
without disposing its agent, so the supervisor polls the workspace
registry's archive set and halts — and cancels — any driver whose session
got archived, so a hidden conversation never burns tokens in the
background), or the agent leaves the live registry (conversation deleted,
or the profile restarted). A turn merely preempted by an interjected user
message (`interrupted`) does not exit the loop — it waits for that exchange
to settle and resumes. The loop is paired with 80% auto-compaction and the
`/compact` command, so a long run is bounded by neither tokens nor rounds;
only your willingness to let it run.

## Install

```sh
dsh plugin --profile web add https://github.com/tyza66/dsh-loop-agent
```

Then start the web profile as usual. A supervisor on the host polls the
live agent registry once per second and attaches a driver to every
top-level (root) agent — new conversations take effect immediately, and
restored historical sessions are re-attached after a restart too (but a
session that has been idle longer than `idleGraceMs` waits for the user
to speak first instead of auto-continuing and burning tokens).
Subagents (anything spawned under a parent owner context — dsh-subagent
tasks, in-agent helpers, ...) are left alone: no driver, no auto-answer,
no auto-approve; they are scoped, ephemeral helpers, not conversations
the user can see in the message list. User messages still go through
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

**Stop one conversation** — if a single conversation is running away, click
its **stop** button. That conversation halts on the spot: the driver sees
the `aborted` turn/end and stops instead of queueing the next continuation,
so the conversation goes back to plain question-and-answer while the global
switch stays on and every other conversation keeps looping. To re-arm that
conversation into the endless run:
- Type `/forever` in the chat box (case-insensitive, leading/trailing
  whitespace ignored) — only works when the global switch is on
- Toggle the switch **off and on** (enable sweeps halted conversations and
  reattaches drivers)
- Restart the profile

**Archive stops it too** — archiving a conversation (the **Archive session**
action in its context menu) halts its loop just as fast, and cancels whatever
reply is in flight. Archiving never disposes the agent or session — it only
hides the session from every grouping surface — so without an explicit stop
the loop would keep spending tokens on a conversation you can no longer see.
The supervisor compares each live agent against `dsh-workspace`'s
`archivedSessionIds` every second: archived sessions never get a driver, and
a driver whose session was just archived is disarmed on the spot. Unarchiving
does not auto-resume: to re-arm, type `/forever` after unarchiving, toggle
the loop **off and on** (sessions still archived are skipped by the re-arm
sweep), or restart the profile.

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

## Auto-default for mid-run interaction

An endless run should not park on a human click. While the loop is on, three
kinds of interaction that would otherwise stall the run are handled
automatically — and only for agents this plugin is actively driving (loop
on, driver armed); sessions you are chatting with directly keep the normal
ask/approve UI:

- **Option questions** (`ask_user_question`) are answered automatically and
  fed back to the model as a normal tool result, no card shown: the option
  marked `(推荐)` / `(Recommended)` wins (half- and full-width parentheses,
  case-insensitive), a `plan-review` intent approves its `approve` option,
  and a question with no marker falls back to its first option per the
  recommended-first convention.
- **Free-text questions** (an `ask_user_question` item with no options) are
  answered with a standing *autonomy grant* — `(无人值守自动应答)` — that
  tells the model nobody is here to type: decide from context and tool
  results, state your assumption when information is genuinely missing, and
  keep going. This is deliberately **not** a fake human reply. Granting it
  is a real autonomy decision — the model will act on information nobody
  actually typed — so turn it off (`autoAnswerFreeText: false`) for runs
  you want to stay on a leash; questions then go to the human and the run
  parks until answered.
- **One-shot approvals** (sandbox escalation, etc.) resolve as
  `allowed-once` immediately, with the `approval/asked` + `approval/decided`
  audit pair still written; sessions whose approval policy is `never` still
  reject every ask.

All three can be turned off with the row config
`autoAnswerQuestions: false` / `autoAnswerFreeText: false` /
`autoApproveActions: false`.

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
| `GET`  | `/api/loop-agent/state`   | — | `{ version, enabled, attachedAgents, profile, continuation, defaultContinuation }` |
| `POST` | `/api/loop-agent/enabled` | `{ "enabled": boolean }` | snapshot + `{ path, changed }` |
| `POST` | `/api/loop-agent/continuation` | `{ "continuation": string }` | snapshot + `{ path, changed }` |

`attachedAgents` counts the **top-level** conversations that currently hold
a live, armed driver on the host scope — sessions stopped by the user or
archived are disarmed and excluded, and the count is 0 while the loop
switch is off (an off switch parks every driver at the disabled gate, so
reporting "N running" would be a lie). Subagents (anything spawned under a
parent owner context — dsh-subagent tasks, in-agent helpers, ...) are
deliberately excluded: they are scoped, ephemeral helpers, not
conversations a user can see in the message list, and the loop default is
to leave them alone (no driver, no auto-answer, no auto-approve). The
settings page polls `/state` every 2 seconds, so the number shown stays
live as sessions are archived, stopped, or created.
`continuation` is the effective prompt
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
| `autoAnswerQuestions` | `true` | Auto-answer `ask_user_question` option items for driven agents while the loop is on: recommended-marked option → `plan-review` approve → first option. |
| `autoAnswerFreeText` | `true` | Auto-answer free-text `ask_user_question` items (no options) with the standing "unattended — decide autonomously" grant instead of parking the run on a human. Requires `autoAnswerQuestions`; off falls back to showing the question. |
| `autoApproveActions` | `true` | Auto-grant one-shot approvals (`allowed-once`) for driven agents while the loop is on; the audit pair is still written. A `never` approval policy still rejects. |
| `escalateAfterFailures` | `3` | After this many consecutive failures of the same retry prompt, the identical resend is replaced by an escalation prompt carrying the latest error code + message so the model routes around the failing operation. Further failures keep producing fresher escalation prompts until a turn completes (the chain then resets). `0` disables escalation (pure identical resends forever). |

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
polls `ctx.agents.roots()` and gives every not-yet-attached **top-level**
agent a fire-and-forget driver task that:

1. `await agent.whenIdle()` — wait for the current turn (if any) to finish.
2. Slice the durable session log between the previous `turn/end` and the
   current tail to recover the round's assistant text. A driver born over
   an existing session (attach, restart, or re-enable after a stop) seeds
   its boundary past stale `aborted`/`interrupted` turn/ends — so re-enable
   never re-halts on a stop that predates the driver — and starts consuming
   at the second-to-last finished round, so `{{lastAnswer}}` holds one
   round's text, not the whole transcript.
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
