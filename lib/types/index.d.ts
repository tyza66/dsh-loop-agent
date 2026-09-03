/**
 * @tyza66/dsh-loop-agent — endless same-session loop driver for the dsh web profile.
 *
 * Attaches to every new agent through the host-scope `agent/created` hook.
 * After every turn an agent finishes, the loop injects a user-configurable
 * continuation prompt at the next turn boundary, forever. The same Agent
 * and the same Session live for the whole run, so each round sees the
 * full accumulating transcript; only the next user message is replaced by
 * the template.
 *
 * User messages take priority by inbox construction: client input lands
 * in `next-step` while the loop's continuation lands in `next-turn`, and
 * the inbox `claim("next-turn")` order always pulls `next-step` first.
 * The loop only acts on `agent.whenIdle()`, so it cannot preempt
 * in-flight work; once the user stops sending, the agent runs the queued
 * continuation, goes idle, and the loop queues the next one.
 *
 * The loop never exits on its own. Any failure is caught and converted
 * into exponential backoff plus a re-send of the same prompt. The only
 * exit is the session being torn down: `agent/disposed` (or
 * `session/disposed`) observed on the host scope flips the loop's
 * `disarmed` flag.
 *
 * Context-window pressure is *not* the loop's job. 80% / `/compact` is
 * wired by re-enabling `dsh-compaction-basic` (auto) and
 * `dsh-command-compact` in the patch; the loop and the compactor are
 * orthogonal, and the compactor runs in the same session.
 *
 * @module @tyza66/dsh-loop-agent
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name. */
export declare const name = "loop-runner";

/** Service dependencies the apply step needs before registering hooks. */
export declare const inject: string[];

/** Loop config: continuation template + retry pacing. */
export interface Config {
  /**
   * Continuation prompt template. Plain text; supports `{{lastAnswer}}`,
   * `{{round}}` (1-based; round 1 is the first continuation, not the
   * user's first message), and `{{task}}` (always empty in web mode).
   */
  continuation: string;
  /** Initial backoff in milliseconds for the first failure-driven retry. */
  initialBackoffMs: number;
  /** Upper cap on the exponential backoff, in milliseconds. */
  maxBackoffMs: number;
  /** Multiplier applied to the backoff on each successive failure. */
  backoffFactor: number;
  /**
   * If true, the loop only logs at warn / error level and stays silent
   * on a clean run. Default false: every round boundary emits an info
   * line so a long run leaves a visible trace in `dsh` logs.
   */
  quiet: boolean;
}

export declare const Config: z<Config>;

/**
 * Mount the endless same-session loop driver.
 * @param ctx - plugin context carrying the agents service and a logger.
 * @param config - validated loop config.
 */
export declare function apply(ctx: Context, config: Config): void;

export {};
