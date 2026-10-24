// `fabrica doctor`'s Inspector-side checks (Client ruling 2026-10-10): a
// GitHub token Inspector can publish with, and an installed Inspector
// that takes the -branch flag Fabrica calls it with and is not behind
// origin main's tip. Never prints a token.

import { execFileSync, spawnSync } from "node:child_process";
import { commitAncestry, type CommitAncestry } from "./ancestry.ts";
import { resolveCommandPath, resolveGithubToken } from "./run.ts";

export interface InspectorCheck {
  ok: boolean;
  label: string;
  detail: string;
  fix?: string;
}

/** Inspector's own module, package and repository - the three spellings
 * of "where Inspector comes from" this check needs: the module path a
 * binary carries inside it, the package path `go install` takes, and the
 * repository `git ls-remote` is asked about. */
export const INSPECTOR_MODULE_PATH = "github.com/inactdev/inspector";
export const INSPECTOR_PACKAGE_PATH = `${INSPECTOR_MODULE_PATH}/cmd/inspector`;
export const INSPECTOR_REPO_URL = `https://${INSPECTOR_MODULE_PATH}.git`;
/** Inspector's default branch is `main` (Fabrica's own is `master` - the
 * two are genuinely different, so neither side's probe is shared). */
export const INSPECTOR_MAIN_REF = "refs/heads/main";

export function githubTokenStatus(env: NodeJS.ProcessEnv = process.env): InspectorCheck {
  const label = "GitHub token";
  try {
    const { source } = resolveGithubToken(env);
    return { ok: true, label, detail: source === "GITHUB_TOKEN" ? "GITHUB_TOKEN is set" : "from gh auth token" };
  } catch {
    return {
      ok: false,
      label,
      detail: "GITHUB_TOKEN is not set and `gh auth token` gave nothing",
      fix: "run `gh auth login`",
    };
  }
}

/** What the installed Inspector binary itself records about the build it
 * came from - read back out of the executable, so it describes the
 * binary that will actually run, not whatever a checkout on this machine
 * happens to be at. */
export interface InspectorBuild {
  /** The main module's version: a pseudo-version
   * (`v0.0.0-20261020120900-4f297d8be50e`), a tag, `(devel)`, any of
   * them possibly with a `+dirty` suffix - or `null` when nothing was
   * read. */
  version: string | null;
  /** The commit it was built from, as far as the binary records one:
   * `vcs.revision` (a full sha, stamped only for a build from a
   * checkout) when there is one, otherwise the 12-hex commit a
   * pseudo-version carries. `null` when it records neither - a tagged
   * release, or a build with `-buildvcs=false`. */
  commit: string | null;
  /** Go stamped `vcs`/`vcs.revision`, which it does for `go build` in a
   * repository and never for `go install <package>@<version>` - so this
   * is "built from a checkout on some machine", i.e. a dev build. */
  fromCheckout: boolean;
  /** `vcs.modified=true`: built from a checkout with uncommitted
   * changes. */
  dirty: boolean;
  /** Why the build could not be read at all, when it could not. Always
   * information, never a failure: an Inspector that answers `-branch`
   * works whether or not this machine can say which commit built it. */
  unreadable: string | null;
}

const UNREADABLE: Omit<InspectorBuild, "unreadable"> = {
  version: null,
  commit: null,
  fromCheckout: false,
  dirty: false,
};

/** Go's own pseudo-version pattern (`golang.org/x/mod/module`'s
 * `pseudoVersionRE`, copied from the toolchain's own source rather than
 * approximated - the separator before the timestamp is `-` in one of its
 * three forms and `.` in the other two, which an eyeballed regex gets
 * wrong), with the revision captured: the commit, abbreviated to 12
 * characters, that `go install <package>@<anything>` resolved to. */
