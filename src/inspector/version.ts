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

import { execFileSync } from "node:child_process";
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
  };
}

/** Runs the documented install, spelled exactly as every message prints
 * it (`inspectorInstallCommand`). Reported, never thrown: a failed
 * install leaves whatever was there before it in place, and `fabrica
 * update` warns rather than failing on it (Client ruling). */
export function goInstallInspector(revision: string, env: NodeJS.ProcessEnv = process.env): { ok: boolean; message: string } {
  try {
    const out = execFileSync("go", inspectorInstallArgs(revision), {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, message: out.trim() };
  } catch (err) {
    const failure = err as { stderr?: Buffer | string; message?: string };
    const said = failure?.stderr ? failure.stderr.toString().trim() : (failure?.message ?? String(err));
    return { ok: false, message: said };
  }
}
