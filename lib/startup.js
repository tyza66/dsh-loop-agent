import { Command, Option } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";

//#region lib/types/startup.js
/**
 * The endless-loop app's command-line provider. Parses the same positional
 * `task` as the one-shot profile, plus a few loop-only flags, and publishes
 * a {@link LOOP_STARTUP_SERVICE} the loop-runner row consumes.
 *
 * @module @tyza66/dsh-loop-agent/startup
 */
/** Stable Cordis plugin name. */
const name = "loop-startup";
/** Services required before any flag can be resolved. */
const inject = ["cmdlineArgs"];
/** Service provided by this plugin and consumed by the loop-runner row. */
const LOOP_STARTUP_SERVICE = "loopStartup";

/**
 * Default continuation template. Renders `{{lastAnswer}}` (the previous
 * round's text), `{{round}}` / `{{turn}}` (1-based, round 2 = first
 * continuation), and `{{task}}` (the original task). Override with
 * `--continue`.
 */
const DEFAULT_CONTINUATION = "Please continue from where you left off. (Round {{round}})";

/**
 * Build this app's command. Mirrors `dsh --profile headless` so existing
 * muscle memory and aliases still work; the extra flags only change the
 * loop's behavior, not how the task is supplied.
 * @returns a fresh program, so tests can parse more than once.
 */
function loopCommand() {
  return new Command()
    .name("dsh --profile headless")
    .description("Run the same session across rounds: after every final answer, inject a continuation prompt and keep going. Ctrl-C to stop.")
    .helpOption("-h, --help", "show this help")
    .argument("[task...]", "the task text; multiple words are joined by spaces")
    .addOption(new Option("--continuation <template>", "continuation prompt template (use {{lastAnswer}} {{round}} {{task}})").default(DEFAULT_CONTINUATION))
    .addOption(new Option("--max-rounds <n>", "stop after N rounds; 0 = unlimited").default("0"))
    .addOption(new Option("--exit-phrase <phrases...>", "exit when the assistant text contains any of these substrings (case-insensitive); pass multiple by repeating the flag").default([]))
    .option("--quiet", "suppress per-round header lines on stderr", false)
    .addHelpText("after", `
Examples:
  dsh --profile headless "build a snake game"                                  loop forever
  dsh --profile headless "build a snake game" --max-rounds 5                   stop after 5 rounds
  dsh --profile headless "build a snake game" --continuation "refactor it. {{round}}"
  dsh --profile headless "build a snake game" --exit-phrase DONE --exit-phrase FINISHED
`);
}

/**
 * commander value-parser for `--max-rounds`. Accepts any non-negative
 * integer; rejects negative numbers, decimals, and non-numeric input so
 * the loop can rely on the runtime invariant without re-checking.
 *
 * The default value passes through commander as a string and is coerced
 * here too, so the loop always sees a `number`.
 * @param value - raw value (string from argv, or the option's default).
 * @returns the parsed non-negative integer.
 */
function parseNonNegativeInt(value) {
  const trimmed = String(value).trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(trimmed)) {
    throw new Error(`expected a non-negative integer, got "${value}"`);
  }
  return Number.parseInt(trimmed, 10);
}

/** What the loop-runner row reads from {@link LOOP_STARTUP_SERVICE}. */
function apply(ctx) {
  const program = loopCommand();
  program.action(() => {
    const task = program.args.join(" ");
    if (task.trim() === "") {
      program.error("error: a task is required, for example: dsh --profile headless \"run the tests\"");
    }
    const opts = program.opts();
    const exitPhrases = Array.isArray(opts.exitPhrase)
      ? opts.exitPhrase.filter((p) => typeof p === "string" && p.length > 0)
      : typeof opts.exitPhrase === "string" && opts.exitPhrase.length > 0
        ? [opts.exitPhrase]
        : [];
    ctx.provide(LOOP_STARTUP_SERVICE, {
      task,
      continuation: typeof opts.continuation === "string" ? opts.continuation : DEFAULT_CONTINUATION,
      maxRounds: parseNonNegativeInt(opts.maxRounds ?? "0"),
      exitPhrases,
      quiet: Boolean(opts.quiet)
    });
  });
  parseCmdline(ctx, program);
}
//#endregion
export { LOOP_STARTUP_SERVICE, apply, inject, loopCommand, name, parseNonNegativeInt };