const PSEUDO_VERSION =
  /^v[0-9]+\.(?:0\.0-|\d+\.\d+-(?:[^+]*\.)?0\.)\d{14}-([A-Za-z0-9]+)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** The commit a Go pseudo-version carries. A tag (`v1.2.3`) or `(devel)`
 * carries none at all, and yields `null` rather than a guess. */
export function pseudoVersionCommit(version: string | null): string | null {
  return version === null ? null : (PSEUDO_VERSION.exec(version)?.[1] ?? null);
}

/** Parses `go version -m <binary>` output: a header line, then
 * tab-indented `path`/`mod`/`dep`/`build` records, each field
 * tab-separated (`runtime/debug.BuildInfo`'s own format, checked against
 * a real `go install`ed binary and a real local `go build`, not assumed).
 * Only the first `mod` record is the main module; `dep` records are the
 * dependencies and are ignored. */
export function parseGoBuildInfo(output: string, modulePath: string): InspectorBuild {
  let module: string | null = null;
  let version: string | null = null;
  let revision: string | null = null;
  let vcs = false;
  let dirty = false;

  for (const line of output.split("\n")) {
    if (!line.startsWith("\t")) continue;
    const fields = line.slice(1).split("\t");
    if (fields[0] === "mod" && module === null) {
      module = fields[1] ?? null;
      version = fields[2] ?? null;
    } else if (fields[0] === "build") {
      const setting = fields[1] ?? "";
      const eq = setting.indexOf("=");
      const key = eq === -1 ? setting : setting.slice(0, eq);
      const value = eq === -1 ? "" : setting.slice(eq + 1);
      if (key === "vcs") vcs = true;
      else if (key === "vcs.revision") revision = value || null;
      else if (key === "vcs.modified") dirty = value === "true";
    }
  }

  if (module === null) {
    return { ...UNREADABLE, unreadable: "the binary records no module information" };
  }
  if (module !== modulePath) {
    return { ...UNREADABLE, unreadable: `the binary was built from the module ${module}, not ${modulePath}` };
  }
  return { version, commit: revision ?? pseudoVersionCommit(version), fromCheckout: vcs || revision !== null, dirty, unreadable: null };
}

/** Reads the installed binary's own build record. Needs the Go toolchain
 * (`go version -m` is the only reader of that record), and a machine
 * without one is reported, never failed - the binary still runs. */
export function readInspectorBuild(binaryPath: string, env: NodeJS.ProcessEnv = process.env): InspectorBuild {
  const probe = spawnSync("go", ["version", "-m", binaryPath], { env, encoding: "utf8", timeout: 20_000 });
  if (probe.error) {
    const why =
      (probe.error as NodeJS.ErrnoException).code === "ENOENT"
        ? "`go` is not on PATH, and `go version -m` is the only way to read it"
        : `\`go version -m\` could not run (${probe.error.message})`;
    return { ...UNREADABLE, unreadable: why };
  }
  if (probe.status !== 0) {
    return { ...UNREADABLE, unreadable: `\`go version -m\` exited ${probe.status ?? "after a signal"}` };
  }
  return parseGoBuildInfo(probe.stdout ?? "", INSPECTOR_MODULE_PATH);
}

/** Inspector's main tip, from one side-effect-free `git ls-remote` - no
 * local clone either side, and no local ref mutated (the same shape, and
 * the same reasoning, as doctor's own "checkout" line uses against
 * Fabrica's upstream). `null` when that lookup itself could not be
 * made, which this check reports and never fails on. */
