import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

//#region lib/types/index.js
/**
 * @tyza66/dsh-loop-agent — endless same-session loop driver.
 *
 * Rides over dsh-base like `@deepseek-ai/dsh-headless` does, but instead of
 * printing the final answer and exiting it re-injects a user-configurable
 * continuation prompt at the next turn boundary, forever. One Agent and one
 * Session live for the whole run, so each round sees the full accumulating
 * transcript; only the user message at the start of the next round is
 * replaced by the template.
 *
 * The loop ends on:
 *   - a matching exit phrase in the last assistant text (see `exitPhrases`),
 *   - reaching `maxRounds` rounds (counting the very first task as round 1),
 *   - SIGINT / SIGTERM, which prints the last answer and exits 130 / 143.
 *
 * @module @tyza66/dsh-loop-agent
 */
/** Stable Cordis plugin name. */
const name = "loop-runner";

/** Core services required before the loop can start. */
const inject = [
  "agentDefaultModel",
  "agents",
  "sessions"
];

/** Bundle config: task + loop behavior. Values arrive from the loopStartup service. */
const Config = z.object({
  /** The first user message; the loop runs at least one round on it. */
  task: z.string().required(),
  /**
   * The prompt sent at the start of every round after the first. Plain text;
   * supports `{{task}}`, `{{lastAnswer}}`, `{{round}}`, `{{turn}}` (1-based
   * within the current loop pass — round 2 = first continuation, etc.).
   * `{{lastAnswer}}` is the concatenated assistant text of the previous
   * round (empty string on round 1, where it is unused).
   */
  continuation: z.string().default("Please continue from where you left off. (Round {{round}})"),
  /**
   * Hard upper bound on rounds. `0` (the default) means "no cap"; the loop
   * runs until a phrase matches, an external signal arrives, or the user
   * presses Ctrl-C. A positive integer caps the number of user turns sent
   * to the model, including the first task.
   */
  maxRounds: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  /**
   * Optional list of case-insensitive substrings. If the last assistant text
   * of a round contains any of them (after trim), the loop prints the text
   * and exits 0. Empty array (the default) disables the check.
   */
  exitPhrases: z.array(z.string()).default([]),
  /**
   * Suppress the per-round header line on stderr. The final answer is still
   * printed on stdout once, on exit. Off by default so a long loop leaves a
   * visible trace.
   */
  quiet: z.boolean().default(false)
});

/** Process streams the runner writes to. Tests can substitute captures. */
const internals = {
  stdout: process.stdout,
  stderr: process.stderr
};

/**
 * Render a continuation template by substituting the supported placeholders.
 * Unknown placeholders are left intact so a typo is visible in the prompt
 * rather than silently swallowed.
 * @param template - raw template string.
 * @param values - substitution values.
 * @returns the rendered string.
 */
function renderTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = values[key];
    return typeof value === "string" ? value : match;
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
 * turn has ended yet. Used both to wait for quiescence (a turn must end
 * after our followup) and to bound the slice that becomes `lastAnswer`.
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
 * Report an unexpected startup failure and request a failing exit.
 * @param io - process-facing effects.
 * @param error - thrown error or other value.
 */
function failStartup(io, error) {
  io.stderr.write(`dsh-loop-agent: ${error instanceof Error ? error.message : String(error)}\n`);
  io.exit(1);
}

/**
 * Find the most recent `turn/end` `reason` in a given seq range, used to
 * decide between exit code 0 and 1 on a normal end-of-loop.
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
 * Run the endless loop on a freshly created Agent.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param config - validated loop config.
 * @param io - process-facing effects.
 */
