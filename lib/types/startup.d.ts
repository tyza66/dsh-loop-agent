/**
 * The endless-loop app's command-line provider. Parses the same positional
 * `task` as the one-shot profile, plus a few loop-only flags, and publishes
 * a {@link LOOP_STARTUP_SERVICE} that the loop-runner row consumes.
 *
 * @module @tyza66/dsh-loop-agent/startup
 */
import type { Context } from "@deepseek-ai/cordis";

/** Stable Cordis plugin name. */
export declare const name = "loop-startup";

/** Services required before any flag can be resolved. */
export declare const inject: string[];

/** Service provided by this plugin and consumed by the loop-runner row. */
export declare const LOOP_STARTUP_SERVICE = "loopStartup";

/** What the loop-runner row reads from {@link LOOP_STARTUP_SERVICE}. */
export interface LoopStartupValues {
  /** The task text this invocation asked for. */
  task: string;
  /** Continuation prompt template; see Config.continuation in `./index`. */
  continuation: string;
  /** Hard upper bound on rounds; 0 means no cap. */
  maxRounds: number;
  /** Case-insensitive substrings that end the loop when matched. */
  exitPhrases: string[];
  /** Whether to suppress per-round header lines on stderr. */
  quiet: boolean;
}

/**
 * Parse and provide the loop config as an ordinary Cordis service. The
 * command's action publishes the values; a missing or whitespace-only task
 * is a usage error, so on rejection (and on `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export declare function apply(ctx: Context): void;

export {};
