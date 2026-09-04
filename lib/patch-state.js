// dsh-loop-agent — runtime state storage.
//
// The endless loop's runtime state lives in a JSON sidecar file under the
// active profile, not in the profile's `cordis.patch.yml`. Two reasons:
//
//   1. The plugin is registered with `disabled: false` in the bundle patch,
//      and the plugin's own settings UI is what flips that flag. Writing the
//      flag back into the user-layer patch would unmount the plugin fiber —
//      and with it the webserver routes the UI talks to — turning the toggle
//      into a one-way switch. A sidecar file is just data, so the plugin
//      stays mounted, the routes stay live, and disabling becomes a runtime
//      gate the driver honors each phase.
//
//   2. The state is a small set of fields the agent driver reads on every
//      turn boundary (`disabled`, plus an optional runtime override of the
//      continuation prompt), not loader patch rows. Putting them in a
//      sidecar keeps the loader tree clean (no per-toggle file rewrites
//      triggering loader reconciliation) and the format easy to extend (a
//      future field can sit next to `disabled` without a schema migration).
//
// The file path is `$DSH_HOME/profiles/<profile>/.dsh-loop-agent.json` (the
// same `$DSH_HOME` the launcher uses, default `~/.dsh`). Writes go through
// a temp + rename so a torn read never observes a partial JSON. A read
// that fails to parse falls back to the defaults (`disabled: false`, no
// prompt override) so a hand-edited or corrupted file never wedges the
// driver.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Resolve the absolute path of the sidecar file for the given profile name. */
function resolveStatePath(profile) {
  const root = process.env.DSH_HOME || join(homedir(), ".dsh");
  const name = profile || "web";
  return join(root, "profiles", name, ".dsh-loop-agent.json");
}

/**
 * Parse the sidecar file, or return the defaults when it is missing or
 * unreadable. A malformed `continuation` (non-string or all whitespace)
 * is treated as "no override" so a hand-edited file cannot poison the
 * driver's prompt rendering.
 * @param profile - profile name.
 * @returns the parsed state with defaults applied.
 */
function readState(profile = "web") {
  const path = resolveStatePath(profile);
  if (!existsSync(path)) {
    return { disabled: false, continuation: null };
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const continuation = typeof data?.continuation === "string" ? data.continuation.trim() : "";
    return {
      disabled: data?.disabled === true,
      continuation: continuation === "" ? null : continuation
    };
  } catch {
    return { disabled: false, continuation: null };
  }
}

/**
 * Whether the loop should be inert right now. Missing or unreadable files
 * mean "not disabled" — the default keeps a fresh install running.
 * @param profile - profile name.
 * @returns `true` when the driver should stop queueing continuations.
 */
function readDisabled(profile = "web") {
  return readState(profile).disabled;
}

/**
 * The user's runtime continuation override, or `null` when none is set
 * (the driver then falls back to the row's `config.continuation`).
 * @param profile - profile name.
 * @returns the override template text, or `null`.
 */
function readContinuationOverride(profile = "web") {
  return readState(profile).continuation;
}

/**
 * Merge a partial update into the sidecar state and persist it. Writes
 * are skipped when the merged value equals what is already stored, so a
 * no-op toggle or identical prompt save reports `changed: false`.
 * @param profile - profile name.
 * @param patch - partial state: `{ disabled?, continuation? }`; an
 * `undefined` field is left untouched.
 * @returns absolute path of the file and whether the write changed it.
 */
function writeState(profile, patch) {
  const path = resolveStatePath(profile);
  const current = readState(profile);
  const next = {
    disabled: patch.disabled === undefined ? current.disabled : patch.disabled === true,
    continuation: patch.continuation === undefined ? current.continuation : (typeof patch.continuation === "string" ? (patch.continuation.trim() || null) : null)
  };
  const changed = next.disabled !== current.disabled || next.continuation !== current.continuation;
  if (!changed) return { path, changed: false };
  const payload = { disabled: next.disabled };
  if (next.continuation !== null) payload.continuation = next.continuation;
  payload.updatedAt = new Date().toISOString();
  const serialized = JSON.stringify(payload, null, 2) + "\n";
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp-" + process.pid;
  writeFileSync(tmp, serialized);
  renameSync(tmp, path);
  return { path, changed: true };
}

/**
 * Persist the disabled state for the profile.
 * @param disabled - the new disabled value (coerced to a strict boolean).
 * @param profile - profile name.
 * @returns `{ path, changed }` for the caller to report back.
 */
function writeDisabled(disabled, profile = "web") {
  return writeState(profile, { disabled: disabled === true });
}

/**
 * Persist a runtime continuation override for the profile. An empty or
 * whitespace-only value clears the override (the driver falls back to the
 * row's configured default).
 * @param continuation - the override template text, or "" to clear it.
 * @param profile - profile name.
 * @returns `{ path, changed }` for the caller to report back.
 */
function writeContinuation(continuation, profile = "web") {
  return writeState(profile, { continuation });
}
//#endregion
export { readState, readDisabled, readContinuationOverride, writeState, writeDisabled, writeContinuation };
