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
 * @module @tyza66/dsh-loop-agent
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name. */
export declare const name = "loop-runner";

/** Core services required before the loop can start. */
export declare const inject: string[];

/** Bundle config: the task plus loop behavior. Values arrive from the loopStartup service. */
export interface Config {
  /** The first user message; the loop runs at least one round on it. */
  task: string;
  /**
   * Continuation prompt sent at the start of every round after the first.
   * Supports `{{task}}`, `{{lastAnswer}}`, `{{round}}`, `{{turn}}`. Default
   * is "Please continue from where you left off. (Round {{round}})".
   */
  continuation: string;
  /** Hard upper bound on rounds; 0 means no cap. */
  maxRounds: number;
  /**
   * Case-insensitive substrings that, when found in the last assistant
   * text of a round, end the loop with exit code 0.
   */
  exitPhrases: string[];
  /** Suppress per-round header lines on stderr. */
  quiet: boolean;
}

export declare const Config: z<Config>;

/** Process-facing effects of one run: output streams plus the launcher's bounded exit request. */
interface LoopIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void;
}

/** The process streams the runner writes to; tests substitute captures. */
export declare const internals: {
  stdout: LoopIo["stdout"];
  stderr: LoopIo["stderr"];
};

/**
 * Mount the endless same-session loop driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated loop config.
 */
export declare function apply(ctx: Context, config: Config): void;

export {};
