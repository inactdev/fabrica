// The core comparison: "does this registered project look different from
// the last time Fabrica looked, in a way worth telling the Client about?"
//
// What counts as "worth telling him about" (defended in src/offbooks/
// README.md): Fabrica never writes to a registered project's own checkout
// (CONTRACT rule 1) — everything it does happens on a disposable
// ProductionLine. So from this net's point of view, ANY tracked-content
// change it sees here came from outside Fabrica: the Client's own hand, or
// some agent editing directly instead of going through a task. The design
// goal is not to guess which of those it was — it is to stay quiet through
// the ordinary noise a working checkout produces on its own, and to fire,
// once, on everything else:
//
//   - Ignored/build-artifact/editor-scratch noise never reaches this
//     function at all: `readProjectGitState` uses plain `git status`,
//     which already excludes anything matched by .gitignore.
//   - A branch switch resets the baseline instead of comparing across it
//     — "the Client is using this checkout for his own unrelated work
//     right now" is the single most common reason a working tree looks
//     different that has nothing to do with an off-the-books edit.
//   - A real content change (dirty working tree OR HEAD moved) on the SAME
//     branch fires exactly once, then becomes the new baseline — so the
//     same diff never re-fires on every subsequent command.

import { appendEvent } from "../record/index.ts";
import { readBaseline, writeBaseline } from "./baseline.ts";
import { filesChangedBetween, pathFromPorcelainLine, readProjectGitState } from "./git-state.ts";
import type { ProjectGitState } from "./types.ts";

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

function dirtyFileDiff(baseline: ProjectGitState, current: ProjectGitState): string[] {
  const baselineLines = new Set(baseline.dirty);
  const currentLines = new Set(current.dirty);
  const files = new Set<string>();
  for (const line of current.dirty) if (!baselineLines.has(line)) files.add(pathFromPorcelainLine(line));
  for (const line of baseline.dirty) if (!currentLines.has(line)) files.add(pathFromPorcelainLine(line));
  return [...files];
}

/**
 * Checks one registered project and, if warranted, appends an
 * "unattributed-change" event. Never throws — a git failure or a first-ever
 * look at a project both resolve to "nothing to report," not an error.
 */
export function detectUnattributedChange(recordHome: string, projectName: string, projectPath: string): void {
  const current = readProjectGitState(projectPath);
  if (!current) return; // not a usable git checkout right now — nothing to compare

  const baseline = readBaseline(recordHome, projectName);
  if (!baseline) {
    writeBaseline(recordHome, projectName, current); // first look: establish, don't alarm
    return;
  }

  if (baseline.branch !== current.branch) {
    writeBaseline(recordHome, projectName, current); // a branch switch, not a change to explain
    return;
  }

  const dirtyChanged = !sameLines(baseline.dirty, current.dirty);
  const headMoved = baseline.headCommit !== current.headCommit;
  if (!dirtyChanged && !headMoved) return; // genuinely nothing new since last time

  const files = new Set<string>(dirtyFileDiff(baseline, current));
  let filesUnknown = false;
  if (headMoved) {
    const moved = filesChangedBetween(projectPath, baseline.headCommit, current.headCommit);
    if (moved === null) {
      // A rewritten history (rebase, force-push) can make the old commit
      // unreachable. Something still changed and still gets recorded — the
      // event says so rather than showing an empty list as if it knew.
      filesUnknown = true;
    } else {
      for (const file of moved) files.add(file);
    }
  }

  writeBaseline(recordHome, projectName, current);

  appendEvent(recordHome, {
    taskId: `project:${projectName}`,
    name: "unattributed-change",
    details: {
      project: projectName,
      path: projectPath,
      branch: current.branch,
      files: [...files].sort(),
      ...(filesUnknown ? { filesUnknown: true } : {}),
    },
  });
}
