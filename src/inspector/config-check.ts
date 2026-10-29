// A project's `.inspector.json` checked against what the installed
// Inspector refuses, before a task starts (issue #306).
//
// On 2026-10-27 the installed Inspector began refusing every project
// whose `.inspector.json` still named an `image` (inspector#47). Fabrica
// learned this one task at a time, each after a full round: the machine
// worked, the round reached Inspector, Inspector refused, and the task
// sat as "refused" with the reason three screens down in `fabrica log`.
// Nothing on Fabrica's side had looked at the config at all.
//
// The lasting fix is Inspector's own: a command that validates the
// config and names the `Dockerfile.inspector` it would build, running
// nothing. It does not exist yet - see `config-check-issue.md` for the
// exact shape asked for, and delete this module's refusal list in favour
// of it the day it lands. Until then this is Fabrica's own copy of the
// refusals Inspector documents today, in Inspector's own words, read
// from Inspector's own source rather than from prose about it
// (`internal/inspector/config.go`, `image.go` and `run.go` at main
// `a5cf7050`, 2026-10-28):
//
//   - `"image"` and `"network"` are retired keys, refused on the key's
//     PRESENCE whatever its value - Inspector decodes both into a
//     `json.RawMessage` precisely so that `"network": false` is a
//     refusal rather than a setting that quietly does nothing.
//   - the check box is built from a `Dockerfile.inspector` committed at
//     the repository root, and a project that commits none is refused by
//     that file's name. One on disk that git does not track is refused
//     separately, for the same reason the working tree has to be clean.
//
// Fabrica never edits either file: every refusal here carries the
// Client's own hand change instead, naming exactly which key or file
// (the issue's own clarification).
//
// This module reads, and answers; it decides nothing about what to do
// with the answer. `src/foreman/inspector-config.ts` turns it into a
// round's refusal and `fabrica doctor`'s per-project line turns it into
// a FAIL, so the two can never disagree about what Inspector would say.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { INSPECTOR_CONFIG } from "./run.ts";

/** The file Inspector builds the check box from, at the repository root.
 * Inspector's own `ProjectDockerfileName`: fixed rather than
 * configurable, by its ruling - a configurable path would be a second
 * way to say the same thing, one its gate could not protect by name from
 * the base branch alone. `src/register/dockerfile.ts` holds the same
 * name for the file it writes; this is the copy the check reads. */
export const INSPECTOR_DOCKERFILE = "Dockerfile.inspector";

/** Which of Inspector's documented config refusals this is. */
export type InspectorConfigRefusal =
  /** `.inspector.json` still carries `"image"` (any value). */
  | "retired-image-key"
  /** `.inspector.json` still carries `"network"` (any value). */
  | "retired-network-key"
  /** No `Dockerfile.inspector` at the repository root. */
  | "no-dockerfile"
  /** One on disk that git does not track - gitignored, or never added.
   * Reachable only from a working-tree read: a commit either holds the
   * file or does not. */
  | "uncommitted-dockerfile";

export interface InspectorConfigProblem {
  refusal: InspectorConfigRefusal;
  /** What Inspector refuses, in Inspector's own words - one line, since
   * `fabrica doctor` prints one line per check and a task's refusal
   * message is read in a terminal. */
  detail: string;
  /** The Client's own hand change that clears it, naming the key or the
   * file. Fabrica never makes it. */
  fix: string;
}

/** How `Dockerfile.inspector` stands, as Inspector's own
 * `ProjectDockerfile` resolves it. */
export type DockerfileState = "committed" | "untracked" | "absent";

/** Everything the refusal list is decided from, so every case is
 * testable without a repository. */
export interface InspectorConfigFacts {
  /** `.inspector.json`'s text, or `null` when there is none to read -
   * which is not a problem at all: such a project is self-tested and
   * nothing is ever handed to Inspector (`judge.ts`'s
   * `chooseCheckMode`). */
  config: string | null;
  dockerfile: DockerfileState;
}

/**
 * The first refusal Inspector would reach, or `null` when it would reach
 * none. The config is checked before the Dockerfile because Inspector
 * checks them in that order, so Fabrica names the same first problem
 * rather than a different one.
 *
 * A config that will not parse has its two key checks skipped - they
 * cannot be answered on a file that is not JSON - while the
 * committed-Dockerfile check, which depends on parsing nothing, still
 * runs. That follows `run.ts`'s `declaresTestPaths` ("an unparseable
 * config is Inspector's own refusal to make"), and it is what keeps this
 * from refusing a file Go would have read happily.
 */
