// A terms folder measured against what Inspector refuses, before a task
// starts (issue #316).
//
// Inspector's `-terms <dir>` names a folder outside the repository
// holding `.inspector.json`, `Dockerfile.inspector` and this project's
// check script - for a company repository none of the three may be
// committed to. Inspector refuses such a folder by name for six
// reasons, and refusing them here instead costs a round nothing: the
// alternative is the Client finding out after a machine has run, with
// the reason three screens down in `fabrica log`.
//
// This is Fabrica's own copy of those refusals, read from Inspector's
// own source rather than from prose about it
// (`internal/inspector/terms.go`'s `ResolveTerms`, plus `Config()` and
// `Dockerfile()`, at main `be0fd560`, 2026-10-30):
//
//   - a path that cannot be made absolute, or does not resolve to a
//     real, existing path;
//   - one that is not a directory;
//   - one whose path contains a colon, which Docker's own `-v` mount
//     syntax uses as a separator, so the folder could not be mounted;
//   - one inside the repository under check (that is in-repo terms at a
//     path Inspector's gate does not protect - such a project commits
//     them at the repository root and names no folder at all);
//   - one that contains the repository, since the whole ancestor would
//     be mounted into the check box;
//   - one missing either file Inspector reads out of it.
//
// It deliberately does NOT re-check what a committed Dockerfile needs:
// Inspector's own `Dockerfile()` requires a committed file for in-repo
// terms and only an existing one for outside terms, and a folder outside
// the repository is not under git at all. The config's own retired keys
// are checked by `config-check.ts`, which this hands off to, so there is
// one list of those and not two.
//
// Like `config-check.ts`, this module reads and answers; it decides
// nothing. `src/foreman/inspector-config.ts` turns the answer into a
// round's refusal and `fabrica doctor`'s per-project line turns it into
// a FAIL, so the two can never disagree about what Inspector would say.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { declaresTestPaths, INSPECTOR_CONFIG } from "./run.ts";
import { inspectorConfigProblemIn, INSPECTOR_DOCKERFILE } from "./config-check.ts";
import type { InspectorConfigProblem } from "./config-check.ts";

/** The two files Inspector reads out of a terms folder by name. The
 * check script is not one of them: which script (or command) runs is
 * `.inspector.json`'s own business, so a folder holding a config that
 * names no script is Inspector's refusal to make, not this one's. */
export const TERMS_REQUIRED_FILES = [INSPECTOR_CONFIG, INSPECTOR_DOCKERFILE] as const;

/**
 * What a terms folder says about a project, in the same two answers
 * `originSetup` gives about an in-repo config (src/register/origin.ts) -
 * so `fabrica do`'s one up-front refusal reads either kind of project
 * through the same two fields.
 *
 * `inspectorConfigured` is true by the setting alone: a project that
 * names a terms folder IS an Inspector project, and a folder that cannot
 * be used is a different finding with a different fix - told to the
 * Client by `termsProblem` above, through the round's own refusal and
 * `fabrica doctor`, never as "this project isn't set up for Fabrica
 * yet", which would send him to run `fabrica register` against a
 * repository nothing may be added to.
 */
export function termsSetup(termsDir: string): { inspectorConfigured: boolean; declaresTestPaths: boolean } {
  return { inspectorConfigured: true, declaresTestPaths: declaresTestPaths(termsDir) };
}

/**
 * The first refusal Inspector would reach about this terms folder, or
 * `null` when it would reach none - the same shape, and the same two
 * readers, `inspectorConfigProblem` has.
 *
 * `repoRoot` is the repository Inspector will be handed (`-repo`), which
 * for a round is the task's own worktree rather than the Client's
 * checkout: the inside/contains questions are asked about the tree
 * Inspector actually compares the folder against.
 */
export function termsProblem(termsDir: string, repoRoot: string): InspectorConfigProblem | null {
  const named = `terms = "${termsDir}"`;
  // In Inspector's own order throughout (does it resolve, is it a
  // directory, does its path hold a colon, then where it sits relative
  // to the repository), so a folder with more than one thing wrong with
  // it is named here by the same first problem Inspector would name -
  // the same rule `config-check.ts` follows for its own two checks.
  if (!existsSync(termsDir)) {
    return {
      refusal: "terms-missing",
      detail: `${named} names a folder that is not there`,
      fix:
        `create it, holding this project's ${TERMS_REQUIRED_FILES.join(" and ")} plus its check script - or ` +
        `correct the path - and leave it readable to Fabrica`,
    };
  }
  if (!isDirectory(termsDir)) {
    return {
      refusal: "terms-not-a-directory",
      detail: `${named} is not a directory, and terms names the folder holding this project's own terms`,
      fix: `point ${named} at the folder holding ${TERMS_REQUIRED_FILES.join(" and ")}`,
    };
  }

  if (termsDir.includes(":")) {
    return {
      refusal: "terms-unmountable",
      detail:
        `${named} contains a colon, which Docker's own mount syntax uses as a separator, so the folder ` +
        `could not be mounted into the check box`,
      fix: `move this project's terms to a folder with no colon in its path and point ${named} at it`,
    };
  }

  const dir = real(termsDir);
  const repo = real(repoRoot);
  if (contains(repo, dir)) {
    return {
      refusal: "terms-inside-repo",
      detail: `${named} is inside ${repoRoot}, the repository under check, so these are in-repo terms`,
      fix: `either commit this project's terms at its repository root and remove the terms setting, or move them outside the repository`,
    };
  }
  if (contains(dir, repo)) {
    return {
      refusal: "terms-contains-repo",
      detail: `${named} contains ${repoRoot}, the repository under check, so the whole folder above it would be mounted into the check box`,
      fix: `put this project's terms in a folder of their own and point ${named} at that`,
    };
  }

  for (const file of TERMS_REQUIRED_FILES) {
    if (!existsSync(join(dir, file))) {
      return {
        refusal: "terms-incomplete",
        detail: `${named} holds no ${file}, which Inspector reads out of the terms folder by name`,
        fix: `add ${file} to ${termsDir}`,
      };
    }
  }

  // Both files are there, so the only questions left are the ones
  // `.inspector.json` itself can fail - one list of those, not two.
  // `dockerfile: "committed"` is this folder's honest state for the
  // question that list asks: Inspector requires a *committed*
  // Dockerfile only for in-repo terms, and a folder outside the
  // repository is not under git at all.
  return inspectorConfigProblemIn({ config: readFileOrNull(join(dir, INSPECTOR_CONFIG)), dockerfile: "committed" });
}

/** Whether `inner` is `outer` itself or sits underneath it, compared on
 * resolved paths so a symlinked temp dir (macOS's /var ->
 * /private/var) cannot make one folder look like two. Inspector asks
 * the same question of the same two paths. */
function contains(outer: string, inner: string): boolean {
  if (outer === inner) return true;
  const prefix = outer.endsWith(sep) ? outer : `${outer}${sep}`;
  return inner.startsWith(prefix);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
