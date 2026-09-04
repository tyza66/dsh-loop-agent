import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { readFileSync } from "node:fs";
import { readDisabled, readContinuationOverride, writeDisabled, writeContinuation } from "./patch-state.js";

/**
 * This bundle's own version, read once at module load from the package.json
 * that ships next to this file. Single source of truth: the settings panel
 * shows exactly what `npm publish` shipped, never a hardcoded copy that can
 * drift. Degrades to null when the manifest is unreadable (e.g. a bundler
 * strips it) so the client can simply hide the badge.
 */
const BUNDLE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? null;
  } catch {
    return null;
  }
})();

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
 * exits are the user clicking the stop button during a turn (the round ends
 * `aborted` and the driver halts — "endless until the user manually
 * stops"), the agent leaving the live registry (the supervisor observes
 * that by polling `agents.list()`, which is the replacement for the
 * scope-filtered `agent/disposed` event that a root plugin never receives)
 * or the host tearing the plugin down. Archiving a conversation in the UI
 * also stops its run: archiving never disposes the agent, so without the
 * check below the loop would keep burning tokens on a hidden session — the
 * supervisor polls the workspace registry's archive set and halts (and
 * cancels) any driver whose session is archived. A turn preempted by a new
 * user message (`interrupted`) is neither — the driver waits for that turn
 * to settle and resumes, so an interjected question does not kill the run.
 *
 * Mid-run interaction is auto-defaulted so an endless run never parks on a
 * human: while the loop is enabled, a question the agent asks through
 * `ask_user_question` is answered with the recommended option (label
 * marker `(推荐)` / `(Recommended)`, a `plan-review` intent's approve
 * choice, or the first option), a free-text question (no options) is
 * answered with a standing "unattended — decide autonomously" grant
 * (`autoAnswerFreeText`, never a fake human reply), and a tool call that
 * needs one-shot approval is granted `allowed-once`. All of these only
 * apply to agents this plugin drives (loop on, driver armed), are
 * configurable (`autoAnswerQuestions` / `autoAnswerFreeText` /
 * `autoApproveActions`), and leave sessions the user is interacting with
 * directly on the normal ask/approve UI.
 *
 * Failed turns never end the run: the loop retries with exponential
 * backoff forever. Once the SAME retry prompt has failed
 * `escalateAfterFailures` times, the identical resend is replaced by an
 * escalation prompt carrying the latest error so the model routes around
 * the failing operation instead of repeating it; further failures keep
 * producing fresher escalation prompts until a turn completes (the failure
 * chain then resets). A turn the user aborted or an archived session still
 * halts the run — "endless until the user manually stops" is the contract.
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
   * calls `/api/loop-agent/{state,enabled,continuation}` and these routes
   * translate the HTTP request into the same file write the host used to do
   * via the dynamic-only `harness` channel. Static dual-face packages never
   * see a `harness` service, so the webserver is the only documented bridge.
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
  quiet: z.boolean().default(false),
  /**
   * How old an agent's most recent durable event may be before the loop
   * treats it as an idle historical session. On attach (every dsh boot, the
   * supervisor picks up every restored session), an agent whose last event
   * is older than this window is NOT auto-continued — it waits for a fresh
   * user message instead, so a machine restart cannot set every old session
   * burning tokens at once. An agent with a recent exchange (the normal
   * "I just sent a message" case) is continued immediately. 0 disables the
   * guard entirely.
   */
  idleGraceMs: z.number().step(1).min(0).max(86_400_000).default(300_000),
  /**
   * Auto-answer mid-run questions. While the loop is enabled, a question
   * the agent asks through `ask_user_question` is answered automatically
   * instead of stalling the run on a human: the option marked recommended
   * (label suffix `(推荐)` / `(Recommended)`) wins, a `plan-review` intent
   * is approved, and a question without any marker falls back to its first
   * option. Only agents this plugin drives (loop on, driver armed) are
   * affected; interactive sessions keep asking normally.
   */
  autoAnswerQuestions: z.boolean().default(true),
  /**
   * Auto-answer free-text questions (an `ask_user_question` item with no
   * options) while the loop is enabled. A free-text question normally
   * parks the run on a human typing an answer; with this on, the run
   * instead answers with a standing "unattended — decide autonomously"
   * notice (never a fake human reply) so the agent records its assumption
   * and moves on. This is a deliberate autonomy grant: the model will act
   * on information nobody actually typed, so only enable it for runs you
   * are willing to let steer themselves. Off falls back to showing the
   * question to the human (the run parks until answered). Requires
   * `autoAnswerQuestions` to be on as well.
   */
  autoAnswerFreeText: z.boolean().default(true),
  /**
   * Auto-approve one-shot actions while the loop is enabled. A tool call
   * that asks for approval (sandbox escalation etc.) returns
   * `allowed-once` immediately for a driven agent, so the run never parks
   * on a `blocked` turn. The audit pair (`approval/asked` +
   * `approval/decided`) is still written, and a session whose policy is
   * `never` still rejects every ask before this hook runs. Non-driven
   * sessions keep the normal approval UI.
   */
  autoApproveActions: z.boolean().default(true),
  /**
   * After this many consecutive failures of the SAME retry prompt, the
   * retry stops resending the identical text and switches to an escalation
   * prompt: it tells the model the round has failed N times and carries the
   * latest error code + message, asking it to pursue a path that does not
   * depend on the failing operation (or to report the blocker and wrap up).
   * The run never gives up — escalation prompts keep coming (each carrying
   * the freshest error) until a turn completes, after which the failure
   * chain resets. 0 disables escalation entirely (pure identical resends,
   * the pre-escalation behavior). A prompt superseded by newer activity is
   * never resent and resets the chain, so interactive sessions do not
   * escalate.
   */
  escalateAfterFailures: z.number().step(1).min(0).max(100).default(3)
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
 * Label suffix the `ask_user_question` convention uses to mark the option
 * the model recommends: put it first and append `(Recommended)` — or the
 * Chinese `(推荐)` — to the label. The web UI strips this suffix for
 * display and shows a "推荐" chip instead; the matcher here mirrors the
 * UI's own parser (half-width or full-width parentheses, case-insensitive)
 * so auto-answer picks exactly what the human would have seen marked.
 */
const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;

/** True when the label carries the recommended-option marker. */
function isRecommendedLabel(label) {
  return typeof label === "string" && RECOMMENDED_SUFFIX.test(label);
}

