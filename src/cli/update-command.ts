// `fabrica update`: pulls in new Fabrica code without losing a running
// `fabrica up` session - issue "add fabrica update and fabrica up
// --continue". Works out which kind of copy is running the exact same
// way `fabrica doctor`'s own "checkout" check does (doctor-command.ts's
// detectCopy): a developer checkout (a real .git) is updated with `git
// pull --ff-only origin master`, refusing first if it isn't on master or
// has uncommitted changes (a fast-forward pull on a dirty tree, or one
// not tracking master's history, is exactly the kind of surprise this
// refuses rather than risks); an installed copy is updated by re-running
// the documented install command, `npm install -g
// github:inactdev/fabrica` (README.md's "Installable from zero").
//
// That install is run with `--prefix` set to the prefix the running
// copy is actually installed under, derived from its own path
// (npm-prefix.ts). npm's own default global prefix is the folder node
// itself sits in, which on a Nix-managed host is a read-only store
// path - so an installed copy living under some other, writable prefix
// is only updatable in place by naming that prefix, and the copy's own
// path is the one thing that knows it. A copy that is neither a
// checkout nor a global install - `npx` runs a throwaway one out of its
// own cache - is refused rather than reinstalled somewhere it never
// lived.
//
// Once the code is updated, the live view is brought in line with it -
// by calling `fabrica up`'s own stale-live-view check (up-command.ts's
// refreshStaleLiveView), never a second copy of that logic. When the
// commit actually changed, that restart is unconditional and a live view
// that wasn't running is started (Client ruling - no opt-out flag):
// updating must never leave the Client reading a page served by the code
// he just replaced, or with no page at all where he had one. When the
// commit did not change (an already-up-to-date pull), the ordinary
// version comparison decides, and a current or absent live view is left
// exactly as it is.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors.ts";
import { resolveRecordHome } from "./record-home.ts";
import { detectCopy, git, short, type CopyInfo } from "./doctor-command.ts";
import { INSTALL_SPEC, installCommandArgs, prefixOfGlobalInstall } from "./npm-prefix.ts";
import { LIVE_VIEW_PORT, refreshStaleLiveView, type LiveViewStaleOutcome } from "./up-command.ts";

export const UPDATE_USAGE = "fabrica update";