export function inspectorConfigProblemIn(facts: InspectorConfigFacts): InspectorConfigProblem | null {
  if (facts.config === null) return null;

  const keys = configKeys(facts.config);
  if (keys !== null) {
    if (keys.has("image")) {
      return {
        refusal: "retired-image-key",
        detail: `${INSPECTOR_CONFIG} still names an "image", and the "image" field has been retired`,
        fix:
          `remove the "image" field from ${INSPECTOR_CONFIG} and commit a ${INSPECTOR_DOCKERFILE} whose FROM ` +
          `names the image it used to name`,
      };
    }
    if (keys.has("network")) {
      return {
        refusal: "retired-network-key",
        detail: `${INSPECTOR_CONFIG} still carries the "network" opt-in, and that opt-in has been retired`,
        fix:
          `remove the "network" field from ${INSPECTOR_CONFIG} and install whatever it was fetching at check ` +
          `time in ${INSPECTOR_DOCKERFILE} instead, at build time - the build may use the network, the check ` +
          `may not`,
      };
    }
  }

  if (facts.dockerfile === "absent") {
    return {
      refusal: "no-dockerfile",
      detail: `this repo commits no ${INSPECTOR_DOCKERFILE}, so there is no image to run its check in`,
      fix: `add ${INSPECTOR_DOCKERFILE} at the repo root, carrying this project's toolchain and its dependencies, and commit it`,
    };
  }
  if (facts.dockerfile === "untracked") {
    return {
      refusal: "uncommitted-dockerfile",
      detail:
        `${INSPECTOR_DOCKERFILE} exists here but git does not track it (it is ignored, or was never added), ` +
        `so the image the check would run in is not part of this commit`,
      fix: `commit ${INSPECTOR_DOCKERFILE}`,
    };
  }
  return null;
}

/**
 * The same question asked of a real repository: `revision`'s tree when
 * one is named, the working tree when none is.
 *
 * Both callers need a different one, and both are right. A round asks
 * about the exact commit its task was cut from - the same
 * `(workdir, revision)` pair `inspectorIsConfigured` and
 * `declaresTestPaths` are read at, and a tree no Worker has had its
 * hands on. `fabrica doctor` asks about the checkout in front of the
 * Client, which is what it reports on everywhere else.
 */
export function readInspectorConfigFacts(repoRoot: string, revision?: string): InspectorConfigFacts {
  return revision === undefined ? workingTreeFacts(repoRoot) : revisionFacts(repoRoot, revision);
}

/** `readInspectorConfigFacts` + `inspectorConfigProblemIn`: the one call
 * both callers make. */
export function inspectorConfigProblem(repoRoot: string, revision?: string): InspectorConfigProblem | null {
  return inspectorConfigProblemIn(readInspectorConfigFacts(repoRoot, revision));
}

function workingTreeFacts(repoRoot: string): InspectorConfigFacts {
  return {
    config: readFileOrNull(join(repoRoot, INSPECTOR_CONFIG)),
    dockerfile: workingTreeDockerfile(repoRoot),
  };
}

/** Inspector's own `ProjectDockerfile`, in the same two steps: is the
 * file there at all, and does git track it. A directory of that name is
 * not a Dockerfile, so it counts as absent - Inspector refuses it too,
 * with a message of its own this does not try to reproduce. */
function workingTreeDockerfile(repoRoot: string): DockerfileState {
  const path = join(repoRoot, INSPECTOR_DOCKERFILE);
  if (!existsSync(path)) return "absent";
  try {
    if (statSync(path).isDirectory()) return "absent";
  } catch {
    return "absent";
  }
  const tracked = git(repoRoot, ["ls-files", "--full-name", "--", INSPECTOR_DOCKERFILE]);
  // git itself could not answer - not a repository, no git on PATH.
  // Nothing is claimed about a question that was never answered: the
  // file is there, and whether it is committed is for whoever can ask.
  if (tracked === null) return "committed";
  return tracked
    .split("\n")
    .map((line) => line.trim())
    .includes(INSPECTOR_DOCKERFILE)
    ? "committed"
    : "untracked";
}

/** A commit either holds the file or does not, so "untracked" has no
 * meaning here and `no-dockerfile` is exactly what Inspector would say
 * about that commit. */
function revisionFacts(repoRoot: string, revision: string): InspectorConfigFacts {
  const listed = git(repoRoot, ["ls-tree", "--name-only", revision, "--", INSPECTOR_DOCKERFILE]);
  return {
    config: git(repoRoot, ["show", `${revision}:${INSPECTOR_CONFIG}`]),
    dockerfile: listed !== null && listed.trim() === INSPECTOR_DOCKERFILE ? "committed" : "absent",
  };
}

/** The config's own top-level keys, or `null` when the text is not a
 * JSON object at all - a document this cannot answer the key questions
 * about. Keys, not values: Inspector refuses `"image"` and `"network"`
 * on presence alone, so `"network": false` is a refusal there and must
 * be one here. */
function configKeys(text: string): Set<string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return new Set(Object.keys(parsed as Record<string, unknown>));
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}
