// `fabrica doctor` (Client ruling 2026-10-10): a preflight that spends
// nothing. One line per check, OK or FAIL with the exact fix, and a
// non-zero exit on any FAIL. `--live` adds the one check that does spend:
// a minimal real call with the worker token (a few cents), reported as
// alive or dead. No check ever prints a token.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  capsActive,
  describeUnmeasured,
  eventsByTask,
  githubTokenStatus,
  inspectorBranchStatus,
  listWorkerNetworks,
  loadConfigOrProblem,
  NETWORK_PRUNE_COMMAND,
  probeWorkerToken,
  readEvents,
  requireGitRoot,
  stateOf,
  unmeasuredSpend,
  relayImageStatus,
  workerCliVersionStatus,
  workerImageStatus,
  workerTokenStatus,
  WORKER_NETWORK_PREFIX,
} from "../index.ts";
import type { WorkerNetwork } from "../index.ts";
import { CliError } from "./errors.ts";
import { dockerDaemonUp } from "./docker-daemon.ts";
import {
  clonePackInstallProcedure,
  GLOBAL_PACKAGE_NAME,
  globalPackagePath,
  normalizedPrefix,
  prefixOfGlobalBin,
  prefixOfGlobalInstall,
  UPSTREAM_BRANCH,
  UPSTREAM_GIT_URL,
} from "./npm-prefix.ts";
import { resolveRecordHome } from "./record-home.ts";

export const DOCTOR_USAGE = "fabrica doctor [--live]";