export const UPDATE_HELP = `Usage: ${UPDATE_USAGE}

Takes in new Fabrica code without losing a running \`fabrica up\`
session:

  1. Works out which copy is running, the same way \`fabrica doctor\`'s
     own "checkout" check does - a developer checkout (a real .git) or
     an installed copy.
       - Checkout: runs \`git pull --ff-only origin master\` - refused
         first, with a clear message, if the checkout isn't on master
         or has uncommitted changes.
       - Installed: re-runs the documented install command, \`npm
         install -g github:inactdev/fabrica\`, with \`--prefix\` set
         to the prefix this copy is installed under rather than npm's
         default - so a copy installed outside that default (on a host
         whose default prefix is read-only, say) updates where it
         actually lives. A copy that is neither of the two - \`npx\`
         runs one out of its own cache - is refused.
  2. Brings the live view on 127.0.0.1:7777 in line with the code that
     just landed - the same check and restart \`fabrica up\` itself
     runs. If the commit changed, whatever is listening is restarted
     and one that wasn't running is started; there is no flag to skip
     that, because a page served by the code you just replaced is worse
     than no page. If the commit did not change, a live view running
     older code (checked via its own /api/version) is still replaced,
     and one already current, or not running at all, is left alone.
  3. Prints one summary line: the commit before and after, whether the
     live view was restarted, started or left as is, and the exact next
     step.

Resume your session afterward with \`fabrica up --continue\` - your
chat harness's own flag for continuing the most recent conversation in
this folder, so updating never costs you your place.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

/** `fabrica update` takes no flags or positionals - anything given is
 * refused with the exact usage line, matching parseUpArgs. */
export function parseUpdateArgs(argv: string[]): void {
  const [first] = argv;
  if (first === undefined) return;
  if (first.startsWith("-")) {
    throw new CliError("bad-usage", `fabrica update: unknown flag "${first}". Usage: ${UPDATE_USAGE}`);
  }
  throw new CliError("bad-usage", `fabrica update: unexpected argument "${first}" - update takes none. Usage: ${UPDATE_USAGE}`);
}

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The machine-level actions, injectable so tests never run a real
 * `git pull`/`npm install` or depend on this checkout's own git state -
 * the same seam shape as doctor-command.ts's DoctorProbes. */
export interface UpdateProbes {
  /** The same question doctor's own "checkout" check answers - dev
   * checkout vs. installed, and this copy's current commit. Called
   * again after updating to learn the new commit, so it must re-derive
   * live each call, never cache. */
  copy(): CopyInfo;
  /** True when the checkout has uncommitted changes. Dev-checkout
   * only. */
  isDirty(root: string): boolean;
  /** Runs `git pull --ff-only origin master`. Dev-checkout only. */
  pull(root: string): { ok: boolean; message: string };
  /** Runs the documented install command against one npm prefix -
   * the one the running copy is installed under. Installed-copy
   * only. */
  reinstall(prefix: string): { ok: boolean; message: string };
}

function commandFailureMessage(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  if (e?.stderr) return e.stderr.toString().trim();
  return e?.message ?? String(err);
}

function gitStatusDirty(root: string): boolean {
  return execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;
}

function gitPullFfOnly(root: string): { ok: boolean; message: string } {
  try {
    const out = execFileSync("git", ["pull", "--ff-only", "origin", "master"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, message: out.trim() };
  } catch (err) {
    return { ok: false, message: commandFailureMessage(err) };
  }
}

function npmInstallGlobal(prefix: string): { ok: boolean; message: string } {
  try {
    const out = execFileSync("npm", installCommandArgs(prefix), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, message: out.trim() };
  } catch (err) {
    return { ok: false, message: commandFailureMessage(err) };
  }
}

export const realProbes: UpdateProbes = {
  copy: () => detectCopy(CHECKOUT, (args) => git(CHECKOUT, args)),
  isDirty: gitStatusDirty,
  pull: gitPullFfOnly,
  reinstall: npmInstallGlobal,
};

export interface RunUpdateCommandOptions {
  recordHome?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Test-only seam replacing the real detectCopy/git/npm probes. */
  probes?: UpdateProbes;
  /** Test-only: a different port than the documented 7777, the same
   * seam runUpCommand's liveViewPort option provides. */
  liveViewPort?: number;
  /** The remaining options below are forwarded verbatim to
   * refreshStaleLiveView (up-command.ts) - see its own
   * RefreshStaleLiveViewOptions for what each replaces. */
  isLiveViewListening?: (host: string, port: number) => Promise<boolean>;
  fetchLiveViewVersion?: (port: number) => Promise<string | null>;
  findLiveViewProcess?: (recordHome: string) => { pid: number } | null;
  stopLiveViewProcess?: (pid: number) => void;
  startLiveView?: (opts: { recordHome: string; port: number }) => void;
  openBrowser?: (url: string) => void;
  liveViewStartTimeoutMs?: number;
}

/** Returns the process exit code - never throws. */
export async function runUpdateCommand(argv: string[], opts: RunUpdateCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  try {
    parseUpdateArgs(argv);
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const recordHome = opts.recordHome ?? resolveRecordHome();
  const probes = opts.probes ?? realProbes;

  const before = probes.copy();

  if (before.kind === "dev-checkout") {
    if (before.branch !== "master") {
      stderr(
        `fabrica update: this checkout is on "${before.branch || "a detached HEAD"}", not master - ` +
          `switch to master yourself (git checkout master), then try again.`
      );
      return 1;
    }
    if (probes.isDirty(before.root)) {
      stderr(`fabrica update: this checkout has uncommitted changes - commit or stash them yourself, then try again.`);
      return 1;
    }
    const result = probes.pull(before.root);
    if (!result.ok) {
      stderr(`fabrica update: git pull --ff-only origin master failed: ${result.message}`);
      return 1;
    }
  } else {
    const prefix = prefixOfGlobalInstall(before.root);
    if (prefix === null) {
      stderr(
        `fabrica update: this copy of fabrica runs from ${before.root}, which is neither a checkout nor a global ` +
          `npm install (npx, for one, runs a throwaway copy out of its own cache) - fabrica update needs an ` +
          `installed or checked-out copy to update. Install one with: npm install -g ${INSTALL_SPEC}`
      );
      return 1;
    }
    const result = probes.reinstall(prefix);
    if (!result.ok) {
      stderr(`fabrica update: npm ${installCommandArgs(prefix).join(" ")} failed: ${result.message}`);
      return 1;
    }
  }

  const after = probes.copy();

  // Client ruling: when the commit actually changed, restart the live
  // view unconditionally, and start one if none was running - no flag to
  // opt out. The ordinary `/api/version` comparison is still what
  // decides when the commit did NOT change (an already-up-to-date pull,
  // a reinstall of the same commit): a live view from some even older
  // commit still deserves replacing, and one that is current is left
  // alone.
  const commitChanged = before.commit !== after.commit;
  const port = opts.liveViewPort ?? LIVE_VIEW_PORT;
  const outcome = await refreshStaleLiveView({
    recordHome,
    port,
    force: commitChanged,
    startIfStopped: commitChanged,
    isListening: opts.isLiveViewListening,
    fetchLiveViewVersion: opts.fetchLiveViewVersion,
    getRunningCommit: () => after.commit,
    findLiveViewProcess: opts.findLiveViewProcess,
    stopLiveViewProcess: opts.stopLiveViewProcess,
    startLiveView: opts.startLiveView,
    openBrowser: opts.openBrowser,
    startTimeoutMs: opts.liveViewStartTimeoutMs,
  });

  if (outcome === "could-not-identify-process") {
    stderr(
      `fabrica update: a live view is listening on 127.0.0.1:${port}, but it doesn't look like the live view ` +
        `(no matching pid file or process found) - it was left running as-is; restart it yourself if it's stale.`
    );
  }

  stdout(
    `fabrica update: ${short(before.commit)} -> ${short(after.commit)} - live view ${describeLiveViewOutcome(outcome)}. ` +
      `Resume your session with: fabrica up --continue`
  );
  return 0;
}

/** The three words this summary line can end on. "started" is its own
 * word rather than folded into "restarted": nothing was running, so
 * nothing was restarted, and the Client is about to be told a browser
 * tab he never had is now open. */
function describeLiveViewOutcome(outcome: LiveViewStaleOutcome): string {
  if (outcome === "restarted") return "restarted";
  if (outcome === "started") return "started";
  return "left as is";
}
