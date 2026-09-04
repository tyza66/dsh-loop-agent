import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { readDisabled, readContinuationOverride, writeDisabled, writeContinuation } from "./patch-state.js";

//#region lib/types/index.js
/**
 * @tyza66/dsh-loop-agent — endless same-session loop driver for the dsh web profile.
 *
 * Rides alongside the default web-app bundle. After every turn an agent
 * finishes, the loop injects a user-configurable continuation prompt at the
 * next turn boundary, forever. The same Agent and the same Session live for
 * the whole run, so each round sees the full accumulating transcript.
 *
 * User messages take priority by inbox construction: client input lands in
 * `next-step` while the loop's continuation lands in `next-turn`, and the
 * inbox `claim("next-turn")` order always pulls `next-step` first. The loop
 * only acts on `agent.whenIdle()`, so it cannot preempt in-flight work; once
 * the user stops sending, the agent runs the queued continuation, goes idle,
 * and the loop queues the next one.
 *
 * The loop never exits on its own. Any failure — turn-level LLM error,
 * thrown exception in the driver body, network blip that the LLM surfaces
 * as a turn error, even a transient context overflow — falls through to
 * exponential backoff and the previous round's prompt is re-sent. The only
 * exit is the session being torn down: `agent/disposed` (or a
 * `session/disposed`) observed on the host scope flips the loop's
 * `disarmed` flag, the task winds down on the next idle boundary, and the
 * fiber is released.
 *
 * Context-window pressure is *not* the loop's job. 80% / `/compact` is wired
 * by re-enabling `dsh-compaction-basic` (auto) and `dsh-command-compact`
 * in the patch; the loop and the compactor are orthogonal, and the
 * compactor runs in the same session.
 *
 * @module @tyza66/dsh-loop-agent
 */
/** Stable Cordis plugin name. */
const name = "loop-runner";

/** Service dependencies the apply step needs before registering hooks. */
const inject = [
  "agents",
  /**
   * The webserver is how the browser half reaches this plugin: the client
   * calls `/api/loop-agent/{state,enabled}` and these routes translate the
   * HTTP request into the same file write the host used to do via the
   * dynamic-only `harness` channel. Static dual-face packages never see a
   * `harness` service, so the webserver is the only documented bridge.
   */
  "webServer"
];

/** Loop config: continuation template + retry pacing. */
const Config = z.object({
  /**
   * Continuation prompt template (the default; a runtime override set from
   * the Settings → Endless loop page wins when present). Plain text;
   * supports `{{lastAnswer}}` (the concatenated assistant text of the
   * previous round), `{{round}}` (1-based; round 1 is the first
   * continuation, not the user's first message), and `{{task}}` (always
   * empty in web mode, kept for parity with the headless variant).
   * Unknown placeholders are left intact.
   */
  continuation: z.string().default("继续，并深度检查暗病，遇到暗病和缺陷就修复"),
  /** Initial backoff in milliseconds for the first failure-driven retry. */
  initialBackoffMs: z.number().step(1).min(1).max(60_000).default(1000),
  /**
   * Upper cap on the exponential backoff, in milliseconds. Once retries
   * hit this, every subsequent failure waits the cap before resending.
   */
  maxBackoffMs: z.number().step(1).min(1).max(600_000).default(32_000),
  /**
   * Multiplier applied to the backoff on each successive failure. 2 means
   * the standard 1s → 2s → 4s → 8s → 16s → 32s ladder; 1.5 slows growth.
   */
  backoffFactor: z.number().min(1).max(10).default(2),
  /**
   * If true, the loop only logs at warn / error level and stays silent on
   * a clean run. If false (default), it logs an info line per round
   * boundary so a long run leaves a visible trace in `dsh` logs.
   */
  quiet: z.boolean().default(false)
});

/**
 * Render a continuation template by substituting the supported placeholders.
 * Unknown placeholders are left intact so a typo is visible in the next
 * prompt rather than silently swallowed.
 * @param template - raw template string.
 * @param values - substitution values.
 * @returns the rendered string.
 */
function renderTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = values[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return match;
  });
}

/**
 * Concatenate every assistant text block emitted between two seq boundaries
 * (inclusive of `fromSeq`, exclusive of `toSeq`) in the order they were
 * appended. Returns the empty string if the agent never produced any text
 * in that range.
 * @param events - the session's durable event log.
 * @param fromSeq - first seq to consider.
 * @param toSeq - first seq to ignore.
 * @returns concatenated assistant text, or "".
 */
function collectAssistantText(events, fromSeq, toSeq) {
  let text = "";
  for (const event of events) {
    if (event.seq < fromSeq || event.seq >= toSeq) continue;
    if (event.type !== "assistant/message") continue;
    const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
    for (const block of blocks) if (block?.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

/**
 * Find the seq of the last `turn/end` event in the range, or `null` if no
 * turn has ended yet. Used to bound the slice that becomes `lastAnswer`.
 * @param events - the session's durable event log.
 * @param fromSeq - first seq to consider.
 * @returns seq of the most recent turn/end, or null.
 */
function lastTurnEndSeq(events, fromSeq) {
  let seq = null;
  for (const event of events) {
    if (event.seq < fromSeq) continue;
    if (event.type === "turn/end") seq = event.seq;
  }
  return seq;
}

/**
 * Return the most recent `turn/end.data.reason` in a given seq range.
 * `reason.kind === "error"` is the signal the loop uses to drive retries.
 * @param events - the session's durable event log.
 * @param fromSeq - first seq to consider.
 * @returns the last `turn/end.data.reason` seen in range, or undefined.
 */
function lastTurnReason(events, fromSeq) {
  let reason;
  for (const event of events) {
    if (event.seq < fromSeq) continue;
    if (event.type === "turn/end") reason = event.data?.reason;
  }
  return reason;
}

/**
 * Sleep for `ms` milliseconds, aborting early if `signal` aborts.
 * Returns the boolean "did we sleep the full duration?".
 * @param ms - milliseconds.
 * @param signal - abort signal; resolved "true" = aborted, "false" = slept fully.
 * @returns a Promise that resolves to true if aborted, false otherwise.
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Compute the backoff for a failure on the given retry attempt (1-based).
 * Successes reset the counter; failures grow it exponentially up to the cap.
 * @param attempt - the upcoming retry number, 1-based.
 * @param config - validated loop config.
 * @returns milliseconds to wait.
 */
function backoffMs(attempt, config) {
  // attempt 1 → initialBackoffMs; attempt 2 → initial*factor; ... capped at max.
  const raw = config.initialBackoffMs * Math.pow(config.backoffFactor, attempt - 1);
  return Math.min(raw, config.maxBackoffMs);
}

/**
 * Per-agent loop state. `disarmed` is the one-way kill switch the
 * `agent/disposed` and `session/disposed` listeners flip; the loop body
 * checks it between phases so a disarmed loop never re-queues a
 * continuation after the user has torn the session down. `profile` is the
 * profile name the driver reads `readDisabled()` against each phase, so a
 * runtime disable flips the loop into an inert idle without unmounting the
 * plugin (unmounting would also take the webserver routes offline and turn
 * the settings switch into a one-way trip).
 */
var LoopState = class {
  agent;
  config;
  profile;
  abort;
  disarmed = false;
  consecutiveFailures = 0;
  constructor(agent, config, profile) {
    this.agent = agent;
    this.config = config;
    this.profile = profile;
    this.abort = new AbortController();
  }
  /** Mark the loop as torn down. Idempotent. */
  disarm() {
    if (this.disarmed) return;
    this.disarmed = true;
    this.abort.abort();
  }
};

/**
 * Drive one agent through the endless loop until the host scope disposes
 * the agent or session. Every external error is caught and converted into
 * a backoff retry; the only "exit" path is `state.disarm()`.
 *
 * The function is structured as a single async tail that the caller
 * `await`s in fire-and-forget fashion — its returned promise resolves
 * when the loop is disarmed and has wound down its current step.
 *
 * @param state - per-agent loop state, shared with the dispose listeners.
 * @param logger - host logger for visibility.
 */
async function driveLoop(state, logger) {
  const { agent, config } = state;
  let round = 0;
  let lastPromptText = null;
  let lastRoundEndSeq = 0;

  while (!state.disarmed) {
    /** Runtime disabled gate: the user toggled the loop off in the
     * settings panel. The plugin stays mounted (the webserver routes the
     * UI talks to must stay live so the next toggle re-enables), so the
     * driver just sleeps here until the flag clears or the agent is torn
     * down. Polling is cheap (a single `stat` of a sidecar JSON) and the
     * wakeup is bounded by `state.abort`, so a dispose still wins. */
    if (readDisabled(state.profile)) {
      const aborted = await sleep(2000, state.abort.signal);
      if (state.disarmed) return;
      if (aborted) continue;
      continue;
    }
    /** Drive the next phase. If the inner try/catch throws we still
     * surface a clean disarm; the outer `while` re-checks the flag. */
    let phaseOutcome;
    try {
      phaseOutcome = await runOnePhase(state, agent, config, logger, {
        round,
        lastPromptText,
        lastRoundEndSeq
      });
    } catch (error) {
      logger?.warn?.(`dsh-loop-agent: phase threw for agent "${agent.id}": ${error instanceof Error ? error.message : String(error)}; backoff and retry`);
      const aborted = await sleep(backoffMs(state.consecutiveFailures + 1, config), state.abort.signal);
      if (state.disarmed) return;
      if (aborted) continue;
      state.consecutiveFailures += 1;
      continue;
    }

    if (state.disarmed) return;
    if (phaseOutcome.kind === "backoff") {
      const aborted = await sleep(backoffMs(state.consecutiveFailures + 1, config), state.abort.signal);
      if (state.disarmed) return;
      if (aborted) continue;
      state.consecutiveFailures += 1;
      lastPromptText = phaseOutcome.retryPrompt;
      continue;
    }
    if (phaseOutcome.kind === "exited") return;
    /* phaseOutcome.kind === "continued" */
    state.consecutiveFailures = 0;
    round = phaseOutcome.nextRound;
    lastPromptText = phaseOutcome.nextPrompt;
    lastRoundEndSeq = phaseOutcome.nextRoundEndSeq;
    if (!config.quiet) {
      logger?.info?.(`dsh-loop-agent: agent "${agent.id}" round ${round} queued (${phaseOutcome.lastAnswerLength} chars of assistant text consumed)`);
    }
  }
}

/**
 * One full phase of the loop: wait for the agent to go idle, slice the
 * session log to find the round's final assistant text, decide whether to
 * backoff-retry (turn error) or queue the next continuation.
 *
 * Returning `null` or a clean object keeps the driver's tail simple; the
 * driver is responsible for sleeping and updating the retry counter.
 *
 * @param state - per-agent loop state.
 * @param agent - the agent being driven.
 * @param config - validated loop config.
 * @param logger - host logger.
 * @param cursor - round counter, last prompt text, and last `turn/end` seq.
 * @returns outcome describing what the driver should do next.
 */
async function runOnePhase(state, agent, config, logger, cursor) {
  const { round, lastPromptText, lastRoundEndSeq } = cursor;
  /** Wait for the in-flight work to settle. The host loop's `kick()` already
   * swallows every internal error, so a throw here is a hard fault in the
   * agent driver itself; the outer catch in `driveLoop` will backoff-retry. */
  await agent.whenIdle();
  if (state.disarmed) return { kind: "exited" };

  const events = agent.session.events;
  const tailSeq = events.length === 0 ? 0 : (events.at(-1).seq + 1);
  const turnEnd = lastTurnEndSeq(events, lastRoundEndSeq);
  const sliceEnd = turnEnd !== null ? turnEnd + 1 : tailSeq;
  const lastAnswer = collectAssistantText(events, lastRoundEndSeq, sliceEnd);
  const reason = lastTurnReason(events, lastRoundEndSeq);

  // Failure path: the round ended in an error. Resend the prompt that
  // triggered the failed round — never the previous successful one. If
  // we don't have a `lastPromptText` yet (e.g. the very first turn
  // failed before the user sent anything), we have nothing to resend and
  // the loop will simply wait for the next user message; that's fine
  // because `whenIdle()` will keep resolving as the inbox drains.
  if (reason?.kind === "error" && lastPromptText !== null) {
    const code = reason?.error?.code ?? "unknown";
    const message = reason?.error?.message ?? "(no message)";
    logger?.warn?.(`dsh-loop-agent: turn error on agent "${agent.id}" (code=${code}): ${message}; backoff and retry the same prompt`);
    return {
      kind: "backoff",
      retryPrompt: lastPromptText
    };
  }

  // Success path: render the next continuation from the just-finished
  // round's assistant text and queue it for the next turn. The template is
  // resolved fresh each phase so a Settings-page override (sidecar) lands
  // on the very next continuation without a restart. Round numbering is
  // 1-based and counts continuations only — round 1 is the first
  // continuation, not the user's first message.
  const nextRound = round + 1;
  const template = readContinuationOverride(state.profile) ?? config.continuation;
  const nextPrompt = renderTemplate(template, {
    lastAnswer,
    round: nextRound,
    task: ""
  });
  agent.followup(createUserMessage({
    content: [{ type: "text", text: nextPrompt }],
    source: { kind: "user" }
  }));
  return {
    kind: "continued",
    nextRound,
    nextPrompt,
    nextRoundEndSeq: sliceEnd,
    lastAnswerLength: lastAnswer.length
  };
}

/**
 * Mount the endless same-session loop driver.
 *
 * Registers `agent/created` and `agent/disposed` / `session/disposed` hooks
 * on the host scope. Each new agent is given its own loop task; the tasks
 * are tracked in a per-plugin `Map<Agent, LoopState>` so disarming on
 * disposal is O(1). All hooks live in a single `ctx.effect` so the cordis
 * fiber unwinds them together when the bundle is uninstalled.
 *
 * @param ctx - plugin context carrying the agents service and a logger.
 * @param config - validated loop config.
 */
function apply(ctx, config) {
  const logger = ctx.logger;
  /** Per-agent state, keyed by the agent object reference. The map is
   * cleared in the dispose listener, so memory grows only with the
   * number of live agents on the host scope. */
  const states = new Map();

  /* Name of the profile this row is mounted in, when the launcher says.
   * The browser half needs it to find the right patch file; absent it,
   * the default `web` is what this bundle targets. */
  const profile = ctx.get("appProfile")?.name ?? "web";

  /**
   * The state the browser settings section reads and writes.
   *
   * `enabled` mirrors the sidecar's `disabled` flag, and `continuation`
   * is the effective prompt the driver uses next round — the runtime
   * override from the sidecar when one is set, otherwise the row's
   * configured `config.continuation` default. Both are runtime values,
   * not mount state: the plugin stays mounted and the driver polls them
   * per phase.
   */
  const store = {
    /** True when the sidecar does not disable the loop. */
    get enabled() {
      return !readDisabled(profile);
    },
    /** Effective continuation: runtime override, else the config default. */
    get continuation() {
      return readContinuationOverride(profile) ?? config.continuation;
    },
    /** How many agents currently have a live driver task. */
    get attachedAgents() {
      return states.size;
    }
  };
  ctx.provide("loopConfig", store);

  /**
   * Client→Host bridge: three webserver routes the browser half calls from
   * its settings section. The contract is a stable JSON shape; the host
   * side always answers with the current snapshot plus a `path` / `changed`
   * pair for writes, so the UI can tell the user exactly which file the
   * change landed in.
   */
  const STATE_PATH = "/api/loop-agent/state";
  const ENABLED_PATH = "/api/loop-agent/enabled";
  const CONTINUATION_PATH = "/api/loop-agent/continuation";

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload)
    });
    res.end(payload);
  }

  function readSnapshot() {
    return {
      enabled: store.enabled,
      attachedAgents: store.attachedAgents,
      profile,
      continuation: store.continuation,
      defaultContinuation: config.continuation
    };
  }

  /**
   * Drain a bounded JSON request body. Responds with an error status and
   * returns `null` when the body is too large or not valid JSON; otherwise
   * returns the parsed object (possibly empty).
   */
  async function readJsonBody(req, res) {
    const MAX = 64 * 1024;
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX) {
        sendJson(res, 413, { error: "payload too large" });
        return null;
      }
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      sendJson(res, 400, { error: "invalid json" });
      return null;
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: STATE_PATH,
    handler: (req, res) => {
      if (req.method !== "GET") {
        res.writeHead(405, { allow: "GET" });
        res.end();
        return;
      }
      sendJson(res, 200, readSnapshot());
    }
  }), "dsh-loop-agent: GET /api/loop-agent/state");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: ENABLED_PATH,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" });
        res.end();
        return;
      }
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const enabled = body?.enabled === true;
      const result = writeDisabled(!enabled, profile);
      logger?.info?.(`dsh-loop-agent: endless loop ${enabled ? "enabled" : "disabled"}; takes effect within seconds (sidecar ${result.path})`);
      sendJson(res, 200, {
        ...readSnapshot(),
        path: result.path,
        changed: result.changed
      });
    }
  }), "dsh-loop-agent: POST /api/loop-agent/enabled");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: CONTINUATION_PATH,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" });
        res.end();
        return;
      }
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (typeof body?.continuation !== "string") {
        sendJson(res, 400, { error: "continuation must be a string" });
        return;
      }
      const cleared = body.continuation.trim() === "";
      const result = writeContinuation(body.continuation, profile);
      logger?.info?.(`dsh-loop-agent: continuation ${cleared ? "reset to the config default" : "override saved"}; takes effect on the next round (sidecar ${result.path})`);
      sendJson(res, 200, {
        ...readSnapshot(),
        path: result.path,
        changed: result.changed
      });
    }
  }), "dsh-loop-agent: POST /api/loop-agent/continuation");

  ctx.effect(function* () {
    const cancelOnDispose = ctx.on("agent/disposed", ({ agent }) => {
      const state = states.get(agent);
      if (state === void 0) return;
      state.disarm();
      states.delete(agent);
      logger?.info?.(`dsh-loop-agent: agent "${agent.id}" disposed; loop wound down`);
    });
    const cancelOnSessionDispose = ctx.on("session/disposed", () => {
      /* Session disposal means the agent's session is gone; the agent
       * will fire `agent/disposed` next, but disarm everything anyway so
       * a session kill that does not produce an `agent/disposed` still
       * stops every loop bound to it. */
      for (const state of states.values()) state.disarm();
      states.clear();
    });
    const onCreated = ctx.on("agent/created", ({ agent }) => {
      /* The agent may already be in the map if a previous listener ran
       * first; idempotent install keeps double-mount from doubling the
       * queue rate. */
      if (states.has(agent)) return;
      const state = new LoopState(agent, config, profile);
      states.set(agent, state);
      logger?.info?.(`dsh-loop-agent: agent "${agent.id}" loop attached`);
      driveLoop(state, logger).catch((error) => {
        logger?.warn?.(`dsh-loop-agent: driver task for agent "${agent.id}" rejected: ${error instanceof Error ? error.message : String(error)}`);
        state.disarm();
        states.delete(agent);
      });
    });
    try {
      yield;
    } finally {
      cancelOnDispose();
      cancelOnSessionDispose();
      onCreated();
      for (const state of states.values()) state.disarm();
      states.clear();
    }
  });
}
//#endregion
export { Config, apply, inject, name };
