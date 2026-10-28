// `fabrica register <path>`: sets a repository up for Fabrica and adds
// it to projects.toml. The mechanism, and the reasoning behind its
// ordering, lives in src/register/ (see that module's README); this file
// is the CLI layer only - parse, call, report - built on src/index.ts
// like every other command here.

import { resolve } from "node:path";
import { RegisterError, RegisterProposalError, registerProject } from "../index.ts";
import type { RegisterResult, RegisterTools } from "../index.ts";
import { CliError } from "./errors.ts";
import { resolveRecordHome } from "./record-home.ts";
import { REGISTER_USAGE, parseRegisterArgs } from "./register-args.ts";

export const REGISTER_HELP = `Usage: ${REGISTER_USAGE}

Sets a repository up for Fabrica and registers it, in one go. Run it
once per project, before the first \`fabrica do\` against it.

  <path>                   The repository's own root. Must be a git
                            repository with an "origin" remote.
  --check "<command>"      The one command that must pass for work on
                            this project to be green. It is written into
                            a check.sh at the repository root, and run
                            once inside --image before anything is
                            pushed - if it fails, nothing is.
  --image <docker image>   The image that command runs inside, here and
                            for every later task. It goes on the FROM
                            line of a Dockerfile.inspector written at the
                            repository root, which is what Inspector
                            builds the check box from. Fabrica never runs
                            a project's check on your machine.
  --timeout <seconds>      How long the check may take before it counts
                            as failed. Left to Inspector's own default
                            unless you pass this.
  --protected <glob,...>   Extra paths a worker may never quietly change,
                            on top of check.sh, .inspector.json and
                            Dockerfile.inspector, which are always
                            protected.
  --name <name>            The name to register it under. Defaults to
                            origin's repository name.

What it does, in order - everything that can refuse refuses before
anything is created:

  1. Checks <path> is a git repository's root with an origin, that the
     GitHub CLI is logged in to origin's own host, that Docker is up,
     that there is no fabrica/register branch already, and that this
     project isn't registered already. Any one of those refuses, naming
     exactly what is missing, having changed nothing.
  2. Creates a temporary worktree of origin's default branch - never
     your own checkout, which is only ever read.
  3. Writes .inspector.json (plus --timeout when given), check.sh, and
     Dockerfile.inspector with --image on its FROM line - unless the
     repository already carries one, which is left exactly as it is.
     The check container has no network, so a project with a
     package-lock.json or a go.sum gets its dependencies installed in
     that Dockerfile at build time, and anything else gets a comment
     there naming what still has to be. Then it runs check.sh inside
     --image. A failing check refuses here: nothing is pushed. This one
     proving run does have the network, unlike the check box, so a
     check about to be green cannot read as red.
  4. Commits, pushes the fabrica/register branch with your own git
     credentials, and opens a pull request with \`gh pr create\`.
  5. Appends [projects.<name>] to projects.toml, including
     onlyTouchedTests = true - the standing instruction every Worker on
     this project is given: run the tests covering what you touched,
     not the whole suite, since the check runs in full afterwards
     anyway. Set it to false there to turn it off for this project, or
     say "run the full suite" in a task's own text for that one task.

This is the one Fabrica command that pushes. It only ever creates a
branch for you to merge - never a merge, never a force-push, never an
existing branch - and it only runs as you, never inside a worker.

If origin's default branch already has .inspector.json, the repository
is set up already: step 5 is all that runs, --check and --image are not
needed, and the recorded check is the repository's own ./check.sh.

Run it without --check and --image on a repository that is *not* set up
and it proposes an .inspector.json instead, derived from what the
repository already says (an existing check.sh, package.json's scripts
and engines, go.mod), and stops having created nothing:

    fabrica register <path> > <path>/.inspector.json

The proposed document is the only thing on stdout, so that redirect
writes exactly it. Every field's reasoning goes to stderr, one line per
field, along with any disagreement between two signals - and so does a
proposed Dockerfile.inspector to commit next to it, since the check box
is built from that file. It exits non-zero, because nothing was written
and nothing was registered: read the proposal, replace anything marked
REPLACE-ME..., commit it yourself, and run this again. Fabrica never
writes those files for you unasked - the files defining how Fabrica's
own work is judged are yours to commit.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

export interface RunRegisterCommandOptions {
  recordHome?: string;
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Test-only seam replacing the real gh/Docker/container/gh-pr-create
   * calls - see src/register/tools.ts's RegisterTools. */
  tools?: RegisterTools;
}

/** The lines reporting a finished registration. Separate from the run
 * itself so the wording is testable without a registration. */
export function registerSummary(result: RegisterResult): string[] {
  const lines: string[] = [];
  if (result.kind === "full") {
    lines.push(`Opened a pull request setting ${result.name} up for Fabrica:`);
    lines.push(`  ${result.pullRequestUrl}`);
    lines.push(
      `  branch ${result.branch} -> ${result.defaultBranch}, with .inspector.json, check.sh` +
        (result.dockerfile === "already-committed" ? `` : ` and Dockerfile.inspector`)
    );
    if (result.dockerfile === "already-committed") {
      lines.push(`  Dockerfile.inspector was already committed there - left exactly as it is`);
    }
    lines.push(`  ${result.check} passed inside the image before it was pushed`);
    for (const warning of result.warnings ?? []) lines.push(`  worth a look: ${warning}`);
  } else {
    lines.push(`${result.name} was already set up on origin/${result.defaultBranch} - registered it as it is.`);
  }
  lines.push(`Registered in ${result.tomlPath}:`);
  for (const line of result.tomlEntry.trim().split("\n")) lines.push(`  ${line}`);
  lines.push(
    result.kind === "full"
      ? `Merge that pull request, then: fabrica do "<task text>" --project ${result.name}`
      : `Ready: fabrica do "<task text>" --project ${result.name}`
  );
  return lines;
}

/** Returns the process exit code - never throws. */
export async function runRegisterCommand(argv: string[], opts: RunRegisterCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  try {
    const args = parseRegisterArgs(argv);
    const recordHome = opts.recordHome ?? resolveRecordHome();
    // Resolved against cwd so `fabrica register .` works, and recorded
    // in projects.toml as an absolute path (Client ruling: "write path
    // as the absolute path given") - a relative one in the registry
    // would mean something different to every later caller.
    const path = resolve(opts.cwd ?? process.cwd(), args.path);

    const result = await registerProject(
      {
        recordHome,
        path,
        ...(args.check !== undefined ? { check: args.check } : {}),
        ...(args.image !== undefined ? { image: args.image } : {}),
        protectedPaths: args.protectedPaths,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.timeoutSeconds !== undefined ? { timeoutSeconds: args.timeoutSeconds } : {}),
      },
      {
        ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
        // Progress goes to stderr: this command does slow, outward-facing
        // things (pulling an image, pushing, calling GitHub) and saying
        // nothing for a minute reads as a hang - but stdout stays the
        // summary alone, so it is still worth reading from a script.
        notify: stderr,
      }
    );

    for (const line of registerSummary(result)) stdout(line);
    return 0;
  } catch (err) {
    // A proposed .inspector.json (issue #114). The document goes to
    // stdout and nothing else does, so `fabrica register <path> >
    // .inspector.json` writes exactly the file - one console.log, so it
    // ends in exactly one newline. Every field's reasoning goes to
    // stderr instead, because JSON has nowhere to put a comment.
    //
    // Still exit 1: nothing was written and nothing was registered, so
    // `fabrica register <path> && fabrica do ...` must not read this as
    // a successful registration.
    if (err instanceof RegisterProposalError) {
      stdout(err.proposal.json);
      stderr(err.message);
      return 1;
    }
    if (err instanceof CliError || err instanceof RegisterError) {
      stderr(err.message);
      return 1;
    }
    throw err;
  }
}
