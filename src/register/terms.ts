// `fabrica register <path> --terms <folder>`: setting up a project whose
// terms cannot live in its own repository.
//
// At a day job the three files that say how work is judged -
// `.inspector.json`, `check.sh`, `Dockerfile.inspector` - cannot be
// committed to the company's repository at all. There is no pull request
// to open for them and no branch to push. So they are written into a
// folder of the Client's own instead, beside the checkout rather than in
// it, and `projects.toml` records where.
//
// Three properties this route keeps, and they are the whole of it:
//
//   - **The repository is not touched.** No worktree, no commit, no
//     branch, no push, no pull request. The Client's own checkout is
//     only read, exactly as on every other route.
//   - **The contents are derived, not invented.** `propose.ts`'s
//     `deriveProposal` is the same code, over the same signals, read off
//     the same ref (origin's default branch) as the proposal `register`
//     prints today. There is no second set of rules for a work-mode
//     project.
//   - **Nothing already in the folder is overwritten** (Client ruling on
//     this task: "keep existing files, write only what's missing"). The
//     write is a `wx` open per file, so "already there" is the
//     filesystem's own answer rather than a question asked before a
//     write that could race it.
//
// What it deliberately does NOT do: prove the check. The repository
// route runs `./check.sh` inside `--image` before it pushes anything,
// and can, because it has a worktree to run it against and an image the
// Client named. Here there is neither - the `FROM` line is usually a
// placeholder the Client has yet to replace - so this route proves
// nothing, and says so rather than implying a setup that has been
// tested.

import { chmodSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { RegisterError } from "./errors.ts";
import { CHECK_SCRIPT, INSPECTOR_CONFIG, RECORDED_CHECK } from "./origin.ts";
import { DOCKERFILE_INSPECTOR } from "./dockerfile.ts";
import { IMAGE_PLACEHOLDER_PREFIX, deriveProposal, type ProposalSignals } from "./propose.ts";
import { checkScript, inspectorConfigJson } from "./scaffold.ts";

/**
 * The marker a file carries where no signal could supply the value - the
 * same string the proposed `FROM` line uses, so the one instruction
 * ("replace anything marked REPLACE-ME-with-...") covers every one of
 * them. The constant's name says `IMAGE_` because that was its first
 * use; the string itself is the marker, not a statement about images.
 */
const CHECK_PLACEHOLDER = `${IMAGE_PLACEHOLDER_PREFIX}the-one-command-that-must-pass`;

/** What happened to one of the three files. */
export type TermsFileOutcome =
  /** It was not in the folder, and was written. */
  | "written"
  /** It was already in the folder, and was left exactly as it is. */
  | "kept"
  /** `check.sh` only: the repository carries its own at its root, which
   * is the file `.inspector.json` names, so writing a second one here
   * would be a silent fork of it. */
  | "repository-has-its-own";

export interface TermsFile {
  /** The file's own name, as it is in the folder. */
  file: string;
  outcome: TermsFileOutcome;
  /** Why, in one line - this is printed, never only recorded. */
  detail: string;
}

export interface TermsResult {
  /** The folder, absolute. */
  terms: string;
  /** All three files, in the order they are written, every one carrying
   * what happened to it - a file that was not written is never left
   * unmentioned. */
  files: TermsFile[];
  /** Where every value came from, one line per field, plus any
   * disagreement between two signals and the one warning about the
   * check itself. The same lines the printed proposal puts on stderr. */
  notes: string[];
}

/**
 * `<folder>` as an existing directory, absolute - or a `RegisterError`
 * naming what is wrong with it. Creates nothing: a `--terms` typo must
 * not leave a stray folder holding three files and a `projects.toml`
 * entry pointing at it, which is exactly the quiet wrong state this
 * command's refuse-first order exists to prevent.
 *
 * A folder inside the repository is refused too. It would be in every
 * Worker's own checkout - visible, editable and committable by the very
 * task it is meant to judge - which is the opposite of what this route
 * is for.
 */
export function resolveTermsFolder(terms: string, project: string): string {
  // `resolve` with no base, exactly like `request.path`: the CLI layer
  // has already made both absolute against the Client's own working
  // directory (src/cli/register-command.ts), so a relative one reaching
  // here is a library caller's, resolved the same way every other path
  // in this module is.
  const given = resolve(terms);

  let stats;
  try {
    stats = statSync(given);
  } catch {
    throw new RegisterError(
      "terms-unusable",
      `fabrica register: --terms ${given} does not exist. Create it first (\`mkdir -p ${given}\`) - ` +
        `\`fabrica register\` never creates it for you, so a mistyped path cannot quietly become a registered ` +
        `project's terms folder. Nothing was changed.`
    );
  }
  if (!stats.isDirectory()) {
    throw new RegisterError(
      "terms-unusable",
      `fabrica register: --terms ${given} is not a folder. It names the folder ${INSPECTOR_CONFIG}, ` +
        `${CHECK_SCRIPT} and ${DOCKERFILE_INSPECTOR} go in, not a file. Nothing was changed.`
    );
  }

  // Both sides through realpath before comparing: on macOS, os.tmpdir()
  // reaches one directory through a /var -> /private/var symlink, so an
  // unresolved comparison answers "no" for two paths that are the same
  // folder.
  const path = realpathSync(given);
  const rel = relative(realpathSync(project), path);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new RegisterError(
      "terms-inside-repo",
      `fabrica register: --terms ${given} is inside ${project}, the repository itself. A work-mode project's ` +
        `terms are kept outside the repository on purpose: in it, they are in every worker's own checkout, ` +
        `where the task being judged could edit them. Name a folder beside the repository instead. Nothing ` +
        `was changed.`
    );
  }

  return path;
}

