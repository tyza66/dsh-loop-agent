/* Regression tests for dsh-loop-agent pure helpers.
 *
 * Extracts the real helper source from lib/index.js (brace-matched) so we
 * test the shipped code, not a copy. Run from anywhere with:
 *   npm test
 * or directly:
 *   node test/unit.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const indexPath = fileURLToPath(new URL("../lib/index.js", import.meta.url));
const src = readFileSync(indexPath, "utf8");

function blockEndAt(marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error(`unbalanced block at ${marker}`);
}

// Top-level helpers + constants. Extract from RECOMMENDED_SUFFIX through the
// end of isForeverCommand (contiguous region of pure declarations, no
// interleaving executable statements).
const regionStart = src.indexOf("const RECOMMENDED_SUFFIX");
const regionEnd = blockEndAt("function isForeverCommand");
const helperRegion = src.slice(regionStart, regionEnd);

const mod = `${helperRegion}\nexport { RECOMMENDED_SUFFIX, isRecommendedLabel, stripRecommendedSuffix, FREE_TEXT_AUTO_ANSWER, pickAutoAnswers, renderEscalationPrompt, lastUserMessageText, hasUserMessage, hasNewerUserActivity, seedInitialBoundary, isForeverCommand };`;
const tmpUrl = "data:text/javascript;base64," + Buffer.from(mod).toString("base64");
const { pickAutoAnswers, renderEscalationPrompt, FREE_TEXT_AUTO_ANSWER, lastUserMessageText, hasUserMessage, hasNewerUserActivity, seedInitialBoundary, isForeverCommand } = await import(tmpUrl);

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}\n      got      ${a}\n      expected ${e}`); }
}

console.log("## pickAutoAnswers — options");
check("recommended zh half-width", pickAutoAnswers([{ id: "q1", options: [{ label: "A (推荐)", description: "a" }, { label: "B" }] }]),
  { answers: [{ id: "q1", selected: ["A"] }] });
check("recommended en full-width parens", pickAutoAnswers([{ id: "q1", options: [{ label: "X（Recommended）" }, { label: "Y" }] }]),
  { answers: [{ id: "q1", selected: ["X"] }] });
check("no marker -> first option", pickAutoAnswers([{ id: "q1", options: [{ label: "first" }, { label: "second" }] }]),
  { answers: [{ id: "q1", selected: ["first"] }] });
check("plan-review approve wins even when not first", pickAutoAnswers([{ id: "q1", intent: { kind: "plan-review", approve: "Approve plan" }, options: [{ label: "Reject" }, { label: "Approve plan" }] }]),
  { answers: [{ id: "q1", selected: ["Approve plan"] }] });
check("multiSelect batch", pickAutoAnswers([{ id: "q1", multiSelect: true, options: [{ label: "one" }, { label: "two (Recommended)" }] }]),
  { answers: [{ id: "q1", selected: ["two"] }] });
check("label-less option falls back to empty string, not undefined", pickAutoAnswers([{ id: "q1", options: [{ description: "no label" }] }]),
  { answers: [{ id: "q1", selected: [""] }] });
check("mixed labeled + label-less: labeled wins", pickAutoAnswers([{ id: "q1", options: [{ label: "A (推荐)" }, { description: "no label" }] }]),
  { answers: [{ id: "q1", selected: ["A"] }] });

console.log("## pickAutoAnswers — free text");
check("free text w/ answerFreeText=true -> custom grant", pickAutoAnswers([{ id: "q1", question: "which dir?" }], { answerFreeText: true }),
  { answers: [{ id: "q1", selected: [], custom: FREE_TEXT_AUTO_ANSWER }] });
check("free text w/ answerFreeText=false -> null (human)", pickAutoAnswers([{ id: "q1", question: "which dir?" }], { answerFreeText: false }), null);
check("free text default (no opt) -> null (human)", pickAutoAnswers([{ id: "q1", question: "which dir?" }]), null);
check("mixed batch + freeText -> all answered", pickAutoAnswers([
  { id: "o1", options: [{ label: "A (推荐)" }] },
  { id: "t1", question: "elaborate?" }
], { answerFreeText: true }),
  { answers: [{ id: "o1", selected: ["A"] }, { id: "t1", selected: [], custom: FREE_TEXT_AUTO_ANSWER }] });
check("mixed batch w/o freeText -> null (whole batch to human)", pickAutoAnswers([
  { id: "o1", options: [{ label: "A" }] },
  { id: "t1", question: "elaborate?" }
], { answerFreeText: false }), null);
check("empty batch -> empty answers", pickAutoAnswers([], { answerFreeText: true }), { answers: [] });
check("question with null options -> free text path", pickAutoAnswers([{ id: "q1", options: null, question: "huh" }], { answerFreeText: true }),
  { answers: [{ id: "q1", selected: [], custom: FREE_TEXT_AUTO_ANSWER }] });

console.log("## renderEscalationPrompt");
const esc = renderEscalationPrompt(4, "E_BLOCKED", "the tool is permanently denied for this session");
check("mentions failures", esc.includes("4 次"), true);
check("mentions code", esc.includes("E_BLOCKED"), true);
check("mentions message", esc.includes("permanently denied"), true);
check("mentions routing-around", esc.includes("不依赖该失败操作"), true);
check("truncates long message", renderEscalationPrompt(5, "c", "x".repeat(500)).length < 500, true);
check("short message intact", renderEscalationPrompt(2, "c", "short err").includes("short err"), true);

console.log("## lastUserMessageText — dsh real event shapes");
// dsh-session deriveEventMessage: user/message content lives at data.content
// (NO .message wrapper). Regression for the 400-no-retry bug.
const u = (seq, text, kind = "user") => ({ seq, type: "user/message", data: { content: [{ type: "text", text }], source: { kind }, role: "user", id: String(seq) } });
check("reads data.content (real dsh shape)", lastUserMessageText([u(1, "你好"), u(2, "接着查")], 0, 99), "接着查");
check("real user msg + trailing plugin snapshot -> real wins",
  lastUserMessageText([u(1, "你好"), u(2, "<runtime>", "plugin"), u(3, "<skill>", "plugin")], 0, 99), "你好");
check("user's own first message alone", lastUserMessageText([u(1, "你好"), u(2, "<skill>", "plugin")], 0, 2), "你好");
check("only plugin-sourced events -> null", lastUserMessageText([u(1, "x", "plugin"), u(2, "y", "plugin")], 0, 99), null);
check("seq range fromSeq respected (skip seq<2)", lastUserMessageText([u(1, "a"), u(2, "b")], 2, 99), "b");
check("seq range toSeq respected (stop before seq2)", lastUserMessageText([u(1, "a"), u(2, "b")], 0, 2), "a");
check("empty range -> null", lastUserMessageText([u(1, "a")], 5, 6), null);
check("no text block -> contributes nothing then later one wins",
  lastUserMessageText([
    { seq: 1, type: "user/message", data: { content: [{ type: "image", image: {} }], source: { kind: "user" } } },
    u(2, "hi")
  ], 0, 99), "hi");
check("no user/message at all -> null", lastUserMessageText([{ seq: 1, type: "assistant/message", data: { message: { content: [{ type: "text", text: "x" }] } } }], 0, 99), null);
// The exact legacy buggy read (data.message.content) must NOT satisfy the
// function — a stale-wrapper-only event yields nothing.
check("stale .message wrapper (pre-bug shape) does not match", lastUserMessageText([{ seq: 1, type: "user/message", data: { message: { content: [{ type: "text", text: "stale" }] } } }], 0, 99), null);

console.log("## hasUserMessage — plugin injections do not count as a real user");
const um = (seq, text, kind = "user") => ({ seq, type: "user/message", data: { content: [{ type: "text", text }], source: { kind } } });
check("real user message -> true", hasUserMessage([um(1, "你好")]), true);
check("loop continuation (source user) -> true", hasUserMessage([um(1, "继续", "user")]), true);
check("empty log -> false", hasUserMessage([]), false);
check("only plugin snapshots -> false", hasUserMessage([um(1, "<runtime>", "plugin"), um(2, "<skill>", "plugin")]), false);
check("plugin first, then real user -> true", hasUserMessage([um(1, "<runtime>", "plugin"), um(2, "你好")]), true);
check("non-message events only -> false", hasUserMessage([{ seq: 1, type: "turn/start", data: {} }]), false);

console.log("## seedInitialBoundary — fresh attach over pre-existing history");
const te = (seq, kind) => ({ seq, type: "turn/end", data: { reason: { kind } } });
const am = (seq) => ({ seq, type: "assistant/message", data: { message: { content: [{ type: "text", text: "x" }] } } });
// fresh empty session
check("empty log -> 0", seedInitialBoundary([]), 0);
// single completed round: boundary 0 so the whole (single-round) history is round 1
check("single completed round -> 0", seedInitialBoundary([am(1), te(5, "completed")]), 0);
// two completed rounds: start at the first so only the LAST round feeds round 1
check("two completed rounds -> first turn/end seq", seedInitialBoundary([te(3, "completed"), am(4), te(9, "completed")]), 3);
// last round errored: retry target preserved (boundary = second-to-last end)
check("completed then error -> second-to-last seq", seedInitialBoundary([te(3, "completed"), am(4), te(9, "error")]), 3);
// trailing aborted (user stop): consume it, do NOT re-halt on re-enable
check("completed then aborted tail -> past the abort", seedInitialBoundary([te(3, "completed"), am(4), te(9, "aborted")]), 10);
check("aborted only -> past the abort", seedInitialBoundary([te(3, "aborted")]), 4);
// trailing interrupted (crash-orphaned): consume it too
check("completed then interrupted tail -> past the interrupt", seedInitialBoundary([te(3, "completed"), te(9, "interrupted")]), 10);
// completed -> aborted -> completed again: the pre-stop round is consumed;
// boundary sits past the abort so only the post-stop round feeds round 1
check("completed aborted completed -> past the abort", seedInitialBoundary([te(3, "completed"), te(9, "aborted"), am(10), te(15, "completed")]), 10);
// all stale tail with two drivable before it: boundary past stale, not before it
check("stale tail after two drivable -> past the stale tail", seedInitialBoundary([te(3, "completed"), te(9, "error"), te(15, "aborted")]), 16);
// interleaved stale in the middle does not advance past later drivable turns
check("aborted in middle, later completed -> second-to-last drivable", seedInitialBoundary([te(3, "aborted"), te(5, "completed"), te(9, "completed")]), 5);

console.log("## hasNewerUserActivity — mid-backoff interjection");
const act = [
  { seq: 1, type: "turn/end", data: { reason: { kind: "error" } } },        // errored turn, below boundary
  { seq: 2, type: "agent/inbox/spliced", data: { inserted: [{ id: "m" }] } }, // user msg queued while asleep
  { seq: 3, type: "turn/start", data: { turn: 9 } },
  { seq: 4, type: "user/message", data: { content: [{ type: "text", text: "帮我查" }] } }
];
check("running user turn (splice, no turn/end yet) supersedes", hasNewerUserActivity(act, 2), true);
check("user/message at boundary supersedes", hasNewerUserActivity(act, 4), true);
check("activity below boundary does not count",
  hasNewerUserActivity([{ seq: 1, type: "user/message", data: {} }, { seq: 2, type: "turn/end", data: {} }], 3), false);
check("nothing at/after boundary -> false", hasNewerUserActivity(act, 5), false);
check("empty log -> false", hasNewerUserActivity([], 0), false);
check("only non-user events at/after -> false",
  hasNewerUserActivity([{ seq: 1, type: "turn/start", data: {} }, { seq: 2, type: "assistant/message", data: {} }], 0), false);
check("error turn/end at/after does not count by itself",
  hasNewerUserActivity([{ seq: 1, type: "turn/end", data: { reason: { kind: "error" } } }], 1), false);

// Plugin-injected events must not masquerade as a real user interjection
// (mirrors the filter in hasUserMessage / lastUserMessageText). Without
// this, a dsh snapshot injected during backoff would skip a legitimate retry.
check("plugin-injected user/message does not count",
  hasNewerUserActivity([{ seq: 1, type: "user/message", data: { source: { kind: "plugin" } } }], 0), false);
check("plugin-injected splice (all entries plugin) does not count",
  hasNewerUserActivity([{ seq: 1, type: "agent/inbox/spliced", data: { inserted: [{ source: { kind: "plugin" } }] } }], 0), false);
check("real user/message still counts alongside plugin-injected one",
  hasNewerUserActivity([
    { seq: 1, type: "user/message", data: { source: { kind: "plugin" } } },
    { seq: 2, type: "user/message", data: { content: [{ type: "text", text: "hi" }] } }
  ], 0), true);
check("splice with one real + one plugin entry counts as real activity",
  hasNewerUserActivity([{ seq: 1, type: "agent/inbox/spliced", data: { inserted: [{ source: { kind: "plugin" } }, { source: { kind: "user" } }] } }], 0), true);

console.log("\n## isForeverCommand");
check("/forever exact match", isForeverCommand("/forever"), true);
check("/FOREVER case insensitive", isForeverCommand("/FOREVER"), true);
check("/Forever mixed case", isForeverCommand("/Forever"), true);
check("/forever with leading whitespace", isForeverCommand("  /forever"), true);
check("/forever with trailing whitespace", isForeverCommand("/forever  "), true);
check("/forever with extra text after", isForeverCommand("/forever please"), true);
check("/forever with tab and newline", isForeverCommand("\t/forever\n"), true);
check("non-string input returns false", isForeverCommand(null), false);
check("empty string returns false", isForeverCommand(""), false);
check("different command returns false", isForeverCommand("/help"), false);
check("partial match returns false", isForeverCommand("/for"), false);
check("/forever without leading slash returns false", isForeverCommand("forever"), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