/** Remove the recommended marker so the answer carries the plain label. */
function stripRecommendedSuffix(label) {
  return typeof label === "string" ? label.replace(RECOMMENDED_SUFFIX, "").trim() : label;
}

/**
 * Standing answer given to a free-text question (an `ask_user_question`
 * item with no options) while unattended. It is deliberately NOT a fake
 * human reply: the model must not believe a person typed anything. It is
 * an autonomy grant — "no one is here to answer; make the call yourself,
 * state your assumption, and keep going". Rendered into the answer's
 * `custom` field, which the tool surfaces verbatim as the answer text.
 */
const FREE_TEXT_AUTO_ANSWER =
  "(无人值守自动应答) 当前循环无人值守，无法提供人工输入。请基于已有上下文与工具能力自行决策并继续；若缺少关键信息，先尝试通过工具获取，确实无法获取时明确说明你采用的假设后继续，不要停留在等待。";

/**
 * Decide automatic answers for a user-questions batch. Returns a fabricated
 * `{ answers }` payload (the exact shape `ctx.userQuestions.ask()` resolves
 * with), or null when the batch must go to a human.
 *
 * Per question the pick order is: (1) a `plan-review` intent's declared
 * `approve` option (that is the review's recommended action by
 * construction); (2) the first option whose label carries the
 * `(推荐)`/`(Recommended)` marker; (3) the first option, matching the
 * "recommended-first" convention even when the model forgot the marker.
 * A question with NO options is free text: with `answerFreeText` it is
 * answered with the standing autonomy-grant notice above (`selected` empty,
 * `custom` filled); without it the whole batch falls through to the human
 * rather than partially auto-answering.
 * @param questions - the questions the tool is asking.
 * @param options - { answerFreeText } controls free-text handling.
 * @returns an answer payload, or null when the batch must go to a human.
 */
function pickAutoAnswers(questions, { answerFreeText } = {}) {
  const answers = [];
  for (const question of questions) {
    const options = Array.isArray(question?.options) ? question.options : [];
    if (options.length === 0) {
      if (answerFreeText !== true) return null;
      answers.push({ id: question.id, selected: [], custom: FREE_TEXT_AUTO_ANSWER });
      continue;
    }
    let chosen = null;
    if (question?.intent?.kind === "plan-review" && typeof question.intent.approve === "string") {
      chosen = options.find((option) => option?.label === question.intent.approve) ?? null;
    }
    if (chosen === null) chosen = options.find((option) => isRecommendedLabel(option?.label)) ?? null;
    if (chosen === null) chosen = options[0];
    /* The option contract requires a `label`, but a malformed option must not
     * leak `selected: [undefined]` into the wire payload (it serializes as
     * `[null]` and the model sees a broken answer). Fall back to "" for a
     * label-less option rather than emitting undefined. */
    const label = typeof chosen?.label === "string" ? stripRecommendedSuffix(chosen.label) : "";
    answers.push({ id: question.id, selected: [label] });
  }
  return { answers };
}

/**
 * Render the escalation prompt sent once the SAME retry prompt has failed
 * `escalateAfterFailures` times. Instead of resending the identical text
 * (which keeps failing identically), the loop tells the model the round
 * keeps erroring and hands it the freshest error code + message so it can
 * route around the failing operation — or declare the blocker and wrap up.
 * The run never gives up: a failed escalation produces the next one with a
 * newer error, until a turn completes and the chain resets.
 * @param failures - how many times this prompt chain has failed in a row.
 * @param code - latest turn-error code ("unknown" when absent).
 * @param message - latest turn-error message, truncated.
 * @returns the escalation text to queue as the next user message.
 */
