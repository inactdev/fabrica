// `fabrica up`'s hook into this integration: starts the watcher in the
// background, the same detached way `fabrica up` already starts the
// live view (src/cli/spawn-detached.ts's spawnDetachedScript), the
// moment it detects it's running inside a Herdr pane - Herdr sets
// HERDR_ENV=1 and HERDR_PANE_ID in every process it starts, per
// README.md's "Starting it" - and only if nothing equivalent is already
// running for this record home (herdr-watcher.ts's own
// herdrWatcherStatus, backed by a pid file). If that status comes back
// "exited" rather than "never-started" - a watcher really was running
// for this record home and is gone now, not just never started -
// `fabrica up` says so via `notify` before starting a fresh one, rather
// than silently restarting as if nothing happened. Discovered
// generically by src/cli/up-command.ts scanning integrations/ for a
// <name>/up-hook.ts exporting `maybeStart` - the same shape, and the
// same reason (CONTRACT rule 8's brain-word scan - see
// no-herdr-in-core.test.ts), that skill/<harness>/launch.ts is
// discovered by scanning skill/ instead. Its own tests
// (up-hook.test.ts) use injected fakes for the status check and the
// spawn itself; herdr-watcher.test.ts covers the real pid-file liveness
// check separately.

import { fileURLToPath } from "node:url";
import { spawnDetachedScript } from "../../src/cli/spawn-detached.ts";
import { herdrWatcherLogPath, herdrWatcherStatus, type HerdrWatcherStatus } from "./herdr-watcher.ts";

const WATCHER_ENTRY_SCRIPT = fileURLToPath(new URL("./herdr-watcher.ts", import.meta.url));

function runningInsideHerdrPane(env: NodeJS.ProcessEnv): boolean {
  return env.HERDR_ENV === "1" && (env.HERDR_PANE_ID ?? "").trim().length > 0;
}

export interface MaybeStartOptions {
  recordHome: string;
  env: NodeJS.ProcessEnv;
  /** Where fabrica up's own output goes - matches
   * src/cli/up-command.ts's UpIntegrationHook shape. Defaults to doing
   * nothing, so a caller that doesn't care about messages (e.g. an old
   * test) isn't forced to supply one. */
  notify?: (line: string) => void;
}

/** Test-only seams, overriding the real status check and the real
 * detached spawn - the same way runUpCommand's own options override its
 * live-view probe and spawn. */
export interface MaybeStartDeps {
  status?: (recordHome: string) => HerdrWatcherStatus;
  spawn?: (opts: { recordHome: string; entryScript: string; env?: NodeJS.ProcessEnv }) => void;
}

/** Called unconditionally by `fabrica up` after the live view step.
 * Does nothing, silently, unless this process is running inside a
 * Herdr pane. Within that, three cases: a watcher is already running
 * (do nothing); none has ever run for this record home (start one,
 * silently - the ordinary first-start case); one ran before and has
 * since exited (notify, then start a fresh one). */
export async function maybeStart(opts: MaybeStartOptions, deps: MaybeStartDeps = {}): Promise<void> {
  if (!runningInsideHerdrPane(opts.env)) return;

  const status = (deps.status ?? herdrWatcherStatus)(opts.recordHome);
  if (status === "running") return;

  const notify = opts.notify ?? (() => {});
  if (status === "exited") {
    notify(`fabrica up: the Herdr watcher had exited - starting a new one. See ${herdrWatcherLogPath(opts.recordHome)} for details.`);
  }

  const spawn = deps.spawn ?? spawnDetachedScript;
  spawn({ recordHome: opts.recordHome, entryScript: WATCHER_ENTRY_SCRIPT, env: { FABRICA_HOME: opts.recordHome } });
}
