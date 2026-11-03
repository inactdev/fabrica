// `fabrica update`'s Inspector step: the three facts about the installed
// Inspector as probes, and the one action only `fabrica update` takes
// (task: "make fabrica update keep Inspector current too").
//
// Everything about *reading* those facts already belongs to
// `doctor-checks.ts` - the build record inside the binary, origin main's
// tip, and the one spelling of the install command - and is reused from
// there rather than copied, so the line that reports a stale Inspector
// and the command that replaces it can never disagree about what they
// are looking at. This module adds only the seam: one injectable
// interface, so `fabrica update`'s own tests run no real `go`, no real
// `git`, and no real install.
//
// What this module does own, because nothing else needs to know it, is
// *where* that install lands: Go's own GOBIN has nothing to do with
// which `inspector` PATH resolves, so the install is aimed at the
// directory holding the binary this machine really runs (issue #339).

import { execFileSync, spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { commitAncestry, type CommitAncestry } from "./ancestry.ts";
import {
  fetchInspectorMainCommit,
  inspectorInstallArgs,
  readInspectorBuild,
  INSPECTOR_MAIN_REF,
  INSPECTOR_REPO_URL,
  type InspectorBuild,
} from "./doctor-checks.ts";
import { resolveCommandPath } from "./run.ts";

/** The three questions `fabrica update` has to ask before it may replace
 * anything, injectable so no test needs a real Inspector, a real `go`,
 * or the network - the same seam shape as doctor-command.ts's
 * DoctorProbes. */
export interface InspectorVersionProbes {
  /** What the installed binary records about its own build, or `null`
   * when there is no `inspector` on PATH at all. */
  build(): InspectorBuild | null;
  /** Origin main's tip commit, or `null` if that lookup itself failed. */
  mainCommit(): string | null;
  /** Whether `commit` is in origin main's history. Only ever called with
   * a commit already known to differ from the tip. */
  ancestry(commit: string): CommitAncestry;
  /** The directory holding the `inspector` PATH resolves today, or
   * `null` when none is on PATH - the one directory that decides which
   * binary every task actually runs, and so the one an install has to
   * land in (issue #339). Read again after an install, which is how
   * `fabrica update` can tell an install that took from one that landed
   * somewhere nothing reads. */
  directoryOnPath(): string | null;
}

/** The real probes, against the real `inspector` on PATH and Inspector's
 * real repository. */
export function realInspectorVersionProbes(
  command: string = "inspector",
  env: NodeJS.ProcessEnv = process.env
): InspectorVersionProbes {
  return {
    build: () => {
      const binaryPath = resolveCommandPath(command, env);
      return binaryPath === null ? null : readInspectorBuild(binaryPath, env);
    },
    mainCommit: () => fetchInspectorMainCommit(env),
    ancestry: (commit) => commitAncestry(commit, { repoUrl: INSPECTOR_REPO_URL, ref: INSPECTOR_MAIN_REF, env }),
    directoryOnPath: () => inspectorDirectoryOnPath(command, env),
  };
}

/** The directory holding the `inspector` PATH resolves today, or `null`
 * when none is on PATH. Resolved exactly the way `fabrica doctor`'s own
 * inspector line resolves the binary it reports on
 * (`resolveCommandPath`), so the directory an install is aimed at and
 * the binary the next health check reads can never be two different
 * things.
 *
 * Deliberately no `realpath`: if this directory holds a symlink into
 * Go's own GOBIN, installing *here* replaces that symlink with a real
 * binary, which is the state issue #339 asks for. Following the link
 * would put the install back in the directory the host deliberately
 * symlinked around. */
export function inspectorDirectoryOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  const binaryPath = resolveCommandPath(command, env);
  return binaryPath === null ? null : dirname(binaryPath);
}

/** Where a `go install` of Inspector is being pointed, and how that was
 * decided - the two facts a summary line has to be able to name when an
 * install lands somewhere nothing on PATH reads (issue #339). */
export type InspectorInstallTarget =
  /** The directory holding the `inspector` PATH resolves today: the one
   * binary every task actually runs, so the only directory worth
   * replacing. */
  | { kind: "path"; dir: string }
  /** No `inspector` on PATH at all, so Go's own GOBIN is all there is
   * to aim at - named, together with whether it is on PATH, since a
   * directory nothing reads is an install nobody gets. */
  | { kind: "go-default"; dir: string; onPath: boolean }
  /** No `inspector` on PATH and Go itself could not say where it would
   * put one. The install still runs (Go knows its own default even when
   * this cannot read it), it just cannot be named. */
  | { kind: "unknown" };