function renderEscalationPrompt(failures, code, message) {
  const summary = typeof message === "string" && message.length > 280 ? `${message.slice(0, 280)}…` : message;
  return (
    `(loop 无人值守自动升级) 你的上一条请求已经连续失败 ${failures} 次，` +
    `最近一次错误（${code}）：${summary ?? "(无详情)"}。` +
    `请不要再重发同一条注定失败的请求——换一条不依赖该失败操作的路径推进当前任务，` +
    `或先通过其他工具获取所需信息；若你判断任务确实无法继续推进，` +
    `请明确说明阻塞原因并结束本轮，不要无限重复同一个操作。`
  );
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
 * Resolve `agent.whenIdle()` but never hang on it: when the driver is
 * disarmed (the agent left the registry, the session was archived, the user
 * halted the run, or the host is tearing the plugin down) while the agent
 * would otherwise never reach quiescence, the abort signal wins and the
 * phase unwinds immediately. A rejected `whenIdle` is treated as idle — the
 * caller re-reads the durable log and acts on whatever the last turn
 * actually was.
 * @param agent - the agent being driven.
 * @param state - per-agent loop state carrying the abort signal.
 * @returns "aborted" when the signal fired first, "idle" otherwise.
 */
function settleWhenIdle(agent, state) {
  const signal = state.abort.signal;
  if (state.disarmed || signal.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(agent.whenIdle()).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve("idle");
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve("idle");
      }
    );
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
 * Return the text of the last real `user/message` event in a given seq
 * range, or null when none exists. The loop's own followups are
 * user-sourced messages too (`source.kind: "user"`), so this finds whatever
 * prompt led into a turn — a real user question on round 0, or a queued
 * continuation on later rounds. Events dsh injected onto the user channel
 * (`source.kind: "plugin"` — runtime-context snapshots, skill reminders)
 * are skipped: replaying them as a "retry prompt" would resend platform
 * scaffolding instead of the message that actually failed.
 * @param events - the session's durable event log.
 * @param fromSeq - first seq to consider.
 * @param toSeq - first seq to ignore.
 * @returns the last real user message text in range, or null.
 */
function lastUserMessageText(events, fromSeq, toSeq) {
  let text = null;
  for (const event of events) {
    if (event.seq < fromSeq || event.seq >= toSeq) continue;
    if (event.type !== "user/message") continue;
    if (event.data?.source?.kind === "plugin") continue;
    // dsh-session's deriveEventMessage returns `event.data` itself for
    // `user/message` (no `.message` wrapper — unlike `assistant/message`),
    // so the text blocks live at `event.data.content` directly.
    const blocks = Array.isArray(event.data?.content) ? event.data.content : [];
    let combined = "";
    for (const block of blocks) if (block?.type === "text" && typeof block.text === "string") combined += block.text;
    if (combined !== "") text = combined;
  }
  return text;
}

/**
 * Return true when the durable log contains at least one delivered real user
 * message. The loop uses this to distinguish "agent never started" from
 * "agent answered and is idle": a brand-new agent has no user message and
 * no completed turn, and queueing a continuation into it would race the
 * user's first message. Messages dsh injected onto the user channel
 * (`source.kind: "plugin"` — runtime-context snapshots, skill reminders,
 * file-change notices, inter-agent relays) do NOT count: a fresh agent that
 * only received injected scaffolding has not been spoken to, and driving it
 * into an endless run would hijack a conversation no human started. The
 * loop's own followups are `source.kind: "user"` and still count, matching
 * `lastUserMessageText`.
 * @param events - the session's durable event log.
 * @returns true when a real user message exists anywhere in the log.
 */
function hasUserMessage(events) {
  for (const event of events) {
    if (event.type !== "user/message") continue;
    if (event.data?.source?.kind === "plugin") continue;
    return true;
  }
  return false;
}

/**
 * Seed the driver's initial round boundary from a session's pre-existing
 * durable log. A freshly attached driver (supervisor attach, profile
 * restart, or re-enable after a stop-button halt) must not treat events from
 * before its birth as its own current round:
 *
 * 1. Trailing turn/end events that ended `aborted` or `interrupted` — the
 *    durable remnants of a user clicking stop or a crash-orphaned turn —
 *    are consumed by the boundary, so a re-enabled loop does not
 *    immediately re-halt on a stop that predates this driver.
 * 2. Otherwise the boundary starts at the SECOND-TO-LAST "drivable" turn/end
 *    (completed / error / blocked / max-tokens), so the first phase consumes
 *    exactly the last finished round as round 1 — `{{lastAnswer}}` holds one
 *    round's text, not the entire transcript of a long-running session.
 * 3. With fewer than two drivable turn/ends the boundary stays 0; the whole
 *    (single-round or empty) history IS that first round's domain.
 *
 * @param events - the session's durable event log.
 * @returns the lastRoundEndSeq value to start the driver with.
 */
function seedInitialBoundary(events) {
  /* One past the last stale (aborted/interrupted) turn/end, so those turns
   * never drive the first phase. */
  let stalePast = 0;
  /* Seqs of turn/ends that can legitimately drive a round. */
  const drivable = [];
  for (const event of events) {
    if (event.type !== "turn/end") continue;
    const kind = event.data?.reason?.kind;
    if (kind === "aborted" || kind === "interrupted") {
      stalePast = event.seq + 1;
    } else {
      drivable.push(event.seq);
    }
  }
  if (drivable.length >= 2) return Math.max(stalePast, drivable[drivable.length - 2]);
  if (drivable.length === 1) return Math.max(stalePast, 0);
  return stalePast;
}

/**
 * Return true when any user-sourced activity with seq >= fromSeq exists —
 * a `user/message` (the durable echo of a delivered message) or an
 * `agent/inbox/spliced` (a message queued into the agent's inbox, which
 * lands before its turn/start). The retry branch uses this to treat a
 * user interjection that happened during the backoff as superseding the
 * stale errored prompt — even while the user's own turn is still running
 * and has not produced a new `turn/end` yet. Resending the retry into that
 * gap would queue a ghost replay behind the user's live turn.
 * @param events - the session's durable event log.
 * @param fromSeq - first seq to consider.
 * @returns true when newer user-sourced activity exists.
 */
function hasNewerUserActivity(events, fromSeq) {
  for (const event of events) {
    if (event.seq < fromSeq) continue;
    // `user/message` is the durable echo of a delivered message. Filter
    // plugin-injected ones (source.kind === "plugin" — runtime snapshots,
    // skill reminders) so they do not masquerade as a real user interjection
    // and skip a legitimate retry. Mirrors the same filter in hasUserMessage.
    if (event.type === "user/message") {
      if (event.data?.source?.kind !== "plugin") return true;
      continue;
    }
    // `agent/inbox/spliced` fires when a message is queued into the agent's
    // inbox (followup / steer / inject). The event's `data.inserted` entries
    // carry source.kind when available; a splice with only plugin-injected
    // entries is not real user activity (inject() with wakeup=false does not
    // wake the driver, so treating it as such would skip a legitimate retry).
    // A splice from followup/steer (real user input) has no source.kind or a
    // non-plugin one — treat that as real activity. When the data shape is
    // ambiguous (no inserted array, empty array) fall back to counting it
    // as activity to avoid silently dropping a real user interjection.
    if (event.type === "agent/inbox/spliced") {
      const inserted = event.data?.inserted;
      if (!Array.isArray(inserted) || inserted.length === 0) return true;
      if (inserted.some((m) => m?.source?.kind !== "plugin")) return true;
      continue;
    }
  }
  return false;
}

/**
 * Return the wall-clock time (epoch ms) of the most recent durable event,
 * or 0 for an empty log. Used by the idle-grace guard to tell a freshly
 * active agent (boot it and keep going) from a stale restored session
 * (wait for the user to speak first).
 * @param events - the session's durable event log.
 * @returns epoch ms of the last event, or 0 when the log is empty.
 */
function lastEventTime(events) {
  const last = events.at(-1);
  return typeof last?.time === "number" ? last.time : 0;
}

/**
 * The command a user types in a halted session to re-arm the endless loop
 * for that conversation. Lowercase, leading slash; trimmed leading/trailing
 * whitespace is ignored. Anything starting with this token (case-insensitive)
 * counts — so `/forever` and `/forever now please` both re-arm.
 */
const FOREVER_COMMAND = "/forever";

/**
 * True when the given text is (or starts with) the /forever re-arm command.
 * Case-insensitive; leading/trailing whitespace is stripped.
 * @param text - raw message text to test.
 * @returns true when the text triggers the re-arm.
 */
function isForeverCommand(text) {
  if (typeof text !== "string") return false;
  return text.trim().toLowerCase().startsWith(FOREVER_COMMAND);
}

/**
 * Per-agent loop state. `disarmed` is the one-way kill switch the
 * registry supervisor flips when the agent leaves `agents.list()` (the
 * polled replacement for the scope-filtered `agent/disposed` event, which
 * never reaches a root-context plugin); the loop body checks it between
 * phases so a disarmed loop never re-queues a continuation after the agent
 * is gone. `profile` is the profile name the driver reads `readDisabled()`
 * against each phase, so a runtime disable flips the loop into an inert
 * idle without unmounting the plugin (unmounting would also take the
 * webserver routes offline and turn the settings switch into a one-way
 * trip).
 */
var LoopState = class {
  agent;
  config;
  profile;
  abort;
  disarmed = false;
  /** True when the user clicked the stop button (last turn ended `aborted`)
   * or the session was archived in the UI. Distinct from a plain teardown:
   * the supervisor keeps halted states in its map so it never reattaches a
   * fresh driver, while toggling the loop off and on sweeps them away to
   * re-arm every conversation (sessions still archived are exempt — a
   * hidden conversation never runs). */
  haltedByUser = false;
  /** Session log length at the moment the driver was halted. The supervisor
   * scans events from this seq onward for a `/forever` command to re-arm
   * the loop for this conversation. 0 when no halt has happened. */
  haltAtSeq = 0;
  /** True when this state represents a subagent (agent created with a
   * parent owner context — anything dsh-subagent spawns, in-agent helper
   * agents, etc.) rather than a top-level root conversation. Subagents are
   * never auto-attached by the supervisor; this flag exists so cleanup
   * paths and counters agree on that decision. The supervisor sets it for
   * any non-root agent it sees on its poll, and the attached-agent counter
   * skips these states. */
  subagent = false;
  consecutiveFailures = 0;
  constructor(agent, config, profile, { subagent = false } = {}) {
    this.agent = agent;
    this.config = config;
    this.profile = profile;
    this.subagent = subagent;
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
 * Drive one agent through the endless loop until the registry supervisor
 * disarms it (agent left the live registry) or the host tears the plugin
 * down. Every external error is caught and converted into a backoff retry;
 * the only "exit" path is `state.disarm()`.
 *
 * The function is structured as a single async tail that the caller
 * `await`s in fire-and-forget fashion — its returned promise resolves
 * when the loop is disarmed and has wound down its current step.
 *
 * @param state - per-agent loop state, owned by the registry supervisor.
 * @param logger - host logger for visibility.
 */
async function driveLoop(state, logger) {
  const { agent, config } = state;
  let round = 0;
  let lastPromptText = null;
  /* Seed the round boundary from pre-existing history (see
   * seedInitialBoundary): a driver born over a session with past turns must
   * consume the last finished round — not the whole transcript — as round 1,
   * and must not re-halt on a stop that happened before it existed. */
  let lastRoundEndSeq = seedInitialBoundary(agent.session.events);
  /* Identical-prompt failure chain: the driver counts how many times the
   * SAME text has failed in a row so that, after `escalateAfterFailures`
   * identical failures, it stops resending the doomed text and switches to
   * an escalation prompt that carries the latest error. Newer activity
   * (a user message / a completed turn) resets the chain. */
  let retryChainPrompt = null;
  let retryChainFailures = 0;

  while (!state.disarmed) {
    /** Runtime disabled gate: the user toggled the loop off in the
     * settings panel. The plugin stays mounted (the webserver routes the
     * UI talks to must stay live so the next toggle re-enables), so the
     * driver just sleeps here until the flag clears or the agent is torn
     * down. Polling is cheap (a single `stat` of a sidecar JSON) and the
     * wakeup is bounded by `state.abort`, so a dispose still wins. */
    if (readDisabled(state.profile)) {
      /* The `aborted` return from sleep is always preceded by `disarmed`
       * (disarm() aborts the controller), so the disarmed check above is the
       * only exit; the loop simply re-reads the gate after the sleep. */
      await sleep(2000, state.abort.signal);
      if (state.disarmed) return;
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
    if (phaseOutcome.kind === "retry") {
      /* A turn ended in an error. Sleep the exponential backoff first,
       * then actually re-queue the prompt that failed (the sleep lives
       * here, the send too, so one errored turn produces exactly one
       * retry). If the user interjected and a newer turn ended while we
       * slept, the failed prompt is stale — skip the resend and let the
       * next phase react to whatever the newest turn really is. The round
       * boundary advances past the errored turn so the retried turn is a
       * fresh round the success path can consume later. */
      const aborted = await sleep(backoffMs(state.consecutiveFailures + 1, config), state.abort.signal);
      if (state.disarmed) return;
      if (aborted) continue;
      /* Either way the errored turn is consumed: the boundary moves past it
       * so its partial content never bleeds into a later round's answer. */
      const superseded =
        lastTurnReason(agent.session.events, phaseOutcome.retryAfterSeq) !== undefined ||
        hasNewerUserActivity(agent.session.events, phaseOutcome.retryAfterSeq);
      lastRoundEndSeq = phaseOutcome.retryAfterSeq;
      if (!superseded) {
        /* Track the identical-prompt chain: the same retry text failing
         * repeatedly means resending it verbatim is pointless (a
         * deterministic error — a permanently blocked tool, an
         * unrecoverable request — fails identically every time). After
         * `escalateAfterFailures` consecutive identical failures the loop
         * switches to an escalation prompt that hands the model the freshest
         * error and asks it to route around the failing operation. The run
         * still never gives up: further failures produce further escalation
         * prompts (each carrying the newer error) until a turn completes. */
        if (phaseOutcome.retryPrompt !== retryChainPrompt) {
          retryChainPrompt = phaseOutcome.retryPrompt;
          retryChainFailures = 0;
        }
        retryChainFailures += 1;
        const escalate = config.escalateAfterFailures > 0 && retryChainFailures > config.escalateAfterFailures;
        const sendText = escalate
          ? renderEscalationPrompt(retryChainFailures, phaseOutcome.errorCode ?? "unknown", phaseOutcome.errorMessage)
          : phaseOutcome.retryPrompt;
        try {
          agent.followup(createUserMessage({
            content: [{ type: "text", text: sendText }],
            source: { kind: "user" }
          }));
          state.consecutiveFailures += 1;
          logger?.warn?.(
            escalate
              ? `dsh-loop-agent: agent "${agent.id}" retrying round after backoff — ESCALATED (${retryChainFailures} identical failures; route-around prompt sent)`
              : `dsh-loop-agent: agent "${agent.id}" retrying round after backoff (${retryChainFailures} identical failure(s) so far)`
          );
        } catch (error) {
          /* followup() is synchronous and can throw if the agent was disposed
           * (or its inbox torn down) while we sat in the backoff sleep. That
           * must not reject the whole driver task — the supervisor will
           * observe the agent leaving the registry on its next tick and
           * disarm cleanly. Treat the failed send like a superseded retry:
           * the errored turn is already consumed (the boundary moved past it
           * above), so reset the chain and let the next phase react to
           * whatever the newest turn really is. */
          retryChainPrompt = null;
          retryChainFailures = 0;
          logger?.warn?.(`dsh-loop-agent: agent "${agent.id}" retry followup failed synchronously: ${error instanceof Error ? error.message : String(error)}; not resending`);
        }
      } else {
        /* Newer activity superseded the errored turn: the whole failure
         * chain is broken — the backoff ladder and the escalation chain both
         * restart from zero, so a fresh prompt starts counting fresh. */
        retryChainPrompt = null;
        retryChainFailures = 0;
        state.consecutiveFailures = 0;
        logger?.warn?.(`dsh-loop-agent: agent "${agent.id}" error superseded by newer activity; not resending the stale prompt`);
      }
      continue;
    }
    if (phaseOutcome.kind === "exited") return;
    if (phaseOutcome.kind === "halt") {
      /* The last turn ended because the user clicked the stop button.
       * "Endless until the user manually stops" means exactly this click
       * ends the run — never queue another continuation after an abort.
       * Mark the state as user-halted and disarm the driver. The state
       * stays in the supervisor's map, so a fresh driver is NOT reattached
       * while the agent lives; the loop re-arms for this conversation only
       * when the user types `/forever` (only while the global switch is on)
       * or toggles the loop off and on (the enable route sweeps halted states)
       * or dsh restarts. */
      state.haltAtSeq = agent.session.events.length;
      state.haltedByUser = true;
      state.disarm();
      logger?.info?.(`dsh-loop-agent: agent "${agent.id}" endless run stopped by the user (type /forever to re-arm)`);
      return;
    }
    if (phaseOutcome.kind === "wait") {
      /* Nothing has happened on this agent yet (or it just reset): no
       * user message was ever delivered and no turn ever ended. Wait for
       * the user to actually start a conversation before queueing any
       * continuation — an endless loop must never race the user's first
       * message. Sleep briefly and re-examine; a dispose still wins. */
      const aborted = await sleep(1000, state.abort.signal);
      if (state.disarmed) return;
      if (aborted) continue;
      continue;
    }
    /* phaseOutcome.kind === "continued" */
    state.consecutiveFailures = 0;
    retryChainPrompt = null;
    retryChainFailures = 0;
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
   * agent driver itself; the outer catch in `driveLoop` will backoff-retry.
   * The wait races the abort signal so a driver whose agent is disposed or
   * leaves the registry unwinds promptly instead of awaiting quiescence
   * that may never come. */
  const settled = await settleWhenIdle(agent, state);
  if (settled === "aborted" || state.disarmed) return { kind: "exited" };

  const events = agent.session.events;
  const tailSeq = events.length === 0 ? 0 : (events.at(-1).seq + 1);
  const turnEnd = lastTurnEndSeq(events, lastRoundEndSeq);
  const sliceEnd = turnEnd !== null ? turnEnd + 1 : tailSeq;
  const lastAnswer = collectAssistantText(events, lastRoundEndSeq, sliceEnd);
  const reason = lastTurnReason(events, lastRoundEndSeq);

  // Guard: an agent that never received a user message and never finished
  // a turn has not "started" yet. A poll supervisor may attach to a freshly
  // created agent before the user types anything; queueing a continuation
  // into that agent would race the user's first message and effectively
  // hijack the conversation. Wait until the user actually speaks.
  //
  // Idle-grace guard: after every dsh boot the supervisor attaches to every
  // restored session, not just new ones. A session whose most recent event
  // is older than `idleGraceMs` is a stale historical conversation — do not
  // auto-continue it and burn tokens; wait for the user to send a fresh
  // message, which re-arms the loop. A session with a recent exchange (the
  // "I just asked something" case) is continued immediately.
  const grace = config.idleGraceMs ?? 300_000;
  const lastTs = lastEventTime(events);
  const stale = grace > 0 && round === 0 && lastTs > 0 && Date.now() - lastTs > grace;
  if (round === 0 && (!hasUserMessage(events) || stale)) {
    return { kind: "wait" };
  }

  // Failure path: the round ended in a turn-level error (`turn/end` reason
  // `error`). The prompt that triggered the failed round must be re-sent
  // after an exponential backoff — retries keep coming forever (capped at
  // `maxBackoffMs`), so a transient provider blip never kills the run;
  // `driveLoop` owns the sleep and the actual `followup`, and advances the
  // round boundary past the errored turn so the retry is a fresh turn that
  // the success path can later consume.
  if (reason?.kind === "error") {
    // Prefer our own last queued prompt. When there is none (round 0 — a
    // fresh driver over a stalled round after a restart, or the user's own
    // first turn errored), replay the last user message that led into the
    // errored turn so the run self-heals without anyone typing. A brand-new
    // agent that never received any message has nothing to replay; wait.
    let retryPrompt = lastPromptText;
    if (retryPrompt === null) {
      retryPrompt = lastUserMessageText(events, lastRoundEndSeq, turnEnd !== null ? turnEnd + 1 : events.length);
    }
    if (retryPrompt === null) return { kind: "wait" };
    const code = reason?.error?.code ?? "unknown";
    const message = reason?.error?.message ?? "(no message)";
    logger?.warn?.(`dsh-loop-agent: turn error on agent "${agent.id}" (code=${code}): ${message}; backing off, then retrying the same prompt`);
    return {
      kind: "retry",
      retryPrompt,
      // Latest error details ride along so the driver can escalate to a
      // route-around prompt after enough identical failures instead of
      // resending the same doomed text forever.
      errorCode: code,
      errorMessage: message,
      // Everything at or past this seq belongs to rounds after the errored
      // turn; used to consume the errored turn and to detect a user message
      // that superseded it while we were asleep.
      retryAfterSeq: turnEnd !== null ? turnEnd + 1 : sliceEnd
    };
  }

  // User-stop path: the round ended because the user clicked the stop
  // button (turn/end `reason.kind === "aborted"`, sub-reason `user`).
  // The contract is "endless until the user manually stops" — this click
  // IS the manual stop, so the loop must end here and never queue the next
  // continuation. Parent/hook/disposed aborts (the agent being torn down)
  // must not auto-continue either, so every abort halts.
  if (reason?.kind === "aborted") {
    const cause = reason?.reason?.kind ?? "unknown";
    logger?.info?.(`dsh-loop-agent: agent "${agent.id}" turn aborted by ${cause}; ending the endless run`);
    return { kind: "halt" };
  }

  // Preemption path: the round was interrupted because the user sent a new
  // message while the agent was still answering. The user is actively
  // steering the conversation — do not queue a continuation into that gap
  // and race their message. Sit on `whenIdle()` again; once their follow-up
  // turn settles, the normal success path resumes the endless run.
  if (reason?.kind === "interrupted") {
    return { kind: "wait" };
  }

  // Idle-without-work path: `whenIdle()` resolved but no turn has actually
  // ended since the last round boundary. This happens in the momentary gap
  // between the driver queueing a continuation and the agent's turn for it
  // starting (the agent is briefly idle with work already queued). Queueing
  // again here would double-send and pile up back-to-back continuations.
  // Only a turn that finished normally (`completed`) drives the next
  // continuation; a `blocked` turn (e.g. waiting on an approval) is not a
  // completed round either, so wait and re-examine. Approvals for armed
  // loop agents are auto-granted `allowed-once` upstream, so a block that
  // still lands here means the approval was declined (a `never` policy) or
  // the agent was no longer armed when it asked.
  if (reason?.kind !== "completed") {
    return { kind: "wait" };
  }

  // User-message priority gate: when a REAL user message is already pending
  // in the inbox (queued into next-step or next-turn), do not append a
  // continuation now — wait instead, so the user's input runs first and the
  // loop only continues when no human input is queued. This makes the
  // priority explicit instead of relying on timing alone: user input always
  // wakes the agent (steer and followup both carry wakeup=true), so by the
  // time whenIdle() resolved anything still pending from a REAL user is a
  // message that raced this very phase. Plugin-injected context
  // (`source.kind: "plugin"` — runtime snapshots, skill reminders) is
  // deliberately exempt: inject() does not wake the driver, so injected
  // content legitimately sits pending while idle, and blocking on it would
  // deadlock the loop — the queued continuation turn claims it at its next
  // step boundary, which is exactly inject()'s documented contract.
  const pending = [...(agent.inbox?.nextStep ?? []), ...(agent.inbox?.nextTurn ?? [])];
  if (pending.some((message) => message?.source?.kind !== "plugin")) {
    return { kind: "wait" };
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
 * Three responsibilities: (1) provide the `loopConfig` snapshot the browser
 * half reads, (2) register the three client→host webserver routes (state /
 * enable / continuation), and (3) run the 1-second registry supervisor that
 * attaches a driver task per live agent and disarms drivers whose agent
 * left the registry, was archived, or was halted. All tasks are tracked in
 * a per-plugin `Map<Agent, LoopState>`; the supervisor effect returns a
 * cleanup that disarms every live driver when the bundle is uninstalled.
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
  /** Agent IDs that should be armed (not parked) when supervisor sees them.
   * Populated by /forever command, cleared after supervisor creates armed state. */
  /** Map of agent IDs that should be armed (not parked) when the supervisor
   * sees them. Populated by the /forever command handler, consumed by the
   * supervisor's next tick. Maps agentId -> event seq to skip past the
   * /forever message when starting the driver. */
  const armedAgentIds = new Map();

  /* Name of the profile this row is mounted in, when the launcher says.
   * The browser half needs it to find the right patch file; absent it,
   * the default `web` is what this bundle targets. */
  const profile = ctx.get("appProfile")?.name ?? "web";

  /* ------------------------------------------------------------------ *
   * Auto-default for mid-run interactions.
   *
   * An endless run must not park on the human. Two seams cover every way a
   * turn can stall waiting for a person:
   *
   * 1. Questions: `ask_user_question` resolves through the host's single
   *    `ctx.userQuestions` provider (registered by the web api-proxy),
   *    whose `ask()` relays the card to the browser and waits. There is no
   *    sanctioned hook between the service and the provider, so this plugin
   *    wraps the provider's `ask` once (restoring it on teardown) and
   *    answers the request itself when it belongs to an armed loop agent —
   *    the model receives a normal tool result and the run never stalls.
   *    A question with no options is never guessed: the whole batch falls
   *    through to the real provider (the human).
   *
   * 2. Approvals: a tool call gated `{ kind: "ask" }` flows through
   *    `ctx.approval.request()` -> the `approval/request` waterfall. This
   *    plugin registers a `prepend` handler that returns `allowed-once`
   *    for armed loop agents, so no approval card is shown and the audit
   *    pair (`approval/asked` + `approval/decided`) is still written by
   *    the service. Sessions whose policy is `never` reject before this
   *    waterfall runs; non-driven sessions keep the normal approval UI.
   *
   * Both guards key on the same predicate: the agent is in this plugin's
   * state map, its driver is armed (not stopped / archived / torn down),
   * and the loop switch is on. Turn them off by setting the row config
   * `autoAnswerQuestions` / `autoApproveActions` to false.
   * ------------------------------------------------------------------ */

  /** Providers this plugin has already wrapped (fresh per plugin apply). */
  const wrappedQuestionProviders = new WeakSet();
  /** Original `ask` per wrapped provider, for teardown restoration. */
  const providerOriginals = new WeakMap();

  /** Whether the agent's endless driver is live AND the loop switch is on.
   * The sole gate for both auto-default guards: a parked driver (loop off)
   * or a disarmed one (stopped / archived / disposed) never auto-answers. */
  function drivenAndArmed(agent) {
    if (agent == null) return false;
    const state = states.get(agent);
    return state !== undefined && !state.disarmed && !readDisabled(profile);
  }

  /**
   * Patch the host's user-questions provider so questions asked by an armed
   * loop agent resolve instantly. The api-proxy registers one provider per
   * plugin apply and replaces it on reapply, so this is re-run from the
   * supervisor tick to (re)wrap a freshly registered provider.
   * @returns true when a provider is present and (now) wrapped.
   */
  function installQuestionAutoAnswer() {
    const service = ctx.get("userQuestions");
    const provider = service?.provider;
    if (provider == null || typeof provider.ask !== "function") return false;
    if (wrappedQuestionProviders.has(provider)) return true;
    const originalAsk = provider.ask;
    provider.ask = async function autoAnsweringAsk(request) {
      const agent = request?.agent;
      if (config.autoAnswerQuestions !== false && drivenAndArmed(agent) && Array.isArray(request?.questions)) {
        const auto = pickAutoAnswers(request.questions, { answerFreeText: config.autoAnswerFreeText !== false });
        if (auto !== null) {
          const kinds = auto.answers.some((answer) => Array.isArray(answer.selected) && answer.selected.length === 0 && typeof answer.custom === "string")
            ? "recommended/first option + free-text autonomy grant"
            : "recommended/first option";
          logger?.info?.(`dsh-loop-agent: agent "${agent.id}" ask auto-answered (${auto.answers.length} question(s), ${kinds})`);
          return auto;
        }
      }
      return originalAsk.call(provider, request);
    };
    wrappedQuestionProviders.add(provider);
    providerOriginals.set(provider, originalAsk);
    return true;
  }

  /** Restore every wrapped provider on plugin teardown. */
  function uninstallQuestionAutoAnswer() {
    for (const [provider, originalAsk] of providerOriginals) {
      if (provider != null && typeof provider.ask === "function") provider.ask = originalAsk;
    }
    providerOriginals.clear();
  }

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
    /** How many TOP-LEVEL conversations currently have a live, armed driver
     * — the sessions the endless loop is attached to and keeps continuing.
     * Subagents (agents created with a parent owner context — anything
     * dsh-subagent spawns, in-agent helper agents, ...) are deliberately
     * excluded: they are scoped, ephemeral helpers, not conversations a
     * user can see in the message list, and the loop default is to leave
     * them alone (no driver, no auto-answer, no auto-approve). A halted or
     * parked state (stopped by the user, archived) stays in the map so the
     * supervisor does not reattach it — but it is not "running", so it
     * does not count here. A driver sitting at the disabled gate is not
     * running either: with the global switch off, every root agent parks
     * there, and reporting N "running" agents under an Off switch would
     * lie — count 0 instead. */
    get attachedAgents() {
      if (readDisabled(profile)) return 0;
      let count = 0;
      for (const state of states.values()) if (!state.disarmed && !state.subagent) count += 1;
      return count;
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
      version: BUNDLE_VERSION,
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
      /* Strict boolean: a malformed client (string "true", missing field)
       * must not silently DISABLE the loop — the continuation route rejects
       * non-strings with a 400, so treat non-booleans the same way instead
       * of coercing them into an unintended off switch. */
      if (typeof body?.enabled !== "boolean") {
        sendJson(res, 400, { error: "enabled must be a boolean" });
        return;
      }
      const enabled = body.enabled;
      const result = writeDisabled(!enabled, profile);
      logger?.info?.(`dsh-loop-agent: endless loop ${enabled ? "enabled" : "disabled"}; takes effect within seconds (sidecar ${result.path})`);
      
      if (enabled) {
        /* Turn ON: just enable the /forever mechanism. Do NOT auto-re-arm
         * halted sessions — the user must explicitly type /forever in each
         * session they want to activate. The supervisor will detect /forever
         * and re-arm on its next tick. Archived sessions remain parked. */
        logger?.info?.(`dsh-loop-agent: loop enabled; type /forever in a session to activate its endless run`);
      } else {
        /* Turn OFF: immediately halt all currently running agents. Park them
         * in halted state so /forever can re-arm them later (if the switch
         * is turned back on). Disarm drivers, record haltAtSeq, and cancel
         * in-flight work if possible. */
        let haltedCount = 0;
        for (const [agent, state] of [...states]) {
          if (state.disarmed) continue; // already stopped
          state.haltAtSeq = agent.session?.events?.length ?? 0;
          state.haltedByUser = true;
          state.disarm();
          // Try to cancel in-flight work so the agent stops immediately
          try {
            agent.cancel?.({ kind: "user" });
          } catch (error) {
            logger?.warn?.(`dsh-loop-agent: cancel on agent "${agent.id}" during global disable failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          haltedCount++;
          logger?.info?.(`dsh-loop-agent: agent "${agent.id}" halted by global disable`);
        }
        if (haltedCount > 0) {
          logger?.info?.(`dsh-loop-agent: ${haltedCount} agent(s) halted by global disable; type /forever in each session to re-arm after re-enabling`);
        }
      }
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

  /**
   * Snapshot of the workspace registry's archive set — session ids the user
   * archived in the UI. Archiving hides a session from every grouping
   * surface WITHOUT disposing its agent or session (see `dsh-workspace`:
   * `archiveSession` only appends to the durable `archivedSessionIds`), so
   * without this check the endless loop would keep burning tokens on a
   * hidden conversation. Returns a Set of archived ids, or null when the
   * registry is absent or not yet bootstrapped (the web profile always
   * mounts it; degrade to a no-op elsewhere rather than throw). The archive
   * list is polled, matching the supervisor's polling design — there is no
   * root-visible archive event a third-party plugin could subscribe to.
   */
  function sessionArchivedSet() {
    try {
      const registry = ctx.get?.("workspaceRegistry");
      const ids = registry?.archivedSessionIds;
      return Array.isArray(ids) ? new Set(ids) : null;
    } catch {
      return null;
    }
  }

  /* Auto-grant one-shot approvals for armed loop agents. `prepend` makes
   * this handler run before the web api-proxy's own `approval/request`
   * handler regardless of plugin load order, so a driven agent's approval
   * resolves here and never reaches the browser card; every other request
   * calls `next()` and keeps the normal chain. */
  ctx.effect(() => {
    const disposer = ctx.on("approval/request", (req, next) => {
      const agent = req?.agent;
      if (config.autoApproveActions === false || !drivenAndArmed(agent)) return next();
      logger?.info?.(`dsh-loop-agent: agent "${agent.id}" ${req?.toolName ?? "action"} auto-approved (allowed-once)`);
      return Promise.resolve("allowed-once");
    }, { prepend: true });
    return disposer;
  }, "dsh-loop-agent: auto-approve for armed loop agents");

  /* Patch the user-questions provider now (the api-proxy usually applied
   * before this bundle row), and restore it if the plugin is torn down. */
  installQuestionAutoAnswer();
  ctx.effect(() => () => {
    uninstallQuestionAutoAnswer();
  }, "dsh-loop-agent: restore wrapped user-questions provider");

  /*
   * Attachment supervisor.
   *
   * `agent/created`, `agent/disposed` and `session/disposed` are all
   * scope-filtered events (`this: Scoped<Agent>`): they dispatch only to
   * listeners registered inside that agent's own scope chain, never to a
   * plugin sitting on the root context. The official agent-loop plugin can
   * rely on them only because it IS the agent factory and registers inside
   * each agent's scope. A third-party host plugin has no such hook, so the
   * only reliable way to discover agents is to poll the public registry
   * (`ctx.agents.list()` / `.roots()`), which every live agent populates on
   * the same context regardless of scope.
   *
   * The supervisor polls once a second, attaches a driver to every top-level
   * (root) agent it has not seen yet, and disarms drivers whose agent has
   * left the root set (the poll replaces the never-delivered `agent/disposed`
   * signal for root agents; subagents never get a driver so they never
   * appear in the state map). The same tick consults the workspace archive
   * set: an agent whose session is archived never gets a driver (and a
   * running driver whose session just got archived is halted and its
   * in-flight work cancelled), so archiving a conversation stops its endless
   * run within a second even though the agent stays alive underneath.
   * Attachment itself is cheap: `driveLoop` sits at the disabled gate when
   * the loop is off, and waits on `whenIdle()` when it is on, so attaching
   * to an already-idle agent queues the next continuation immediately.
   */
  ctx.effect(() => {
    let tornDown = false;
    const timer = setInterval(() => {
      if (tornDown) return;
      /* (Re)wrap the user-questions provider: the web api-proxy registers a
       * fresh provider object on each of its applies, so a re-registration
       * since the last tick would otherwise silently drop the auto-answer
       * patch. Cheap — a WeakSet membership check when already wrapped. */
      installQuestionAutoAnswer();
      /* Top-level (root) agents only: subagents (anything spawned under a
       * parent owner context — dsh-subagent, in-agent helpers, ...) are
       * scoped, ephemeral helpers, not conversations the user opens in the
       * message list, and the loop default is to leave them alone (no
       * driver, no auto-answer, no auto-approve). Counting them in
       * "attached agents" would inflate the number, and attaching a driver
       * would burn tokens on a hidden session. `ctx.agents.roots()` is the
       * same registry, filtered to entries with no owner — exactly the
       * top-level conversations the user sees. */
      let live = [];
      try {
        live = ctx.agents.roots();
      } catch (error) {
        logger?.warn?.(`dsh-loop-agent: registry poll failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const liveSet = new Set(live);
      const archived = sessionArchivedSet();

      /* /forever re-arm sweep: a user who halted a conversation with the
       * stop button can type `/forever` in that session to re-arm the
       * endless loop for it. Only applies while the global switch is on —
       * a disabled loop never re-arms, even on /forever. Archived sessions
       * are exempt (the user cannot type into a hidden session, and even
       * if the /forever message was delivered before the archive landed,
       * we honor the archive as the most recent intent). */
      if (!readDisabled(profile)) {
        for (const [agent, state] of [...states]) {
          if (!state.haltedByUser) continue;
          if (state.subagent) continue;
          if (archived?.has(agent.session?.id)) continue;
          const events = agent.session?.events;
          if (!Array.isArray(events)) continue;
          const fromSeq = state.haltAtSeq || 0;
          for (const event of events) {
            if (event.seq < fromSeq) continue;
            if (event.type !== "user/message") continue;
            if (event.data?.source?.kind === "plugin") continue;
            const blocks = Array.isArray(event.data?.content) ? event.data.content : [];
            let text = "";
            for (const block of blocks) if (block?.type === "text" && typeof block.text === "string") text += block.text;
            if (isForeverCommand(text)) {
              // Disarm the old halted state
              state.disarm();
              // Delete from states so next tick re-attaches as armed
              states.delete(agent);
              // Mark as armed with the seq after /forever message
              armedAgentIds.set(agent.id, event.seq + 1);
              logger?.info?.(`dsh-loop-agent: agent "${agent.id}" marked for re-arming by /forever command (seq=${event.seq + 1})`);
              break;
            }
          }
        }
      }

      for (const agent of live) {
        if (states.has(agent)) continue;
        if (archived?.has(agent.session?.id)) {
          /* Archived session: never start a driver. Park a halted state so
           * the supervisor does not reconsider it every tick; re-arm only
           * happens after the user unarchives AND types /forever. */
          const state = new LoopState(agent, config, profile);
          state.haltAtSeq = agent.session?.events?.length ?? 0;
          state.haltedByUser = true;
          state.disarm();
          states.set(agent, state);
          logger?.info?.(`dsh-loop-agent: agent "${agent.id}" is archived; loop not attached`);
          continue;
        }
        /* On-demand mode: do NOT auto-attach drivers to new agents. Instead,
         * park them in a halted state and wait for the user to type /forever
         * in that session. The /forever sweep above will detect the command
         * and arm the driver. Skip agents in armedAgentIds (already armed by
         * /forever command). This gives users explicit control: no session runs
         * until they opt in with /forever. */
        if (armedAgentIds.has(agent.id)) {
          const seq = armedAgentIds.get(agent.id);
          armedAgentIds.delete(agent.id);
          // Create armed state and start driver
          const state = new LoopState(agent, config, profile);
          state.haltAtSeq = seq; // Skip past the /forever message
          states.set(agent, state);
          logger?.info?.(`dsh-loop-agent: agent "${agent.id}" armed by /forever; starting driver`);
          driveLoop(state, logger).catch((error) => {
            logger?.warn?.(`dsh-loop-agent: driver task for armed agent "${agent.id}" rejected: ${error instanceof Error ? error.message : String(error)}`);
            state.disarm();
            states.delete(agent);
          });
          continue;
        }
        const state = new LoopState(agent, config, profile);
        state.haltAtSeq = 0; // scan from beginning for /forever command
        state.haltedByUser = true;
        state.disarm();
        states.set(agent, state);
        logger?.debug?.(`dsh-loop-agent: agent "${agent.id}" parked; type /forever to activate endless loop`);
      }
      for (const [agent, state] of [...states]) {
        if (!liveSet.has(agent)) {
          state.disarm();
          states.delete(agent);
          // Clean up armedAgentIds to prevent memory leak when agent leaves
          // before supervisor processes the armed state
          armedAgentIds.delete(agent.id);
          logger?.info?.(`dsh-loop-agent: agent "${agent.id}" left registry (no longer a root); loop wound down`);
          continue;
        }
        if (!state.disarmed && archived?.has(agent.session?.id)) {
          /* The conversation was archived while its loop was running.
           * Disarm the driver and cancel whatever the agent is doing
           * (drops any queued continuation and aborts the in-flight turn;
           * a no-op when idle) so an archived session stops spending
           * immediately instead of finishing the current auto-reply. */
          state.haltAtSeq = agent.session?.events?.length ?? 0;
          state.haltedByUser = true;
          state.disarm();
          try {
            agent.cancel?.({ kind: "user" });
          } catch (error) {
            logger?.warn?.(`dsh-loop-agent: cancel after archive on agent "${agent.id}" failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          logger?.info?.(`dsh-loop-agent: agent "${agent.id}" archived; endless run stopped`);
        }
      }
    }, 1000);
    return () => {
      tornDown = true;
      clearInterval(timer);
      for (const state of states.values()) state.disarm();
      states.clear();
    };
  }, "dsh-loop-agent: registry supervisor");

}
//#endregion
export { Config, apply, inject, name };