export const DOCTOR_HELP = `Usage: ${DOCTOR_USAGE}

Checks, without spending anything, that this machine can run tasks: Node,
the copy of fabrica actually running - a developer checkout (branch,
commit) or an installed copy (version, commit), either way compared
against origin/master - any leftover \`npm link\` symlink standing where
an installed copy belongs (which makes the global install fail with
ENOTDIR), Docker, the worker image, the worker CLI version
installed in it, the relay image every task's network goes through, any
Docker network left behind by a task that is no longer running (each
one holds an address pool, so they are counted and the command that
clears them is named), the
worker token, the GitHub token Inspector needs, Inspector itself - on
PATH, taking -branch, and built from the commit its own origin main is
at, a stale binary being a FAIL carrying the exact \`go install\` that
replaces it - every registered project, the caps, and any SPEND UNKNOWN
block. One line per check - OK, or FAIL with the exact fix. Exits
non-zero if anything fails.

The inspector line reports that commit against the tip of its own main
inline, and FAILs - printing the exact \`go install\` command \`fabrica
update\` would run - when Inspector is missing or genuinely behind main.
Behind is an ancestry answer, not two hashes that differ: one ahead of
main, one built from a branch, and one built from a local source tree are
each reported as that and pass, as does a comparison no network could
make.

A projects.toml that will not parse is its own FAIL line, naming the
file, the line the parser stopped on and what it objected to. Every
machine check above it still runs; only the checks that need the file
itself - the per-project ones, the caps, the spend block - are skipped,
since an unreadable file cannot answer them either way.

  --live  Also make one minimal real call with the worker token (a few
          cents) and report whether it is alive or dead.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

export interface DoctorCheck {
  ok: boolean;
  label: string;
  detail: string;
  fix?: string;
  /** Whether a failure here makes a task impossible, and so must stop
   * `fabrica up` from starting a session at all (Client ruling
   * 2026-10-23). Absent means yes - a new check keeps stopping `up`
   * until someone deliberately decides otherwise, rather than the
   * other way round. `false` is for a finding no task needs answered
   * (today: which copy of fabrica is on this disk and how it got
   * there): still a `FAIL` line and still a non-zero exit from
   * `fabrica doctor`, but only a warning printed above the session by
   * `fabrica up`. */
  blocking?: boolean;
  /** Something worth telling the Client even though this check passes -
   * printed as a warning above the session by `fabrica up` (today: being
   * behind origin/master, which `doctor` has always reported as
   * information inside an OK line and never failed). */
  note?: string;
}

/** A failure `fabrica up` must refuse to start a session over, as
 * opposed to one it prints as a warning and carries on past. The one
 * reader of `DoctorCheck.blocking`, so the "absent means blocking"
 * default lives in exactly one place. */
export function stopsATask(check: DoctorCheck): boolean {
  return !check.ok && check.blocking !== false;
}

/** The one warning line `fabrica up` prints above the session for a
 * check that found something but stops no task - a non-blocking failure
 * (with its fix, which is still the thing to do about it, just not
 * now) or a passing check carrying a `note`. Null for a check with
 * nothing to say. */
export function advisoryLine(check: DoctorCheck): string | null {
  if (stopsATask(check)) return null;
  if (!check.ok) return `WARN ${check.label}: ${check.detail}${check.fix ? ` - fix: ${check.fix}` : ""}`;
  return check.note ? `WARN ${check.label}: ${check.note}` : null;
}

/** The machine-level checks, injectable so tests never depend on this
 * machine's Docker, tokens, or PATH. */
export interface DoctorProbes {
  node(): DoctorCheck;
  checkout(): DoctorCheck;
  /** A leftover `npm link` symlink sitting where an installed copy
   * belongs (issue #171) - any global install of `fabrica` fails with
   * ENOTDIR while one is there, and the fix is one command. */
  npmLink(): DoctorCheck;
  docker(): DoctorCheck;
  workerImage(): DoctorCheck;
  /** The CLI version actually installed in the worker image, against
   * the version its Dockerfile pins (issue #186). */
  workerCli(): DoctorCheck;
  /** The image every task's relay container runs from (issue #186) -
   * missing, no task can start its relay at all. */
  relayImage(): DoctorCheck;
  /** Docker networks left behind by tasks that are no longer running.
   * Each one holds an address pool Docker cannot hand out again, so
   * enough of them and no task can open a network at all. Needs the
   * record to tell a leftover from a running task's own network, hence
   * the recordHome. */
  workerNetworks(recordHome: string): Promise<DoctorCheck>;
  workerToken(recordHome: string): DoctorCheck;
  githubToken(): DoctorCheck;
  /** Inspector on PATH, taking -branch, and not behind its own main -
   * which is a real FAIL, so `fabrica up` stops on a stale Inspector
   * (src/inspector/doctor-checks.ts). */
  inspector(): DoctorCheck;
  live(recordHome: string): Promise<DoctorCheck>;
}

const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `fabrica` can run from two different kinds of copy (issue: installable
 * from zero): a developer's own checkout, linked in with `npm link` (has
 * a real `.git`, lives on a branch, moves every time the checkout does),
 * or a frozen copy npm extracted (no `.git` at all - npm's packing strips
 * it, and sets no `gitHead` either, verified against a real global
 * install - so its commit comes from `build-info.json` instead, written
 * at `prepare` time by `scripts/write-build-info.mjs` while `.git` still
 * existed, before that strip). */
export interface CopyInfo {
  kind: "dev-checkout" | "installed";
  root: string;
  branch: string | null;
  commit: string | null;
  version: string;
  /** Installed copies with no commit to report: why, in the words of
   * whatever could not produce one - the named failure
   * `build-info.json` itself records when the `prepare` step had no
   * source for the commit, or the absence of that file. Left unset
   * whenever `commit` is a real commit. */
  commitUnknownReason?: string;
}

/** The Node version the check box runs - .inspector.json's image tag - is
 * the one this suite is known to pass on. */
export function nodeCheck(actual: string, expected: string | null): DoctorCheck {
  const label = "node";
  if (expected === null) return { ok: true, label, detail: `${actual} (no pinned version found to compare with)` };
  const have = actual.replace(/^v/, "");
  return have === expected
    ? { ok: true, label, detail: `v${have}, the version the check box runs` }
    : { ok: false, label, detail: `v${have}, but the check box runs ${expected}`, fix: `install Node ${expected}` };
}

/** Exported so anything else that reports a commit for display (e.g.
 * `fabrica update`'s before/after summary line) formats it the same
 * way doctor's own "checkout" line does, rather than a second copy of
 * this one-liner. */
export function short(sha: string | null): string {
  return sha ? sha.slice(0, 12) : "unknown";
}

/** Pure wording/pass-fail, so every case is testable without touching
 * real git or the network - `remoteMasterCommit` is `null` when that
 * lookup itself failed (no network, no git), which is reported but
 * never fails the check: an older commit still runs correctly, it is
 * only ever information here, not a fix-required state.
 *
 * Nothing this check can find makes a task impossible - which copy of
 * fabrica is on this disk, and whether it is the newest one, changes
 * nothing about whether Docker, the worker image, the tokens and the
 * project are there - so every failure here is `blocking: false` and
 * being behind origin rides along as a `note` (Client ruling
 * 2026-10-23). `fabrica doctor` still fails on them exactly as before;
 * `fabrica up` prints them above the session and starts it.
 */
export function checkoutCheck(copy: CopyInfo, remoteMasterCommit: string | null): DoctorCheck {
  const label = "checkout";
  const behind = remoteMasterCommit !== null && copy.commit !== remoteMasterCommit;
  const behindNote =
    remoteMasterCommit === null
      ? "can't check against origin/master (no network, or git unavailable)"
      : behind
        ? `behind origin/master, latest is ${short(remoteMasterCommit)}`
        : "up to date with origin/master";
  const note = behind ? `${behindNote} - bring it up to date with: fabrica update` : undefined;

  if (copy.kind === "installed") {
    if (copy.commit === null) {
      return {
        ok: false,
        blocking: false,
        label,
        // Why there is no commit comes from whatever could not produce
        // one, rather than being guessed at here: the named failure
        // `build-info.json` itself records, or the absence of that file.
        detail: `installed copy v${copy.version} at ${copy.root}: commit unknown - ${copy.commitUnknownReason ?? "nothing in it records one"}`,
        // The clone-pack-install procedure, never a one-step install of
        // the GitHub spec: npm fetches that spec as GitHub's tarball of
        // the tree, with no `.git` for the `prepare` step to read the
        // commit from, so advising it here would advise the very install
        // that produced this line. Into the prefix this copy actually
        // lives under whenever its own path says which (issue #171's
        // other half): npm's default global prefix is read-only on some
        // hosts, so an unprefixed install is only the right advice when
        // nothing names a prefix.
        fix: `fabrica update, or by hand: ${clonePackInstallProcedure(prefixOfGlobalInstall(copy.root))}`,
      };
    }
    return { ok: true, label, note, detail: `installed copy v${copy.version}, commit ${short(copy.commit)} (${behindNote})` };
  }

  const detail = `fabrica runs from ${copy.root} on ${copy.branch || "a detached HEAD"}, commit ${short(copy.commit)} (${behindNote})`;
  return copy.branch === "master"
    ? { ok: true, label, note, detail }
    : {
        ok: false,
        blocking: false,
        label,
        detail: `${detail}, not master`,
        fix: `git -C ${copy.root} checkout master && git -C ${copy.root} pull`,
      };
}

/** What `<prefix>/lib/node_modules/fabrica` turns out to be at one
 * prefix worth looking in (issue #171). */
export interface NpmLinkSite {
  prefix: string;
  /** Where the symlink there points, or `null` when there is no symlink
   * at that path at all - an ordinary installed directory, or nothing.
   * Resolved to a real path whenever the target exists, so comparing it
   * against the running copy's own (already real, since node resolves a
   * module's path through symlinks) root compares like with like. */
  linkTarget: string | null;
  /** A symlink whose target is gone - leftover whatever else is true. */
  dangling: boolean;
  /** npm's own global prefix: the one a bare `npm install -g` writes to
   * and a bare `npm unlink -g` removes from. */
  npmDefault: boolean;
}

/** The prefixes worth looking in, in the order they are searched: the
 * one the running `fabrica` executable came from, the one the running
 * copy is installed under, and npm's own global prefix (where a bare
 * `npm install -g` would hit the ENOTDIR). Deduplicated, and a prefix
 * nothing can derive is simply not searched. */
export function npmLinkPrefixes(
  copy: CopyInfo,
  execPath: string | undefined,
  npmPrefix: string | null
): { prefix: string; npmDefault: boolean }[] {
  const candidates: [string | null, boolean][] = [
    [prefixOfGlobalBin(execPath), false],
    [prefixOfGlobalInstall(copy.root), false],
    [normalizedPrefix(npmPrefix), true],
  ];
  const sites: { prefix: string; npmDefault: boolean }[] = [];
  for (const [prefix, npmDefault] of candidates) {
    if (prefix === null) continue;
    const already = sites.find((site) => site.prefix === prefix);
    if (already) already.npmDefault = already.npmDefault || npmDefault;
    else sites.push({ prefix, npmDefault });
  }
  return sites;
}

/** Pure wording/pass-fail, so every case is testable without a real
 * symlink anywhere. A link pointing at the dev checkout that is running
 * right now is the documented developer install (README.md's
 * "Developing Fabrica itself"), not a leftover, and is reported `OK`:
 * it is not a problem at all, which is a separate thing from the
 * `blocking: false` below. Anything else - a link to some other
 * checkout, or one whose target is gone - stands between npm and the
 * installed copy, and gets the one command that removes it.
 *
 * A leftover link is `blocking: false` for the same reason the checkout
 * check's own failures are (Client ruling 2026-10-23): it stands in a
 * prefix the running copy did not come from (that is what makes it
 * leftover rather than the developer install), so it breaks the next
 * `npm install -g` and nothing else - no task needs it answered. */
export function npmLinkCheck(sites: NpmLinkSite[], copy: CopyInfo): DoctorCheck {
  const label = "npm link";
  const linked = sites.filter((site) => site.linkTarget !== null);

  if (linked.length === 0) {
    return {
      ok: true,
      label,
      detail:
        sites.length === 0
          ? "no npm prefix to check (fabrica is running from neither a global install nor npm's own prefix)"
          : `no leftover symlink at ${sites.map((site) => globalPackagePath(site.prefix)).join(", ")}`,
    };
  }

  const leftover = linked.find(
    (site) => site.dangling || copy.kind !== "dev-checkout" || site.linkTarget !== copy.root
  );
  if (leftover === undefined) {
    return {
      ok: true,
      label,
      detail: `${globalPackagePath(linked[0].prefix)} is linked to the checkout running right now (${copy.root}) - the developer install, not a leftover`,
    };
  }

  const path = globalPackagePath(leftover.prefix);
  const what = leftover.dangling
    ? `an npm link symlink to ${leftover.linkTarget}, which no longer exists`
    : `an npm link symlink to the checkout ${leftover.linkTarget}, not an installed copy`;
  return {
    ok: false,
    blocking: false,
    label,
    detail: `${path} is ${what} - any npm install -g of ${GLOBAL_PACKAGE_NAME} fails with ENOTDIR while it is there`,
    fix: leftover.npmDefault ? "npm unlink -g fabrica" : `npm unlink -g --prefix ${leftover.prefix} fabrica`,
  };
}

/** Reads one prefix off the real filesystem. `npm link` writes a
 * *relative* symlink (`../../../<checkout>`, verified against a real
 * one), so a target is resolved against the link's own folder before
 * anything is said about it. */
export function inspectNpmLinkSite(site: { prefix: string; npmDefault: boolean }): NpmLinkSite {
  const path = globalPackagePath(site.prefix);
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    return { ...site, linkTarget: null, dangling: false };
  }
  if (!isLink) return { ...site, linkTarget: null, dangling: false };

  const raw = readlinkSync(path);
  const target = isAbsolute(raw) ? raw : resolve(dirname(path), raw);
  if (!existsSync(target)) return { ...site, linkTarget: target, dangling: true };
  try {
    return { ...site, linkTarget: realpathSync(target), dangling: false };
  } catch {
    return { ...site, linkTarget: target, dangling: true };
  }
}

/** The exact Node version .inspector.json's image tag names, or `null`
 * if that file is unreadable or its tag carries no version. Exported
 * for the same reason `short` and `git` are: node-version-pins.test.ts
 * proves this repo's four Node declarations agree, and it has to read
 * .inspector.json's tag through the one reader doctor itself refuses
 * on, not a second regex that could be right while doctor is wrong. */
export function pinnedNodeVersion(): string | null {
  try {
    const image = (JSON.parse(readFileSync(join(CHECKOUT, ".inspector.json"), "utf8")) as { image?: string }).image ?? "";
    return /node:(\d+\.\d+\.\d+)/.exec(image)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Exported for the same reason `short` is: `fabrica update` needs the
 * identical "quiet git, null on failure" probe to drive detectCopy's
 * own gitIn callback over this checkout, rather than a second copy. */
export function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function readPackageVersion(root: string): string {
  try {
    return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** What an installed copy's `build-info.json` says about its commit: the
 * commit itself, or - when the `prepare` step that wrote the file had no
 * source for one, or there is no file at all - the reason to report
 * instead. Never both, and never a bare `null` standing in for either,
 * since "which commit is this" and "why doesn't it know" are different
 * questions and the Client is owed the second one's answer too. */
function readBuildInfo(root: string): { commit: string | null; reason?: string } {
  let raw: string;
  try {
    raw = readFileSync(join(root, "build-info.json"), "utf8");
  } catch {
    return { commit: null, reason: "there is no build-info.json in it to record one" };
  }
  let parsed: { commit?: string | null; error?: string | null };
  try {
    parsed = JSON.parse(raw) as { commit?: string | null; error?: string | null };
  } catch {
    return { commit: null, reason: `its build-info.json is not readable JSON` };
  }
  if (typeof parsed.commit === "string" && parsed.commit !== "") return { commit: parsed.commit };
  // An empty commit is what `scripts/write-build-info.mjs` writes when
  // neither of its sources could name one, alongside the named failure
  // reported here verbatim. A `null` or absent commit is the same state
  // written by a copy built before that script said why (its
  // `{"commit":null}`), so it gets the one honest reason available.
  return {
    commit: null,
    reason:
      typeof parsed.error === "string" && parsed.error !== ""
        ? parsed.error
        : "its build-info.json records no commit, and does not say why",
  };
}

/** `.git` (directory, or a worktree's gitdir-pointer file - either way
 * `existsSync` alone is enough to tell a real checkout from a packed
 * copy) decides which kind of copy this is - the ground truth npm's own
 * install behavior already establishes, not a flag anything has to keep
 * in sync by hand. */
export function detectCopy(root: string, gitIn: (args: string[]) => string | null): CopyInfo {
  const version = readPackageVersion(root);
  if (existsSync(join(root, ".git"))) {
    return {
      kind: "dev-checkout",
      root,
      branch: gitIn(["branch", "--show-current"]) ?? "",
      commit: gitIn(["rev-parse", "HEAD"]),
      version,
    };
  }
  const { commit, reason } = readBuildInfo(root);
  return {
    kind: "installed",
    root,
    branch: null,
    commit,
    version,
    ...(reason === undefined ? {} : { commitUnknownReason: reason }),
  };
}

/** The one value `fabrica doctor`'s own "checkout" line reports as this
 * copy's commit (dev checkout: live `git rev-parse HEAD`; installed:
 * `build-info.json`'s recorded commit, or null if that file is
 * missing) - exported so anything else that needs to know "what commit
 * is the copy of fabrica on disk" (`fabrica up`'s stale-live-view
 * check, and both of the live view's own commit endpoints) asks this
 * exact question rather than reimplementing detectCopy's
 * dev-checkout-vs-installed branch itself.
 *
 * Note for anything comparing two of these: this reads the copy ON DISK,
 * live, every call. It is NOT "what code is the calling process
 * running" - those coincide for a short-lived CLI command, and diverge
 * for a long-lived server, which is exactly why the live view captures
 * it once at startup for `/api/version` and calls it per request for
 * `/api/checkout` (integrations/live-view/server.ts). */
export function runningCopyCommit(root: string): string | null {
  return detectCopy(root, (args) => git(root, args)).commit;
}

/** One lightweight network call, no local repo required either side
 * (works identically for a dev checkout or an installed copy) and no
 * mutation of any local ref - a `git fetch` would learn the exact
 * ahead/behind count but updates `.git/refs/remotes/origin/master`,
 * which doctor (claims to, and should) never touch. */
function fetchRemoteMasterCommit(): string | null {
  try {
    const out = execFileSync("git", ["ls-remote", UPSTREAM_GIT_URL, UPSTREAM_BRANCH], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

/** npm's own global prefix - what a bare `npm install -g` would write
 * to. One short `npm` call, and `null` (nothing claimed) if npm isn't
 * on this PATH at all. */
function npmGlobalPrefix(): string | null {
  try {
    return (
      execFileSync("npm", ["prefix", "-g"], {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** The task states a worker box can legitimately be open for: one
 * running right now. Every other state - asking, delivered, failed,
 * closed, stopped, refused - means no round is in flight, so a network
 * still carrying that task's label is something a round left behind.
 * `stateOf` reports a task as `working` from the moment it is received
 * (the clarifying step included), so the in-flight window is covered
 * from its first event, not from `work-started`. */
const LIVE_TASK_STATES = new Set(["working", "checking"]);

/** Which task ids this record home currently has a round running for. */
export function liveTaskIds(recordHome: string): Set<string> {
  const live = new Set<string>();
  for (const [taskId, events] of eventsByTask(recordHome)) {
    if (LIVE_TASK_STATES.has(stateOf(events))) live.add(taskId);
  }
  return live;
}

/** Which of Docker's `fabrica-worker-*` networks nobody is using any
 * more (Client ruling: a running task's network is never a leftover,
 * judged both from the record and from Docker's own list of containers
 * on it). Either signal alone would be wrong: a network whose box has
 * not attached yet belongs to a live task, and a network whose task
 * ended in another record home - or before the labels existed - has no
 * record here to vouch for it. */
export function leftoverWorkerNetworks(networks: WorkerNetwork[], live: Set<string>): WorkerNetwork[] {
  return networks.filter(
    (network) => network.attachedContainers === 0 && !(network.taskId !== null && live.has(network.taskId))
  );
}

/** Pure wording/pass-fail, so every case is testable with no Docker
 * anywhere. A leftover is `blocking: false`: a task can still start
 * while a few sit there (the ruling's word is "warn"), right up until
 * they have eaten every address pool - at which point it is the
 * network-create failure itself that says so, naming the same command
 * (src/containment/network-pools.ts). */
export function workerNetworksCheck(networks: WorkerNetwork[] | null, leftovers: WorkerNetwork[]): DoctorCheck {
  const label = "worker networks";
  if (networks === null) return { ok: true, label, detail: "not checked - Docker could not be asked" };
  if (leftovers.length === 0) {
    return {
      ok: true,
      label,
      detail:
        networks.length === 0
          ? `no leftover ${WORKER_NETWORK_PREFIX}* networks`
          : `no leftover ${WORKER_NETWORK_PREFIX}* networks (${networks.length} in use by running tasks)`,
    };
  }
  const named = leftovers.slice(0, 3).map((network) => network.name);
  const rest = leftovers.length - named.length;
  return {
    ok: false,
    blocking: false,
    label,
    detail:
      `${leftovers.length} leftover ${WORKER_NETWORK_PREFIX}* network${leftovers.length === 1 ? "" : "s"} ` +
      `(${named.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}) - no task is using them, and each one holds a ` +
      `Docker address pool until it is removed`,
    fix: NETWORK_PRUNE_COMMAND,
  };
}

export const realProbes: DoctorProbes = {
  node: () => nodeCheck(process.version, pinnedNodeVersion()),
  checkout: () => checkoutCheck(detectCopy(CHECKOUT, (args) => git(CHECKOUT, args)), fetchRemoteMasterCommit()),
  npmLink() {
    const copy = detectCopy(CHECKOUT, (args) => git(CHECKOUT, args));
    const sites = npmLinkPrefixes(copy, process.argv[1], npmGlobalPrefix()).map(inspectNpmLinkSite);
    return npmLinkCheck(sites, copy);
  },
  docker: () =>
    dockerDaemonUp()
      ? { ok: true, label: "docker", detail: "reachable" }
      : { ok: false, label: "docker", detail: "not reachable", fix: "start Docker (e.g. open -a Docker), then try again" },
  workerImage: () => workerImageStatus(),
  workerCli: () => workerCliVersionStatus(),
  relayImage: () => relayImageStatus(),
  async workerNetworks(recordHome) {
    const networks = await listWorkerNetworks();
    return workerNetworksCheck(networks, networks === null ? [] : leftoverWorkerNetworks(networks, liveTaskIds(recordHome)));
  },
  workerToken: (recordHome) => workerTokenStatus(process.env, recordHome),
  githubToken: () => githubTokenStatus(process.env),
  inspector: () => inspectorBranchStatus(process.env),
  live: (recordHome) => probeWorkerToken(process.env, recordHome),
};

function projectCheck(name: string, path: string): DoctorCheck {
  const label = `project ${name}`;
  try {
    requireGitRoot(path);
  } catch (err) {
    // requireGitRoot's message is "<what is wrong>. <how to fix it>".
    const message = err instanceof Error ? err.message : String(err);
    const cut = message.indexOf(". ");
    return cut === -1
      ? { ok: false, label, detail: message }
      : { ok: false, label, detail: message.slice(0, cut), fix: message.slice(cut + 2) };
  }
  if (!existsSync(join(path, ".inspector.json")) && !existsSync(join(path, "check.sh"))) {
    return {
      ok: false,
      label,
      detail: `${path} has neither .inspector.json nor check.sh, so nothing can check a task's work`,
      fix: "commit a check.sh (and an .inspector.json, for Inspector) at the project's root",
    };
  }
  if (git(path, ["remote", "get-url", "origin"]) === null) {
    return {
      ok: false,
      label,
      detail: `${path} has no origin remote, so Inspector has nowhere to publish`,
      fix: `git -C ${path} remote add origin <url>`,
    };
  }
  return { ok: true, label, detail: `${path}: git root, has a check, has origin` };
}

