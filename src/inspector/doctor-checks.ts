// `fabrica doctor`'s Inspector-side checks (Client ruling 2026-10-10): a
// GitHub token Inspector can publish with, and an installed Inspector
// that takes the -branch flag Fabrica calls it with and is built from
// origin main's tip. Never prints a token.

import { execFileSync, spawnSync } from "node:child_process";
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
 * next. */
export function inspectorInstallCommand(mainCommit: string): string {
  return `go install ${INSPECTOR_PACKAGE_PATH}@${mainCommit}`;
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

/** Pure wording/pass-fail for the version half of the inspector line, so
 * every case is testable without a binary, a Go toolchain or the
 * network. Only one case fails: a binary installed from a released
 * module version that is not origin main's tip, which is behind - the
 * fix is printed and `fabrica up` stops on it, which is the point.
 *
 * Everything else is information: a dev build (built from a checkout, so
 * possibly ahead of main, and nothing here can order two commits without
 * a clone) names its commit and passes, as does a binary whose commit or
 * whose origin main could not be read at all. */
export function inspectorVersionCheck(
  build: InspectorBuild,
  mainCommit: string | null
): { ok: boolean; note: string; fix?: string } {
  if (build.unreadable !== null) {
    return { ok: true, note: `its commit could not be checked against origin main (${build.unreadable})` };
  }
  if (build.commit === null) {
    return { ok: true, note: `it records no commit to check against origin main (module version ${build.version ?? "unknown"})` };
  }
  if (mainCommit === null) {
    return { ok: true, note: `commit ${short(build.commit)}, could not check origin main (no network, or git unavailable)` };
  }

  const current = sameCommit(build.commit, mainCommit);
  if (build.fromCheckout) {
    const where = current ? "origin main's tip" : `origin main is at ${short(mainCommit)}`;
    return { ok: true, note: `a local build at commit ${short(build.commit)}${build.dirty ? " with uncommitted changes" : ""} (${where})` };
  }
  if (current) return { ok: true, note: `commit ${short(build.commit)}, up to date with origin main` };
  return {
    ok: false,
    note: `its commit ${short(build.commit)} is behind origin main, which is at ${short(mainCommit)}`,
    fix: inspectorInstallCommand(mainCommit),
  };
}

export function inspectorBranchStatus(env: NodeJS.ProcessEnv = process.env, command = "inspector"): InspectorCheck {
  const label = "inspector";
  const binaryPath = resolveCommandPath(command, env);
  if (binaryPath === null) {
    return {
      ok: false,
      label,
      detail: `${command} is not on PATH - tasks on projects with .inspector.json will be self-tested instead`,
      fix: "install Inspector (https://github.com/inactdev/inspector) so `inspector` is on PATH",
    };
  }
  const help = spawnSync(command, ["-h"], { env, encoding: "utf8", timeout: 10_000 });
  if (!`${help.stdout}${help.stderr}`.includes("-branch")) {
    return {
      ok: false,
      label,
      detail: `\`${command} -h\` shows no -branch flag, so every handoff Fabrica makes would be refused`,
      fix: "update Inspector to a version that takes -branch",
    };
  }

  // The remote is only worth asking about once the binary has told us
  // what to compare: a commit nothing could read is reported as that,
  // not as a remote problem, and spends no network call finding out.
  const build = readInspectorBuild(binaryPath, env);
  const version = inspectorVersionCheck(build, build.commit === null ? null : fetchInspectorMainCommit(env));
  const base = `${command} is on PATH and takes -branch`;
  return version.ok
    ? { ok: true, label, detail: `${base}, ${version.note}` }
    : { ok: false, label, detail: `${base}, but ${version.note}`, fix: version.fix };
}
