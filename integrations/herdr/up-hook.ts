// `fabrica up`'s hook into this integration: starts the watcher in the
// background, the same detached way `fabrica up` already starts the
// live view (src/cli/spawn-detached.ts's spawnDetachedScript), the
// moment it detects it's running inside a Herdr pane - Herdr sets
// HERDR_ENV=1 and HERDR_PANE_ID in every process it starts, per
// README.md's "Starting it" - and only if nothing equivalent is already
// running for this record home (herdr-watcher.ts's own
// isHerdrWatcherRunning, backed by a pid file). Discovered generically
// by src/cli/up-command.ts scanning integrations/ for a <name>/
// up-hook.ts exporting `maybeStart` - the same shape
// skill/<harness>/launch.ts is discovered by - so src/ never has to
// name this integration (see no-herdr-in-core.test.ts).

import { fileURLToPath } from "node:url";
import { spawnDetachedScript } from "../../src/cli/spawn-detached.ts";
import { isHerdrWatcherRunning } from "./herdr-watcher.ts";

const WATCHER_ENTRY_SCRIPT = fileURLToPath(new URL("./herdr-watcher.ts", import.meta.url));

function runningInsideHerdrPane(env: NodeJS.ProcessEnv): boolean {
  return env.HERDR_ENV === "1" && (env.HERDR_PANE_ID ?? "").trim().length > 0;
}

export interface MaybeStartOptions {
  recordHome: string;
  env: NodeJS.ProcessEnv;
}

/** Test-only seams, overriding the real liveness check and the real
 * detached spawn - the same way runUpCommand's own options override its
 * live-view probe and spawn. */
export interface MaybeStartDeps {
  isAlreadyRunning?: (recordHome: string) => boolean;
  spawn?: (opts: { recordHome: string; entryScript: string; env?: NodeJS.ProcessEnv }) => void;
}

/** Called unconditionally by `fabrica up` after the live view step.
 * Does nothing, silently, unless both are true: this process is running
 * inside a Herdr pane, and no watcher is already running for this
 * record home. */
export async function maybeStart(opts: MaybeStartOptions, deps: MaybeStartDeps = {}): Promise<void> {
  if (!runningInsideHerdrPane(opts.env)) return;

  const isAlreadyRunning = deps.isAlreadyRunning ?? isHerdrWatcherRunning;
  if (isAlreadyRunning(opts.recordHome)) return;

  const spawn = deps.spawn ?? spawnDetachedScript;
  spawn({ recordHome: opts.recordHome, entryScript: WATCHER_ENTRY_SCRIPT, env: { FABRICA_HOME: opts.recordHome } });
}