function parseDoctorArgs(argv: string[]): { live: boolean } {
  let live = false;
  for (const arg of argv) {
    if (arg === "--live") live = true;
    else throw new CliError("bad-usage", `fabrica doctor: unknown argument "${arg}". Usage: ${DOCTOR_USAGE}`);
  }
  return { live };
}

export interface RunDoctorCommandOptions {
  recordHome?: string;
  probes?: DoctorProbes;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** The one line `fabrica doctor` prints per check - exported so anything
 * else that shows doctor's own output (`fabrica up`, when it stops on a
 * check) renders it identically rather than with a second copy of this
 * format. */
export function formatDoctorLine(check: DoctorCheck): string {
  return check.ok
    ? `OK   ${check.label}: ${check.detail}`
    : `FAIL ${check.label}: ${check.detail}${check.fix ? ` - fix: ${check.fix}` : ""}`;
}

/** Every check `fabrica doctor` runs, as objects rather than lines -
 * exported so `fabrica up` can decide per finding whether it stops a
 * task (`stopsATask`) instead of reading doctor's exit code, which
 * cannot tell one kind of FAIL from another. `runDoctorCommand` below
 * is this plus the printing and the exit code, so the two commands can
 * never disagree about which checks ran or in what order. */
export async function collectDoctorChecks(opts: { recordHome: string; probes?: DoctorProbes; live?: boolean }): Promise<DoctorCheck[]> {
  const { recordHome } = opts;
  const probes = opts.probes ?? realProbes;

  const checks: DoctorCheck[] = [
    probes.node(),
    probes.checkout(),
    probes.npmLink(),
    probes.docker(),
    probes.workerImage(),
    probes.workerCli(),
    probes.relayImage(),
    await probes.workerNetworks(recordHome),
    probes.workerToken(recordHome),
    probes.githubToken(),
    probes.inspector(),
  ];

  // A projects.toml that will not parse is one FAIL line naming the
  // file, the line the parser stopped on, and what it objected to - and
  // every machine check above still ran, and still printed (Client
  // ruling). The config-derived checks below are the only ones skipped,
  // because they genuinely cannot be answered: reporting "no projects
  // are registered" and "no spending cap is set" off an unreadable file
  // would be three FAILs for one problem, two of them wrong about why.
  const { config, problem } = loadConfigOrProblem(recordHome);
  if (problem) {
    checks.push({
      ok: false,
      label: "projects.toml",
      detail: problem.message,
      fix:
        problem.line === null
          ? `fix the TOML in ${problem.path}`
          : `fix the TOML in ${problem.path} at line ${problem.line}`,
    });
  } else {
    const names = Object.keys(config.projects);
    if (names.length === 0) {
      checks.push({ ok: false, label: "projects", detail: "no projects are registered", fix: `add a [projects.<name>] entry to ${recordHome}/projects.toml` });
    }
    for (const name of names) checks.push(projectCheck(name, config.projects[name].path));

    const { perTaskUsd, perDayUsd } = config.caps;
    checks.push(
      capsActive(config.caps)
        ? { ok: true, label: "caps", detail: `perTaskUsd = ${perTaskUsd ?? "unset"}, perDayUsd = ${perDayUsd ?? "unset"}` }
        : { ok: false, label: "caps", detail: "no spending cap is set", fix: `add a [caps] table (perTaskUsd, perDayUsd) to ${recordHome}/projects.toml` }
    );

    const unmeasured = unmeasuredSpend(readEvents(recordHome));
    if (unmeasured.length > 0 && capsActive(config.caps)) {
      checks.push({
        ok: false,
        label: "spend",
        detail: "SPEND UNKNOWN - tasks blocked",
        fix: describeUnmeasured(unmeasured).join("; "),
      });
    } else {
      checks.push({ ok: true, label: "spend", detail: unmeasured.length > 0 ? `${unmeasured.length} unmeasured, not blocking (no cap set)` : "no unmeasured spend" });
    }
  }

  if (opts.live) checks.push(await probes.live(recordHome));

  return checks;
}

/** Returns the process exit code - never throws. */
export async function runDoctorCommand(argv: string[], opts: RunDoctorCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));
  let live: boolean;
  try {
    ({ live } = parseDoctorArgs(argv));
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const recordHome = opts.recordHome ?? resolveRecordHome();

  // Every FAIL is a FAIL here, whatever `fabrica up` makes of it: doctor
  // is the Client asking what is wrong with this machine, and answering
  // "nothing" because nothing happens to be blocked right now would be
  // a different, less useful command.
  const checks = await collectDoctorChecks({ recordHome, probes: opts.probes, live });
  for (const check of checks) stdout(formatDoctorLine(check));
  return checks.every((c) => c.ok) ? 0 : 1;
}
