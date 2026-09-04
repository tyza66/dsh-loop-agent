// dsh-loop-agent — runtime disabled-state storage.
//
// The endless loop's on/off state lives in a JSON sidecar file under the
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
//   2. The state is a single boolean the agent driver reads on every turn
//      boundary, not a loader patch row. Putting it in a sidecar keeps the
//      loader tree clean (no per-toggle file rewrites triggering loader
//      reconciliation) and the format easy to extend (a future field can
//      sit next to `disabled` without a schema migration).
//
// The file path is `$DSH_HOME/profiles/<profile>/.dsh-loop-agent.json` (the
// same `$DSH_HOME` the launcher uses, default `~/.dsh`). Writes go through
// a temp + rename so a torn read never observes a partial JSON. A read
// that fails to parse falls back to the default (`disabled: false`) so a
// hand-edited or corrupted file never wedges the driver.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve the absolute path of the sidecar file for the given profile name.
 * @param profile - profile name; defaults to `web` to match the row default.
 * @returns absolute path of the JSON file.
 */
function resolveStatePath(profile) {
  const root = process.env.DSH_HOME || join(homedir(), ".dsh");
  const name = profile || "web";
  return join(root, "profiles", name, ".dsh-loop-agent.json");
}

/**
 * Read the current disabled state for the profile. Missing or unreadable
 * files mean "not disabled" — the default keeps a fresh install running.
 * @param profile - profile name.
 * @returns `true` when the loop should be inert this phase.
 */
function readDisabled(profile = "web") {
  const path = resolveStatePath(profile);
  if (!existsSync(path)) return false;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data?.disabled === true;
  } catch {
    return false;
  }
}

/**
 * Write the disabled state for the profile. Skips the rename when the
 * value already matches, so a no-op toggle is cheap and reports
 * `changed: false` to the UI.
 * @param disabled - the new disabled value (coerced to a strict boolean).
 * @param profile - profile name.
 * @returns absolute path of the file and whether the write changed it.
 */
function writeDisabled(disabled, profile = "web") {
  const path = resolveStatePath(profile);
  const value = disabled === true;
  const previous = readDisabled(profile);
  if (previous === value) {
    return { path, changed: false };
  }
  const serialized = JSON.stringify({
    disabled: value,
    updatedAt: new Date().toISOString()
  }, null, 2) + "\n";
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp-" + process.pid;
  writeFileSync(tmp, serialized);
  renameSync(tmp, path);
  return { path, changed: true };
}
//#endregion
export { readDisabled, writeDisabled };
