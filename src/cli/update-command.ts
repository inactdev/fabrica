// `fabrica update`: pulls in new Fabrica code without losing a running
// `fabrica up` session - issue "add fabrica update and fabrica up
// --continue". Works out which kind of copy is running the exact same
// way `fabrica doctor`'s own "checkout" check does (doctor-command.ts's
// detectCopy): a developer checkout (a real .git) is updated with `git
// pull --ff-only origin master`, refusing first if it isn't on master or
// has uncommitted changes (a fast-forward pull on a dirty tree, or one
// not tracking master's history, is exactly the kind of surprise this
// refuses rather than risks); an installed copy is replaced with the
// current code at `github:inactdev/fabrica` in two npm steps - pack the
// spec into a throwaway directory, then install that tarball
// (global-reinstall.ts, which carries the reason one `npm install -g
// github:...` cannot do it).
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
// Once Fabrica's own code is updated, the installed Inspector is brought
// forward with it (`updateInspector`): Fabrica and Inspector keep a
// ratified, hand-synced agreement about the call between them
// (src/inspector/consumer-contract.json), so updating one and not the
// other is how that agreement breaks. Whether an Inspector is behind is
// not decided here - it is `inspectorVersionCheck`'s answer, the same one
// `fabrica doctor`'s inspector line prints, so the line that FAILs on a
// stale binary and the step that replaces it can never disagree. The
// Inspector step can never fail the update - the worst case warns and
// leaves the install alone.
//
// Then the live view is brought in line with the new code -
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
import {
  goInstallInspector,
  inspectorInstallCommand,
  inspectorVersionCheck,
  realInspectorVersionProbes,
  INSPECTOR_MODULE_PATH,
  type InspectorVersionProbes,
} from "../index.ts";
import { CliError } from "./errors.ts";
import { resolveRecordHome } from "./record-home.ts";
import { detectCopy, git, short, type CopyInfo } from "./doctor-command.ts";
import { commandFailureMessage, realGlobalReinstallIo, reinstallGlobalCopy } from "./global-reinstall.ts";
import { INSTALL_SPEC, prefixOfGlobalInstall } from "./npm-prefix.ts";
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
       - Installed: builds the published tarball from
         \`github:inactdev/fabrica\` into a throwaway directory (\`npm
         pack\`) and installs that tarball globally, with \`--prefix\`
         set to the prefix this copy is installed under rather than
         npm's default - so a copy installed outside that default (on
         a host whose default prefix is read-only, say) updates where
         it actually lives. Two steps rather than one \`npm install -g
         github:...\` because that form installs a symlink to a clone
         npm then deletes, leaving the command broken. A copy that is
         neither of the two - \`npx\` runs one out of its own cache -
         is refused.
  2. Brings the installed Inspector forward too, since the two sides
     agree on the exact shape of the call between them: it reads the
     commit the installed \`inspector\` was built from, reads the tip of
     \`inactdev/inspector\`'s own main, and runs \`go install
     github.com/inactdev/inspector/cmd/inspector@<that commit>\` when
     the installed one is genuinely behind it, or when none is
     installed at all. One ahead of main, built from a branch, or built
     from a local source tree is left exactly as it is. There is no
     flag to skip this. Nothing here can fail the update: no network,
     or a \`go install\` that fails, warns and leaves the installed
     Inspector alone.
  3. Brings the live view on 127.0.0.1:7777 in line with the code that
     just landed - the same check and restart \`fabrica up\` itself
     runs. If the commit changed, whatever is listening is restarted
     and one that wasn't running is started; there is no flag to skip
     that, because a page served by the code you just replaced is worse
     than no page. If the commit did not change, a live view running
     older code (checked via its own /api/version) is still replaced,
     and one already current, or not running at all, is left alone.
  4. Prints one summary line: the commit before and after, the
     installed Inspector before and after, whether the live view was
     restarted, started or left as is, and the exact next step.

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
  /** Replaces the installed copy under one npm prefix - the one the
   * running copy is installed under - with the current code at the
   * documented spec, as global-reinstall.ts's two npm steps. A
   * failure's `message` already names the exact command that failed.
   * Installed-copy only. */
  reinstall(prefix: string): { ok: boolean; message: string };
  /** Inspector's side of the same update (see `updateInspector`). */
  inspector: InspectorUpdateProbes;
}

/** The installed Inspector's own build, main's tip and how the two are
 * ordered - the same three facts `fabrica doctor`'s inspector line
 * reads - plus the one action only `fabrica update` takes. */
export interface InspectorUpdateProbes extends InspectorVersionProbes {
  /** Runs `go install github.com/inactdev/inspector/cmd/inspector@<revision>`.
   * Reported, never thrown. */
  install(revision: string): { ok: boolean; message: string };
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

export const realProbes: UpdateProbes = {
  copy: () => detectCopy(CHECKOUT, (args) => git(CHECKOUT, args)),
  isDirty: gitStatusDirty,
  pull: gitPullFfOnly,
  reinstall: (prefix) => reinstallGlobalCopy(prefix, realGlobalReinstallIo),
  inspector: { ...realInspectorVersionProbes(), install: (revision) => goInstallInspector(revision) },
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
      // The message already names the exact npm command that failed -
      // reinstalling is two of them now, and only the step that really
      // ran knows which one it was.
      stderr(`fabrica update: ${result.message}`);
      return 1;
    }
  }

  const after = probes.copy();

  // Inspector comes forward with Fabrica itself: the two sides agree on
  // the flags, exit codes and stdout line of the call between them
  // (src/inspector/consumer-contract.json), so leaving one behind is how
  // that agreement breaks. Unconditional, with no flag to skip it
  // (Client ruling: "update means everything comes forward"), and never
  // able to fail the update - the worst it does is say what it could not
  // do and leave the installed Inspector exactly as it was.
  const inspector = updateInspector(probes.inspector, stderr);

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
    `fabrica update: ${short(before.commit)} -> ${short(after.commit)} - ${describeInspectorOutcome(inspector)} - ` +
      `live view ${describeLiveViewOutcome(outcome)}. Resume your session with: fabrica up --continue`
  );
  return 0;
}

/** What `fabrica update` did about the installed Inspector. */
export type InspectorUpdateOutcome =
  /** `from` is null when nothing was installed before. */
  | { kind: "installed"; from: string | null; to: string }
  | { kind: "current"; commit: string }
  /** Deliberately untouched, for a reason the Client was told in full on
   * stderr; `label` is that reason short enough for the summary line. */
  | { kind: "left-alone"; label: string }
  | { kind: "install-failed"; from: string | null };

/** Brings the installed Inspector up to its own main's tip, or says why
 * it didn't. Nothing here can fail `fabrica update` (Client ruling): a
 * network that can't be reached, a `go install` that fails, a binary
 * built from a local tree - each warns, leaves the install alone, and
 * returns an outcome the summary line reports honestly.
 *
 * The install only ever happens for the two states where main's tip is
 * strictly better than what is there: nothing installed at all, and a
 * commit that really is an ancestor of main. An Inspector ahead of
 * main, on a branch, or built locally is left exactly as it is -
 * installing main's tip over it would be a silent downgrade of a binary
 * someone put there on purpose. */
export function updateInspector(probes: InspectorUpdateProbes, warn: (line: string) => void): InspectorUpdateOutcome {
  const build = probes.build();

  // Nothing installed at all: there is no commit to classify, so this is
  // the one path that doesn't go through inspectorVersionCheck.
  if (build === null) return installFresh(probes, warn);

  // Asked only when there is a commit to compare it against, exactly as
  // doctor's own line asks it.
  const mainCommit = build.commit === null ? null : probes.mainCommit();
  const check = inspectorVersionCheck(build, mainCommit, probes.ancestry);

  switch (check.state) {
    case "current":
      // `current` is reached only from a commit that matched main's tip,
      // so build.commit is never null here.
      return { kind: "current", commit: build.commit as string };

    case "behind":
      // The one state where main's tip is strictly better than what is
      // there. `mainCommit` is non-null: nothing else could have been
      // compared against to reach this.
      return install(probes, warn, mainCommit as string, build.commit);

    case "not-behind":
      warn(`fabrica update: left the installed Inspector alone - ${check.note}. Fabrica itself was still updated.`);
      return { kind: "left-alone", label: "not behind main" };

    case "local-build":
      // Installing main's tip over a binary someone built here on
      // purpose would be a silent downgrade.
      warn(`fabrica update: left the installed Inspector alone - ${check.note}. Fabrica itself was still updated.`);
      return { kind: "left-alone", label: "a local build" };

    // The two ways the comparison itself can come to nothing, kept apart
    // because they fail at different points: main's tip couldn't be read
    // at all, or it could and the ordering couldn't.
    case "no-main":
    case "unknown-ancestry":
      warn(`fabrica update: left the installed Inspector alone - ${check.note}. Fabrica itself was still updated.`);
      return { kind: "left-alone", label: "couldn't check against main" };

    // A binary whose own build record names no commit - a release tag, a
    // `-buildvcs=false` build, or nothing readable at all. There is
    // nothing to compare, so nothing this can honestly act on.
    case "no-commit":
    case "unreadable":
      warn(`fabrica update: left the installed Inspector alone - ${check.note}. Fabrica itself was still updated.`);
      return { kind: "left-alone", label: "no commit to compare with main" };
  }
}

/** Nothing installed: main's tip is unambiguously better than nothing,
 * so it goes in - unless the remote can't be read, which warns. */
function installFresh(probes: InspectorUpdateProbes, warn: (line: string) => void): InspectorUpdateOutcome {
  const mainCommit = probes.mainCommit();
  if (mainCommit === null) {
    warn(
      `fabrica update: no Inspector is installed, and its main could not be read from ${INSPECTOR_MODULE_PATH} ` +
        `(no network, or git unavailable) - nothing was installed. Fabrica itself was still updated.`
    );
    return { kind: "left-alone", label: "couldn't check against main" };
  }
  return install(probes, warn, mainCommit, null);
}

function install(
  probes: InspectorUpdateProbes,
  warn: (line: string) => void,
  target: string,
  from: string | null
): InspectorUpdateOutcome {
  const result = probes.install(target);
  if (!result.ok) {
    warn(
      `fabrica update: ${inspectorInstallCommand(target)} failed: ${result.message} - the installed Inspector was ` +
        `left as it was. Fabrica itself was still updated.`
    );
    return { kind: "install-failed", from };
  }

  // Read back rather than assume: the installed binary's own record is
  // what the next `fabrica doctor` will compare, and if the install
  // somehow landed elsewhere the summary line should say so, not repeat
  // the request.
  const installed = probes.build();
  return { kind: "installed", from, to: installed?.commit ?? target };
}

/** The Inspector segment of the one summary line - before and after
 * whenever something moved, and what was left alone otherwise. */
function describeInspectorOutcome(outcome: InspectorUpdateOutcome): string {
  const was = (from: string | null) => (from === null ? "not installed" : short(from));
  if (outcome.kind === "installed") return `inspector ${was(outcome.from)} -> ${short(outcome.to)}`;
  if (outcome.kind === "current") return `inspector ${short(outcome.commit)} unchanged, already current`;
  if (outcome.kind === "install-failed") return `inspector ${was(outcome.from)} unchanged (install failed)`;
  return `inspector left as is (${outcome.label})`;
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
