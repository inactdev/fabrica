// A round never starts on a configuration Inspector is known to refuse
// (issue #306).
//
// The failure this closes: on 2026-10-27 the installed Inspector began
// refusing every project whose `.inspector.json` still named an `image`
// (inspector#47), and Fabrica found out one task at a time - each after
// a full round, with the reason buried three screens down in `fabrica
// log`. The config was readable the whole time; nothing had looked at
// it.
//
// Asked here, in `judge.ts`'s `prepareRound`, beside the two refusals
// that already live there (`requireReviewer` and `Inspector.prepare`),
// for three reasons:
//
//   - it is the one chokepoint every round goes through - a first
//     `fabrica do`, a resumed `fabrica answer`, a `fabrica verdict fix`,
//     and a library caller that never touched the CLI;
//   - it has the task's exact base commit, so the answer is about the
//     tree Inspector will actually judge rather than about whatever the
//     Client happens to have checked out (the same reason
//     `requireReviewer` reads `.inspector.json` at `baseCommit`); and
//   - it still runs before any machine: `prepareRound` is called before
//     `"work-started"` is appended, so `fabrica do` prints the refusal
//     and exits 1 the way it already does for a cap refusal.
//
// What it costs when it refuses is the clarifying step and the
// ProductionLine's own cut, both of which precede it - never a worker,
// never a check, never a handoff.
//
// Issue #316 adds the same refusal for the other place a project's
// configuration can live: a terms folder outside the repository, for a
// repository none of those files may be committed to. One of
// `requireInspectorConfig` or `requireTermsFolder` runs per round, never
// both - a project keeps its terms in one place or the other.

import { inspectorConfigProblem, termsProblem, INSPECTOR_CONFIG } from "../inspector/index.ts";
import { ForemanError } from "./errors.ts";

/**
 * Throws `ForemanError("inspector-config-refused")` when the installed
 * Inspector is known to refuse this project's configuration at
 * `baseCommit`. The caller records it: every path into `prepareRound`
 * runs inside `recordingFailure`, which appends `"task-failed"` with
 * this message before it reaches the Client's terminal.
 *
 * Silent only where it genuinely has nothing to say - a project with no
 * `.inspector.json` at that commit, which is self-tested and hands
 * Inspector nothing at all.
 */
export function requireInspectorConfig(workdir: string, baseCommit: string): void {
  refuseOn(inspectorConfigProblem(workdir, baseCommit), "on the branch tasks are cut from");
}

/**
 * The same refusal for a project whose terms live in a folder outside
 * its repository (issue #316, work mode). Its `.inspector.json` and
 * `Dockerfile.inspector` are in that folder, not in any commit, so the
 * check above has nothing to read and this one reads the folder instead
 * - the six refusals Inspector's own `-terms` makes, plus the config
 * refusals both kinds of terms share (`src/inspector/terms.ts`).
 *
 * `repoRoot` is the repository Inspector will be handed, because two of
 * those refusals are about where the folder sits relative to it.
 */
export function requireTermsFolder(termsDir: string, repoRoot: string): void {
  refuseOn(termsProblem(termsDir, repoRoot), `in ${termsDir}`);
}

/** One wording for both, since both are "Inspector would turn this
 * away, and here is the hand change that clears it". `where` is where
 * that change has to be made - the branch tasks are cut from for an
 * in-repo config, the terms folder itself for an outside one. */
function refuseOn(problem: { detail: string; fix: string } | null, where: string): void {
  if (problem === null) return;
  throw new ForemanError(
    "inspector-config-refused",
    `Refused before anything started: Inspector would refuse this project's configuration - ${problem.detail}. ` +
      `Nothing was started, and nothing was changed: Fabrica never edits ${INSPECTOR_CONFIG} or the files beside ` +
      `it. To fix it, ${problem.fix}, ${where}, then run the task again.`
  );
}
