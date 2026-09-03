import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

//#region lib/types/patch-state.js
/**
 * Read and write the `loop-runner` row's `disabled` flag in a profile's
 * user-layer patch file.
 *
 * The browser half needs a truthful "is the loop on?" answer and a way to
 * flip it, but the flag lives in the *user* layer of the composed tree
 * (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`), not in this bundle's
 * own patch. Cordis composes that file after every bundle layer, so a
 * row-level override there is what actually decides whether `loop-runner`
 * mounts. Reading it back is therefore the only honest answer to "on or
 * off?" — asking the bundle whether *it* was mounted would report "on"
 * for a row the user layer has already disabled in the next boot's plan.
 *
 * The edit is deliberately textual rather than a YAML round-trip: the
 * file is a person's own layer, full of their comments and ordering, and
 * a serializer would rewrite all of it. Only the `loop-runner` entry is
 * touched, and it is written in the same two-line shape a person would.
 *
 * @module @tyza66/dsh-loop-agent/patch-state
 */

/** Marker comment that brackets the block this module owns. */
const BEGIN = "# >>> dsh-loop-agent: endless-loop switch (editable; keep these two lines)";
const END = "# <<< dsh-loop-agent";

/** The exact override block for one state. */
function blockFor(disabled) {
  return [
    BEGIN,
    "- id: loop-runner",
    `  disabled: ${disabled ? "true" : "false"}`,
    END
  ].join("\n");
}

/**
 * Absolute path of a profile's user-layer patch file.
 * @param profile - profile name; defaults to `web`, the profile this
 * bundle targets.
 * @returns the path, whether or not the file exists yet.
 */
function patchPath(profile = "web") {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, "profiles", profile, "cordis.patch.yml");
}

/**
 * Whether the user layer currently disables `loop-runner`.
 *
 * An absent file, an absent block, and a block that says `false` all mean
 * "enabled" — and so does any block this module cannot parse, because a
 * value it does not understand is a person's own override, which must win
 * over the bundle's assumption. Only an explicit `disabled: true` reads
 * as off.
 *
 * @param profile - profile name.
 * @returns true when the user layer disables the row.
 */
function readDisabled(profile = "web") {
  const path = patchPath(profile);
  if (!existsSync(path)) return false;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const start = text.indexOf(BEGIN);
  if (start < 0) return false;
  const end = text.indexOf(END, start);
  if (end < 0) return false;
  return /disabled:\s*true/.test(text.slice(start, end));
}

/**
 * Set the `loop-runner` row's `disabled` flag in the user layer.
 *
 * Replaces the owned block in place when one exists, removes it when
 * `disabled` is false (so an enabled loop leaves no override behind — the
 * bundle's own `disabled: false` is then what composes), and appends it
 * when the file has no block yet. The file's other entries and comments
 * are preserved byte for byte.
 *
 * @param disabled - whether to disable the row.
 * @param profile - profile name.
 * @returns the resulting state, for the caller to report back.
 */
function writeDisabled(disabled, profile = "web") {
  const path = patchPath(profile);
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  const start = original.indexOf(BEGIN);
  const end = start < 0 ? -1 : original.indexOf(END, start);
  let next;
  if (start >= 0 && end >= 0) {
    const head = original.slice(0, start);
    const tail = original.slice(end + END.length);
    const body = disabled ? `${blockFor(true)}\n` : "";
    /* Trim the blank line the removed block leaves, so repeated toggles
     * do not accrete whitespace at the seam. */
    next = `${head.replace(/\n+$/, "\n")}${body}${tail.replace(/^\n+/, "")}`;
  } else if (disabled) {
    const separator = original.length === 0 || original.endsWith("\n") ? "" : "\n";
    next = `${original}${separator}\n${blockFor(true)}\n`;
  } else {
    /* Nothing to clear and nothing to add: already enabled. */
    next = original;
  }
  if (next !== original) writeFileSync(path, next, "utf8");
  return { disabled, changed: next !== original, path };
}
//#endregion

export { BEGIN, END, blockFor, patchPath, readDisabled, writeDisabled };