/**
 * Writes whatever of the three files the folder is missing, and reports
 * on all three either way. The project's recorded check is always
 * `RECORDED_CHECK` - see this module's README on why there is one source
 * of truth for the check.
 */
export function writeTerms(opts: {
  /** Absolute and existing - `resolveTermsFolder` above. */
  terms: string;
  signals: ProposalSignals;
  projectPath: string;
}): TermsResult {
  const derived = deriveProposal(opts.signals);
  const { check, dependencies, image, protectedPaths } = derived;

  // `.inspector.json` names `./check.sh` here whatever the signals said,
  // unlike the printed proposal, which can name `npm test` because it
  // writes no script for that command to live in. This route does write
  // one, so the derived command goes inside it and the config, the
  // script and projects.toml all name the same thing.
  const config = inspectorConfigJson({
    ...(derived.timeoutSeconds !== undefined ? { timeoutSeconds: derived.timeoutSeconds } : {}),
    ...(protectedPaths.paths !== undefined ? { protectedPaths: protectedPaths.paths } : {}),
  });

  const written: string[] = [];
  const files: TermsFile[] = [];

  try {
    files.push(
      writeIfMissing(opts.terms, INSPECTOR_CONFIG, config, written, {
        written: `asks Inspector to judge work on this repository, and names ${RECORDED_CHECK}`,
        kept: `was already in this folder - left exactly as it is`,
      })
    );

    if (check.source === "repository-script") {
      // The repository's own check.sh is the file `./check.sh` means,
      // and a copy here would fork it silently - an edit to one would
      // leave the other saying something else. Reported, never skipped
      // quietly.
      files.push({
        file: CHECK_SCRIPT,
        outcome: "repository-has-its-own",
        detail:
          `not written: ${opts.projectPath} already carries its own ${CHECK_SCRIPT} at its root, which is the ` +
          `file ${RECORDED_CHECK} names - a second one here would be a silent fork of it`,
      });
    } else {
      const declared = check.source === "declared-command";
      // `scriptCommand` when the derived check only works inside this
      // script (issue #324's servers and test database): there, `command`
      // is `./check.sh` itself, and writing that into the script would
      // have it call itself forever.
      const body = declared
        ? check.scriptCommand ?? check.command
        : `# ${CHECK_PLACEHOLDER}\n` +
          `echo "${CHECK_SCRIPT}: no command has been written here yet - nothing in the repository named ` +
          `one." >&2\n` +
          `exit 1`;
      const result = writeIfMissing(opts.terms, CHECK_SCRIPT, checkScript(body, dependencies.shape), written, {
        written: declared
          ? `holds the one command that has to pass: ${check.scriptCommand ?? check.command}`
          : `fails until you write the command in it - nothing in the repository named one, and a stub that ` +
            `exited 0 would make every task on this project green for free`,
        kept: `was already in this folder - left exactly as it is`,
      });
      if (result.outcome === "written") chmodSync(join(opts.terms, CHECK_SCRIPT), 0o755);
      files.push(result);
    }

    files.push(
      writeIfMissing(opts.terms, DOCKERFILE_INSPECTOR, derived.dockerfile, written, {
        written: `the image that command runs in, built from ${image.value}`,
        kept: `was already in this folder - left exactly as it is`,
      })
    );
  } catch (err) {
    // Everything this call created, removed again - never a file that
    // was already there. A half-written terms folder registered as if it
    // were whole is worse than a refusal.
    for (const path of written) rmSync(path, { force: true });
    const removed =
      written.length === 0
        ? `Nothing was written`
        : `The ${written.length === 1 ? `file` : `files`} this run had already created ` +
          `(${written.map((path) => relative(opts.terms, path)).join(", ")}) ` +
          `${written.length === 1 ? `was` : `were`} removed again`;
    throw new RegisterError(
      "terms-write-failed",
      `fabrica register: could not write this project's terms into ${opts.terms}: ` +
        `${err instanceof Error ? err.message : String(err)}. ${removed}, and nothing was registered.`
    );
  }

  // The `/deps` linking instruction only when nothing here wrote a
  // `check.sh` with that preamble already in it - otherwise it is done,
  // and saying it would read as something still to do.
  const wroteCheckScript = files.some((file) => file.file === CHECK_SCRIPT && file.outcome === "written");
  const linking = wroteCheckScript ? null : derived.linkingNote;

  return {
    terms: opts.terms,
    files,
    notes: [...derived.fieldNotes, ...(linking === null ? [] : [linking])],
  };
}

/** One file, written only if the folder does not already have it. The
 * `wx` flag is what makes that a single operation rather than a question
 * followed by a write that could race the answer. */
function writeIfMissing(
  terms: string,
  file: string,
  contents: string,
  written: string[],
  detail: { written: string; kept: string }
): TermsFile {
  const path = join(terms, file);
  try {
    writeFileSync(path, contents, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { file, outcome: "kept", detail: detail.kept };
    }
    throw err;
  }
  written.push(path);
  return { file, outcome: "written", detail: detail.written };
}