export function fetchInspectorMainCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const out = execFileSync("git", ["ls-remote", INSPECTOR_REPO_URL, INSPECTOR_MAIN_REF], {
      env,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

/** The exact command that replaces a stale binary with origin main's
 * tip. Pinned to the sha rather than `@latest`, so what gets installed
 * is the commit this check just compared against, whatever main does
 * next. `latest` is the one honest argument when nothing could be read
 * about main at all - which is all a missing Inspector can be advised
 * with. */
export function inspectorInstallCommand(mainCommit: string): string {
  return `go install ${INSPECTOR_PACKAGE_PATH}@${mainCommit}`;
}

/** The args behind that one spelling, for the caller that *runs* it
 * (`goInstallInspector`) rather than printing it - so a message can
 * never name a command different from the one that really runs, the same
 * rule npm-prefix.ts's `clonePackInstallProcedure` follows for Fabrica's
 * own install. */
export function inspectorInstallArgs(revision: string): string[] {
  return ["install", `${INSPECTOR_PACKAGE_PATH}@${revision}`];
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

/** Two shas naming the same commit, one of which may be a 12-hex
 * abbreviation from a pseudo-version rather than a full one. */
function sameCommit(a: string, b: string): boolean {
  const shared = Math.min(a.length, b.length);
  return shared >= 12 && a.slice(0, shared) === b.slice(0, shared);
}

/** Which of the eight things the installed binary can be. The one answer
 * `fabrica doctor` and `fabrica update` both act on: doctor FAILs on
 * exactly `"behind"`, and update installs on exactly `"behind"` (plus a
 * missing Inspector, which has no build to classify at all), so the
 * command that replaces a binary and the line that calls it stale can
 * never disagree. */
export type InspectorVersionState =
  /** Nothing on this machine could read the build record. */
  | "unreadable"
  /** Read, but recording no commit: a tagged release, `-buildvcs=false`. */
  | "no-commit"
  /** A commit, and no answer from the remote about main. */
  | "no-main"
  /** Built from a checkout on some machine - possibly ahead of main,
   * possibly with uncommitted changes. Deliberately put there. */
  | "local-build"
  /** The same commit origin main's tip is at. */
  | "current"
  /** Different from the tip, and not an ancestor of it: ahead of main,
   * or on a branch. */
  | "not-behind"
  /** Different from the tip, and which way round could not be found
   * out. Never stale, never current - unknown. */
  | "unknown-ancestry"
  /** A strict ancestor of origin main's tip: genuinely stale. */
  | "behind";

/** Pure wording/pass-fail for the version half of the inspector line, so
 * every case is testable without a binary, a Go toolchain or the
 * network. Only one state fails: a binary installed from a module
 * version that is a strict ancestor of origin main's tip, which is
 * behind - the fix is printed and `fabrica up` stops on it, which is the
 * point.
 *
 * Everything else is information. Three states are *different* from main
 * without being stale, and all three pass, named for what they are: a
 * commit ahead of main, one on a branch, and a build from a checkout
 * (which Go stamps `vcs.revision` for and never does for a module
 * install - someone put that binary there on purpose). So does a
 * comparison that could not be made at all: a commit nothing could read,
 * a build recording none, an unreachable origin main, or an ancestry
 * lookup that failed. An Inspector that works is not broken by this
 * machine being unable to ask about it.
 *
 * `resolveAncestry` is a parameter rather than a default, and is reached
 * only when the installed commit really does differ from the tip: it is
 * the one probe here that fetches anything, and a default that quietly
 * reached the network would be a trap for the next test that called
 * this. */
export function inspectorVersionCheck(
  build: InspectorBuild,
  mainCommit: string | null,
  resolveAncestry: (commit: string) => CommitAncestry
): { ok: boolean; state: InspectorVersionState; note: string; fix?: string } {
  if (build.unreadable !== null) {
    return {
      ok: true,
      state: "unreadable",
      note: `its commit could not be checked against origin main (${build.unreadable})`,
    };
  }
  if (build.commit === null) {
    return {
      ok: true,
      state: "no-commit",
      note: `it records no commit to check against origin main (module version ${build.version ?? "unknown"})`,
    };
  }
  if (mainCommit === null) {
    return {
      ok: true,
      state: "no-main",
      note: `commit ${short(build.commit)}, could not check origin main (no network, or git unavailable)`,
    };
  }

  const current = sameCommit(build.commit, mainCommit);
  if (build.fromCheckout) {
    const where = current ? "origin main's tip" : `origin main is at ${short(mainCommit)}`;
    return {
      ok: true,
      state: "local-build",
      note: `a local build at commit ${short(build.commit)}${build.dirty ? " with uncommitted changes" : ""} (${where})`,
    };
  }
  if (current) return { ok: true, state: "current", note: `commit ${short(build.commit)}, up to date with origin main` };

  // Two hashes only ever say "same" or "not the same". Which way round
  // they are is a real ancestry question, and only a commit that is
  // genuinely IN main's history is stale (Client ruling): one ahead of
  // main, or on a branch, differs from the tip without being behind it,
  // and must never be reported as stale nor installed over.
  const ancestry = resolveAncestry(build.commit);
  if (ancestry === "unknown") {
    return {
      ok: true,
      state: "unknown-ancestry",
      note:
        `commit ${short(build.commit)}, and whether it is behind origin main (at ${short(mainCommit)}) ` +
        `could not be checked (no network, or git unavailable)`,
    };
  }
  if (ancestry === "not-behind") {
    return {
      ok: true,
      state: "not-behind",
      note:
        `commit ${short(build.commit)} is not behind origin main, which is at ${short(mainCommit)} - ` +
        `it is ahead of main, or built from a branch`,
    };
  }
  return {
    ok: false,
    state: "behind",
    note: `its commit ${short(build.commit)} is behind origin main, which is at ${short(mainCommit)}`,
    fix: inspectorInstallCommand(mainCommit),
  };
}

/** The install to print as the fix for an Inspector that isn't usable at
 * all - missing, or too old for `-branch`. Pinned to main's tip when the
 * remote answers, `@latest` when it doesn't, which is all anyone can
 * honestly advise with nothing read about main. */
function installFixAtMain(env: NodeJS.ProcessEnv): string {
  return inspectorInstallCommand(fetchInspectorMainCommit(env) ?? "latest");
}

/** One line (`fabrica doctor` prints one line per check): on PATH, takes
 * -branch, and installed versus origin main. A missing or stale binary
 * is a real FAIL, so `fabrica up` stops on it (Client ruling) - and
 * every FAIL here prints the same `go install` command `fabrica update`
 * would have run. */
export function inspectorBranchStatus(
  env: NodeJS.ProcessEnv = process.env,
  command = "inspector",
  resolveAncestry: (commit: string) => CommitAncestry = (commit) =>
    commitAncestry(commit, { repoUrl: INSPECTOR_REPO_URL, ref: INSPECTOR_MAIN_REF, env })
): InspectorCheck {
  const label = "inspector";
  const binaryPath = resolveCommandPath(command, env);
  if (binaryPath === null) {
    return {
      ok: false,
      label,
      detail: `${command} is not on PATH - tasks on projects with .inspector.json will be self-tested instead`,
      fix: installFixAtMain(env),
    };
  }

  // Asked before anything is compared: an Inspector too old for -branch
  // has every handoff refused, which no freshness wording would say, and
  // its fix is the same install either way - so there is no point
  // pricing a remote lookup first.
  const help = spawnSync(command, ["-h"], { env, encoding: "utf8", timeout: 10_000 });
  if (!`${help.stdout}${help.stderr}`.includes("-branch")) {
    return {
      ok: false,
      label,
      detail: `\`${command} -h\` shows no -branch flag, so every handoff Fabrica makes would be refused`,
      fix: installFixAtMain(env),
    };
  }

  // The remote is only worth asking about once the binary has told us
  // what to compare: a commit nothing could read is reported as that,
  // not as a remote problem, and spends no network call finding out.
  const build = readInspectorBuild(binaryPath, env);
  const version = inspectorVersionCheck(build, build.commit === null ? null : fetchInspectorMainCommit(env), resolveAncestry);
  const base = `${command} is on PATH and takes -branch`;
  return version.ok
    ? { ok: true, label, detail: `${base}, ${version.note}` }
    : { ok: false, label, detail: `${base}, but ${version.note}`, fix: version.fix };
}