/** Go's own install directory, asked of Go rather than guessed:
 * `GOBIN` when set, otherwise `$GOPATH/bin` (`go help install`). `go
 * env` prints each named variable on its own line, and prints GOBIN
 * *empty* when it is unset - its `$GOPATH/bin` default is resolved
 * internally and never reported as GOBIN's own value, which is why both
 * are asked for in one call and the first empty line falls through to
 * the second.
 *
 * Asked of `go env` rather than read out of `env` directly because
 * either variable may be set in Go's own config file (`go env -w`)
 * rather than in the process environment, where nothing here would see
 * it. GOPATH may itself be a list, in which case Go installs into the
 * first entry's `bin`, so only the first is taken. */
export function goInstallDirectory(env: NodeJS.ProcessEnv): string | null {
  const probe = spawnSync("go", ["env", "GOBIN", "GOPATH"], { env, encoding: "utf8", timeout: 20_000 });
  if (probe.error || probe.status !== 0) return null;
  const [gobin = "", gopath = ""] = (probe.stdout ?? "").split("\n").map((line) => line.trim());
  if (gobin !== "") return gobin;
  const first = gopath.split(delimiter).filter(Boolean)[0];
  return first === undefined ? null : join(first, "bin");
}

/** Whether `dir` is one of PATH's own entries. Compared normalized
 * (`resolve`), so a trailing slash or a `.` segment doesn't make the
 * same directory look like a different one, but never through the
 * filesystem - this answers "would the shell find a binary here",
 * which is a question about PATH's text, not about symlinks. */
export function directoryIsOnPath(dir: string, env: NodeJS.ProcessEnv): boolean {
  const target = resolve(dir);
  return (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((entry) => resolve(entry) === target);
}

/** Where an install of Inspector should go on this machine: the
 * directory holding the `inspector` PATH resolves today, and only
 * failing that, Go's own GOBIN (issue #339 - on a host whose PATH
 * prefers some other directory, Go's default is a directory nothing
 * ever runs from). */
export function inspectorInstallTarget(
  env: NodeJS.ProcessEnv,
  command = "inspector"
): InspectorInstallTarget {
  const onPath = inspectorDirectoryOnPath(command, env);
  if (onPath !== null) return { kind: "path", dir: onPath };
  const goDefault = goInstallDirectory(env);
  return goDefault === null ? { kind: "unknown" } : { kind: "go-default", dir: goDefault, onPath: directoryIsOnPath(goDefault, env) };
}

/** What an attempted install did, and where it was aimed. */
export interface InspectorInstallResult {
  ok: boolean;
  message: string;
  /** Where this install was pointed - carried out so the caller can
   * name the directory, and say whether it is one PATH reads, without
   * resolving any of it a second time. */
  target?: InspectorInstallTarget;
}

/** Runs the documented install, spelled exactly as every message prints
 * it (`inspectorInstallCommand`), with `GOBIN` pointed at the directory
 * holding the `inspector` PATH resolves today (issue #339): Go's own
 * default GOBIN is not where the shell - or any Fabrica task - looks for
 * Inspector on a host that puts some other directory on PATH, so an
 * unpinned install there is a silent no-op. GOBIN is Go's own
 * documented first choice of install directory, honoured by the
 * `pkg@version` form like every other, so this pins the destination
 * rather than working around it.
 *
 * Reported, never thrown: a failed install leaves whatever was there
 * before it in place, and `fabrica update` warns rather than failing on
 * it (Client ruling). A GOBIN that cannot be written is one of those
 * failures, reported with Go's own words - loudly wrong beats quietly
 * installed where nothing reads it. */
export function goInstallInspector(revision: string, env: NodeJS.ProcessEnv = process.env): InspectorInstallResult {
  const target = inspectorInstallTarget(env);
  // "unknown" means nothing here could name Go's own GOBIN - Go still
  // knows it, so the install runs with the environment untouched rather
  // than being refused over a directory this could not read.
  const installEnv = target.kind === "unknown" ? env : { ...env, GOBIN: target.dir };
  try {
    const out = execFileSync("go", inspectorInstallArgs(revision), {
      env: installEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, message: out.trim(), target };
  } catch (err) {
    const failure = err as { stderr?: Buffer | string; message?: string };
    const said = failure?.stderr ? failure.stderr.toString().trim() : (failure?.message ?? String(err));
    return { ok: false, message: said, target };
  }
}