async function run(ctx, config, io) {
  await ctx.get("loader")?.await();
  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  const sessions = ctx.get("sessions");
  if (agents === void 0 || defaultModel === void 0 || sessions === void 0) return;

  const selection = defaultModel.currentSelection();
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: {
      provider: selection.provider,
      model: selection.model
    },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, {
        current: selection,
        assembled: void 0
      });
    }
  });

  /** Sliding window: [roundStartSeq, currentLength) is "this round so far". */
  let roundStartSeq = agent.session.seq;
  let lastAnswer = "";
  let round = 0;
  /** Set by SIGINT / SIGTERM so the loop can flush and exit cleanly. */
  let signalExit = null;
  /** Exit requested by reaching maxRounds or matching a phrase; null = keep going. */
  let voluntaryExit = null;

  const onSignal = (code, signalName) => {
    if (signalExit !== null) return;
    signalExit = { code, signalName };
  };
  const sigintHandler = () => onSignal(130, "SIGINT");
  const sigtermHandler = () => onSignal(143, "SIGTERM");
  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);

  try {
    while (voluntaryExit === null && signalExit === null) {
      round += 1;
      const isFirst = round === 1;
      const promptText = isFirst
        ? config.task
        : renderTemplate(config.continuation, {
            task: config.task,
            lastAnswer,
            round,
            turn: round
          });
      if (!config.quiet) {
        io.stderr.write(`\n── dsh-loop-agent: round ${round}${isFirst ? " (initial task)" : ""} ──\n`);
      }
      agent.followup(createUserMessage({
        content: [{ type: "text", text: promptText }],
        source: { kind: "user" }
      }));
      await agent.whenIdle();

      // Slice the durable log up to the agent's current tail so we capture
      // every assistant message produced by the round we just sent, even if
      // the agent emitted several assistant turns in response to the one
      // user message.
      const tailSeq = agent.session.seq;
      const turnEnd = lastTurnEndSeq(agent.session.events, roundStartSeq);
      const sliceEnd = turnEnd !== null ? turnEnd + 1 : tailSeq;
      lastAnswer = collectAssistantText(agent.session.events, roundStartSeq, sliceEnd);
      const reason = lastTurnReason(agent.session.events, roundStartSeq);
      roundStartSeq = sliceEnd;

      if (config.maxRounds > 0 && round >= config.maxRounds) {
        voluntaryExit = { kind: "max-rounds", code: 0 };
        break;
      }
      if (config.exitPhrases.length > 0) {
        const probe = lastAnswer.toLowerCase();
        const matched = config.exitPhrases.find((phrase) => probe.includes(phrase.toLowerCase()));
        if (matched !== void 0) {
          voluntaryExit = { kind: "exit-phrase", code: 0, matched };
          break;
        }
      }
      if (reason?.kind === "error") {
        voluntaryExit = { kind: "turn-error", code: 1, reason };
        break;
      }
    }
  } catch (error) {
    failStartup(io, error);
    return;
  } finally {
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigtermHandler);
  }

  // Flush whatever the session accumulated so a SIGINT during a long run
  // still leaves a recoverable trace on disk.
  try {
    await sessions.flush(agent.session);
  } catch {
    /* best-effort; a flush failure must not mask the loop's actual exit reason */
  }

  // One last assistant-text dump, regardless of which exit branch we took.
  io.stdout.write(`${lastAnswer}\n`);

  if (signalExit !== null) {
    io.stderr.write(`\ndsh-loop-agent: received ${signalExit.signalName}; exiting with last answer above.\n`);
    io.exit(signalExit.code);
    return;
  }
  if (voluntaryExit?.kind === "exit-phrase") {
    io.stderr.write(`\ndsh-loop-agent: exit phrase "${voluntaryExit.matched}" matched on round ${round}; exiting.\n`);
    io.exit(0);
    return;
  }
  if (voluntaryExit?.kind === "turn-error") {
    const err = voluntaryExit.reason?.error;
    io.stderr.write(`\ndsh-loop-agent: turn ended with error${err ? ` (${err.code ?? "unknown"}: ${err.message ?? "?"})` : ""}; exiting.\n`);
    io.exit(1);
    return;
  }
  // max-rounds or uncaught-but-clean completion.
  io.exit(voluntaryExit?.code ?? 0);
}

/**
 * Mount the endless same-session loop driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated loop config.
 */
function apply(ctx, config) {
  const exit = ctx.get("appExit");
  if (exit === void 0) throw new Error("loop-runner: the launcher must provide ctx.appExit before the tree mounts");
  const io = {
    stdout: internals.stdout,
    stderr: internals.stderr,
    exit
  };
  run(ctx, config, io).catch((error) => {
    failStartup(io, error);
  });
}
//#endregion
export { Config, apply, inject, internals, name };
