// `fabrica register <path>`: the one command in Fabrica allowed to push.
//
// It is allowed to because of what it is, not by exception: it runs as
// the Client, on the Client's own machine, with his own git credentials,
// and the only thing it ever pushes is a branch for him to merge - it
// never merges, never force-pushes, never touches an existing branch, and
// never runs inside a worker. Nothing a Worker produced passes through
// here.
//
// The order below is the whole design. Everything that can refuse refuses
// first, while the only thing that has happened is reading - so a missing
// `gh`, a stopped Docker daemon, a branch that already exists or a
// project already in projects.toml costs the Client nothing but the
// message. Only once all of that has passed does anything get created,
// and from that point every failure path unwinds what it made.
//
//   1. <path> is an existing git repository's root, with an origin
//   2. gh is installed and logged in to origin's own host
//   3. the Docker daemon is up (the check runs in a container, never here)
//   4. origin is readable, and has no fabrica/register branch
//   5. no local fabrica/register branch either
//   6. the project name is usable, and isn't registered already
//   7. does origin's default branch already carry .inspector.json?
//        yes -> the projects.toml half only, and stop (step 11)
//        no, and no --check/--image -> print a proposed .inspector.json,
//        derived from what the repository already says, and stop having
//        created nothing (issue #114, see propose.ts)
//   8. a temporary worktree of origin's default branch, on
//      fabrica/register - never the Client's own checkout
//   9. write .inspector.json, check.sh and Dockerfile.inspector (never
//      over a committed one); run check.sh inside --image and refuse if
//      it fails
//  10. commit, push, open the pull request with `gh pr create`
//  11. append [projects.<name>] to projects.toml

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LineError, fetchOriginDefaultBranch, requireRepoRoot } from "../line/index.ts";
import { RegisterError, RegisterProposalError } from "./errors.ts";
import { proposeInspectorConfig, readProposalSignals } from "./propose.ts";
import {
  CHECK_SCRIPT,
  INSPECTOR_CONFIG,
  RECORDED_CHECK,
  REGISTER_BRANCH,
  branchExistsLocally,
  branchExistsOnOrigin,
  fileExistsOnRef,
  hostFromOriginUrl,
  originUrl,
  repoNameFromOriginUrl,
} from "./origin.ts";
import { appendProjectEntry, existingRegistration, isUsableProjectName } from "./registry-write.ts";
import { checkScript, inspectorConfigJson, protectedPathsFor } from "./scaffold.ts";
import {
  DOCKERFILE_INSPECTOR,
  dependencyInstallerIn,
  dependencyShapeInTree,
  inspectorDockerfile,
  type DependencyShape,
} from "./dockerfile.ts";
import { realRegisterTools, type RegisterTools } from "./tools.ts";

export interface RegisterRequest {
  recordHome: string;
  /** The path as the Client gave it; recorded in projects.toml verbatim
   * once resolved to an absolute path (Client ruling: "write path as the
   * absolute path given"). */
  path: string;
  /** Required for the full setup; not required when origin's default
   * branch already carries .inspector.json. */
  check?: string;
  /** `--image`: goes on Dockerfile.inspector's FROM line, which is what
   * the check box is built from since inspector#47 - `.inspector.json`
   * names no image any more. It is also the image this command's own one
   * proving run pulls, so the tag is proven to exist before anything is
   * pushed. */
  image?: string;
  /** Extra globs for .inspector.json's protectedPaths, on top of
   * check.sh, .inspector.json and Dockerfile.inspector themselves. */
  protectedPaths?: readonly string[];
  /** `--timeout <seconds>`: writes `timeoutSeconds` into
   * .inspector.json. Omitted entirely when not given, leaving whatever
   * Inspector's own default is. */
  timeoutSeconds?: number;
  /** Overrides the default name (origin's repository name). */
  name?: string;
}

export interface RegisterResult {
  /** "full": wrote the files, ran the check, opened a pull request, then
   * registered. "registry-only": origin's default branch was already set
   * up, so only projects.toml changed. */
  kind: "full" | "registry-only";
  name: string;
  path: string;
  check: string;
  defaultBranch: string;
  tomlPath: string;
  tomlEntry: string;
  /** Full setup only. */
  branch?: string;
  pullRequestUrl?: string | null;
  checkOutput?: string;
  /** Full setup only: whether Dockerfile.inspector was written, or a
   * committed one was found and left exactly as it was. */
  dockerfile?: DockerfileOutcome;
  /** Traps the Client should see before merging - the pull request body
   * carries the same words. Absent when there are none. */
  warnings?: string[];
}

/** What happened to Dockerfile.inspector. `already-committed` is never
 * an overwrite: register does not touch a file the repository already
 * carries (Client ruling, issue #303's clarification 2). */
export type DockerfileOutcome = "written" | "already-committed";

export interface RegisterOptions {
  tools?: RegisterTools;
  /** Progress for the Client's screen, one line at a time - this command
   * does real, slow, outward-facing things and saying nothing for a
   * minute while a container pulls an image reads as a hang. */
  notify?: (line: string) => void;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitFailure(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string } | undefined)?.stderr;
  if (stderr && stderr.toString().trim().length > 0) return stderr.toString().trim();
  return err instanceof Error ? err.message : String(err);
}

/** Removes the temporary worktree, and - when nothing was pushed - the
 * branch it was on too, so a retry with a corrected --check isn't blocked
 * by the wreckage of this attempt. After a successful push the branch is
 * deliberately left alone: it is on origin, and deleting a branch the
 * Client may want is never this command's call. */
function teardown(project: string, parentDir: string, opts: { deleteBranch: boolean }): void {
  try {
    git(project, ["worktree", "remove", "--force", join(parentDir, "worktree")]);
  } catch {
    // Best effort: the prune below plus removing the directory covers a
    // worktree git has already half-forgotten.
  }
  try {
    git(project, ["worktree", "prune"]);
  } catch {
    // Nothing further to do - this only tidies git's own bookkeeping.
  }
  if (opts.deleteBranch) {
    try {
      git(project, ["branch", "-D", REGISTER_BRANCH]);
    } catch {
      // The branch may never have been created (a failed worktree add).
    }
  }
  rmSync(parentDir, { recursive: true, force: true });
}

export function commitMessageFor(
  name: string,
  command: string,
  dockerfile: DockerfileOutcome = "written"
): string {
  const files =
    dockerfile === "written"
      ? `Adds ${INSPECTOR_CONFIG}, so Inspector independently judges every task's\n` +
        `work on this repository, ${CHECK_SCRIPT}, holding the one command that has\n` +
        `to pass for that work to be green, and ${DOCKERFILE_INSPECTOR}, the image\n` +
        `that command runs in:\n`
      : `Adds ${INSPECTOR_CONFIG}, so Inspector independently judges every task's\n` +
        `work on this repository, and ${CHECK_SCRIPT}, holding the one command that\n` +
        `has to pass for that work to be green. This repository's own\n` +
        `${DOCKERFILE_INSPECTOR} is left exactly as it is:\n`;

  return (
    `Set ${name} up for Fabrica\n` +
    `\n` +
    files +
    `\n` +
    `    ${command}\n` +
    `\n` +
    `${CHECK_SCRIPT}, ${INSPECTOR_CONFIG} and ${DOCKERFILE_INSPECTOR} are all listed as\n` +
    `protected paths, so a change to any of them has to come through a pull\n` +
    `request like this one rather than from a task's own worker.\n`
  );
}

export function pullRequestBodyFor(
  name: string,
  command: string,
  image: string,
  /** What the files actually say, so the reviewer reads the same facts
   * rather than only the diff. */
  box: {
    timeoutSeconds?: number;
    dockerfile?: DockerfileOutcome;
    /** The install step Dockerfile.inspector got, when one was
     * recognized. */
    shape?: DependencyShape | null;
    warnings?: readonly string[];
  } = {}
): string {
  const dockerfile = box.dockerfile ?? "written";
  const shape = box.shape ?? null;

  const dockerfileBullet =
    dockerfile === "written"
      ? `- \`${DOCKERFILE_INSPECTOR}\` - the image that command runs in, built from\n` +
        `  \`${image}\`. The check container has no network, so ` +
        (shape === null
          ? `nothing could be installed\n  in it for you: the file says so where an install step would have gone.\n`
          : `this installs the\n  project's dependencies at build time (\`${shape.install}\`, from\n` +
            `  \`${shape.lockfile}\`), and \`${CHECK_SCRIPT}\` uses what it finds there.\n`)
      : `- \`${DOCKERFILE_INSPECTOR}\` is **not** touched - this repository already\n` +
        `  carries one, and \`fabrica register\` never overwrites a committed file.\n` +
        `  The check was proven in \`${image}\` here, but the box Inspector builds is\n` +
        `  the one that file describes.\n`;

  const timeout =
    box.timeoutSeconds !== undefined
      ? `The check is given at most ${box.timeoutSeconds} seconds to finish.\n\n`
      : ``;

  const warnings = (box.warnings ?? []).map((line) => `- ${line}\n`).join("");

  return (
    `## What\n` +
    `\n` +
    `${dockerfile === "written" ? "Three" : "Two"} new files at the repository root:\n` +
    `\n` +
    `- \`${INSPECTOR_CONFIG}\` - asks Inspector to judge work on this repository.\n` +
    `- \`${CHECK_SCRIPT}\` - the one command that has to pass:\n` +
    `\n` +
    `      ${command}\n` +
    `\n` +
    dockerfileBullet +
    `\n` +
    timeout +
    `## Why\n` +
    `\n` +
    `Until this merges, Fabrica refuses tasks on ${name}: a task's base commit\n` +
    `has nothing saying how the work should be checked, and unchecked work is\n` +
    `not work Fabrica will claim to have verified.\n` +
    `\n` +
    `## How to check it\n` +
    `\n` +
    `\`${command}\` was run inside \`${image}\` against this exact branch before\n` +
    `this pull request was opened, and passed. \`${CHECK_SCRIPT}\`,\n` +
    `\`${INSPECTOR_CONFIG}\` and \`${DOCKERFILE_INSPECTOR}\` are listed as protected\n` +
    `paths in the config, so later changes to any of them need a pull request of\n` +
    `their own.\n` +
    (warnings.length > 0 ? `\n## Worth a look before merging\n\n${warnings}` : ``) +
    `\n` +
    `Opened by \`fabrica register\`, running as the repository owner.\n`
  );
}

/** The one trap worth the Client's eye on this route: a check that
 * installs its own dependencies cannot, in a box with no network. The
 * Dockerfile installs them at build time instead, so a command that
 * installs them again would undo that - it is named rather than left to
 * a red first task. */
export function registerWarnings(command: string, shape: DependencyShape | null): string[] {
  const installer = dependencyInstallerIn(command);
  if (installer === null) return [];
  return [
    `the check command runs \`${installer}\`, and the check box has no network at all, so that cannot ` +
      `succeed there. ` +
      (shape === null
        ? `Install what it needs in ${DOCKERFILE_INSPECTOR} at build time, and have ${CHECK_SCRIPT} use what ` +
          `is already there.`
        : `${DOCKERFILE_INSPECTOR} installs them at build time (\`${shape.install}\`)${
            shape.linksNodeModules ? ` and ${CHECK_SCRIPT} links them in` : ``
          }, so the command should not install them again.`),
  ];
}

/** Returns the parsed, validated inputs every path needs, having proved
 * the machine can do the job - or throws a RegisterError naming the one
 * thing that is missing. Creates nothing. */
function prepare(request: RegisterRequest, tools: RegisterTools) {
  let project: string;
  try {
    project = requireRepoRoot(request.path);
  } catch (err) {
    if (err instanceof LineError) {
      throw new RegisterError(
        "not-a-repo",
        `fabrica register: ${err.message} Fabrica registers a git repository's own root - run \`git init\` ` +
          `there and make a first commit if you haven't, then try again. Nothing was changed.`
      );
    }
    throw err;
  }

  const url = originUrl(project);
  if (url === null) {
    throw new RegisterError(
      "no-origin",
      `fabrica register: ${project} has no "origin" remote, and Fabrica cuts every task's branch from origin's ` +
        `default branch. Add one (\`git remote add origin <url>\`) and push, then try again. Nothing was changed.`
    );
  }

  const host = hostFromOriginUrl(url);
  const gh = tools.ghStatus(host);
  if (!gh.ok) {
    throw new RegisterError(
      "gh-not-ready",
      `fabrica register: ${gh.detail}. ${gh.fix ? `Fix: ${gh.fix}. ` : ""}Nothing was changed.`
    );
  }

  const docker = tools.dockerStatus();
  if (!docker.ok) {
    throw new RegisterError(
      "docker-not-ready",
      `fabrica register: ${docker.detail}. ${docker.fix ? `Fix: ${docker.fix}. ` : ""}Nothing was changed.`
    );
  }

  // Reading origin's branch list proves two things at once: that origin
  // is reachable with the Client's own credentials (so a push has a clean
  // path), and that fabrica/register isn't already there.
  let takenOnOrigin: boolean;
  try {
    takenOnOrigin = branchExistsOnOrigin(project, REGISTER_BRANCH);
  } catch (err) {
    throw new RegisterError(
      "origin-unreadable",
      `fabrica register: could not read origin for ${project}, so there is no clean path to push: ` +
        `${gitFailure(err)}. Nothing was changed.`
    );
  }
  if (takenOnOrigin) {
    throw new RegisterError(
      "branch-exists",
      `fabrica register: origin already has a ${REGISTER_BRANCH} branch. Fabrica never overwrites or ` +
        `force-pushes one. Merge or delete that branch (and close its pull request if it has one), then try ` +
        `again. Nothing was changed.`
    );
  }
  if (branchExistsLocally(project, REGISTER_BRANCH)) {
    throw new RegisterError(
      "branch-exists",
      `fabrica register: ${project} already has a local ${REGISTER_BRANCH} branch, left over from an earlier ` +
        `run. Delete it (\`git -C ${project} branch -D ${REGISTER_BRANCH}\`), then try again. Nothing was changed.`
    );
  }

  const name = request.name ?? repoNameFromOriginUrl(url);
  if (!isUsableProjectName(name)) {
    throw new RegisterError(
      "bad-name",
      `fabrica register: "${name}" cannot be a projects.toml table name - it may only hold letters, digits, ` +
        `"_" and "-". Pass one that can with --name <name>. Nothing was changed.`
    );
  }

  const already = existingRegistration(request.recordHome, name, project);
  if (already) {
    throw new RegisterError(
      "already-registered",
      already.reason === "same-name"
        ? `fabrica register: projects.toml already has [projects.${already.name}], pointing at ${already.path}. ` +
          `Fabrica never overwrites an entry. Pick another name with --name <name>, or edit that entry yourself. ` +
          `Nothing was changed.`
        : `fabrica register: projects.toml already registers ${already.path} as [projects.${already.name}], and ` +
          `that is this same repository. Registering it twice under two names would give one repository two sets ` +
          `of records. Nothing was changed.`
    );
  }

  return { project, url, name };
}

/** The shortcut case (Client ruling): origin's default branch already
 * carries .inspector.json, so the repository side is done and only
 * projects.toml is missing. --check and --image are not required here,
 * and the recorded check is `./check.sh` - or a refusal saying the repo
 * has .inspector.json but no check.sh, since without one there is no
 * command for a worker's own box to fall back to. */
function registerExisting(
  request: RegisterRequest,
  ctx: { project: string; name: string },
  defaultBranch: string
): RegisterResult {
  if (!fileExistsOnRef(ctx.project, `origin/${defaultBranch}`, CHECK_SCRIPT)) {
    throw new RegisterError(
      "no-check-script",
      `fabrica register: ${ctx.project} already has ${INSPECTOR_CONFIG} on origin/${defaultBranch}, but no ` +
        `${CHECK_SCRIPT} next to it - so there is no one command Fabrica can name as this project's check. Add ` +
        `an executable ${CHECK_SCRIPT} at the repository root and merge it, then try again. Nothing was changed.`
    );
  }

  const { tomlPath, appended } = appendProjectEntry({
    recordHome: request.recordHome,
    name: ctx.name,
    path: ctx.project,
    check: RECORDED_CHECK,
  });

  return {
    kind: "registry-only",
    name: ctx.name,
    path: ctx.project,
    check: RECORDED_CHECK,
    defaultBranch,
    tomlPath,
    tomlEntry: appended,
  };
}

/** Returns the registration, or throws a RegisterError whose message is
 * ready to show the Client verbatim. Never leaves a temporary worktree
 * behind, on any path. */
export async function registerProject(
  request: RegisterRequest,
  opts: RegisterOptions = {}
): Promise<RegisterResult> {
  const tools = opts.tools ?? realRegisterTools;
  const notify = opts.notify ?? (() => {});

  const { project, name } = prepare(request, tools);

  notify(`Reading origin's default branch for ${project}...`);
  let defaultBranch: string;
  try {
    defaultBranch = fetchOriginDefaultBranch(project);
  } catch (err) {
    throw new RegisterError(
      "origin-unreadable",
      `fabrica register: ${err instanceof Error ? err.message : String(err)} Nothing was changed.`
    );
  }

  if (fileExistsOnRef(project, `origin/${defaultBranch}`, INSPECTOR_CONFIG)) {
    notify(`origin/${defaultBranch} already has ${INSPECTOR_CONFIG} - registering ${name} only.`);
    return registerExisting(request, { project, name }, defaultBranch);
  }

  // Past this point the full setup is what's happening, so the two
  // flags it cannot be done without are required - checked here rather
  // than at parse time, because the shortcut case above genuinely
  // doesn't need them.
  //
  // Without them, this is where the proposal lands (issue #114): the
  // Client has a repository that needs setting up and has not said what
  // to set it up with, so Fabrica derives an .inspector.json from what
  // the repository itself says, prints it, and stops - having created
  // nothing. Deliberately *after* prepare()'s whole refusal cascade, so
  // a project already registered, badly named, or sitting on an
  // unreadable origin still gets its own words rather than a config
  // proposal it cannot use.
  const missing =
    request.check === undefined ||
    request.check.trim().length === 0 ||
    request.image === undefined ||
    request.image.trim().length === 0;
  if (missing) {
    throw new RegisterProposalError(
      proposeInspectorConfig(readProposalSignals(project, `origin/${defaultBranch}`), {
        projectPath: project,
        defaultBranch,
      })
    );
  }
  const check = request.check!;
  const image = request.image!;

  const parentDir = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-register-"));
  const worktree = join(parentDir, "worktree");
  let pushed = false;

  try {
    // Never the Client's own checkout: `git worktree add` only reads it
    // and records a second, separate working tree in the project's git
    // metadata - the same mechanism, and the same --no-track reasoning,
    // as src/line/cut.ts's ProductionLine.
    notify(`Creating a temporary worktree of origin/${defaultBranch} on ${REGISTER_BRANCH}...`);
    try {
      git(project, [
        "worktree",
        "add",
        "--no-track",
        "-b",
        REGISTER_BRANCH,
        worktree,
        `origin/${defaultBranch}`,
      ]);
    } catch (err) {
      throw new RegisterError(
        "worktree-failed",
        `fabrica register: could not create a temporary worktree of origin/${defaultBranch} for ${project}: ` +
          `${gitFailure(err)}. Your own checkout was not touched. Nothing was changed.`
      );
    }

    const protectedPaths = protectedPathsFor(request.protectedPaths ?? []);
    writeFileSync(
      join(worktree, INSPECTOR_CONFIG),
      inspectorConfigJson({
        protectedPaths,
        ...(request.timeoutSeconds !== undefined ? { timeoutSeconds: request.timeoutSeconds } : {}),
      })
    );

    // The shape is a fact about the repository (which lockfile it
    // carries), not about the Dockerfile, so it is read either way: it
    // decides both the install step a written Dockerfile gets and
    // whether check.sh links in what an image baked.
    const shape = dependencyShapeInTree(worktree);

    writeFileSync(join(worktree, CHECK_SCRIPT), checkScript(check, shape));
    chmodSync(join(worktree, CHECK_SCRIPT), 0o755);

    // Never over a committed one (Client ruling, issue #303's
    // clarification 2): `register` writes the files a repository is
    // missing, and overwriting a Dockerfile its owner wrote - possibly
    // the one his check box already builds from - is not a thing a
    // setup command gets to do quietly.
    const dockerfile: DockerfileOutcome = existsSync(join(worktree, DOCKERFILE_INSPECTOR))
      ? "already-committed"
      : "written";
    if (dockerfile === "written") {
      writeFileSync(
        join(worktree, DOCKERFILE_INSPECTOR),
        inspectorDockerfile({
          from: image,
          reason: `the image \`fabrica register --image ${image}\` was given, and ${RECORDED_CHECK} was run ` +
            `inside it once before this was committed`,
          shape,
        })
      );
    } else {
      notify(`${DOCKERFILE_INSPECTOR} is already committed here - leaving it exactly as it is.`);
    }
    const warnings = registerWarnings(check, dockerfile === "written" ? shape : null);

    // Inside the image, the way a worker's check runs - never on this
    // machine (issue #64's ruling). A check that cannot be run at all is
    // not the same as one that failed, and neither one is registered.
    notify(`Running ${RECORDED_CHECK} inside ${image}...`);
    const result = await tools.runCheck({ workdir: worktree, image, command: RECORDED_CHECK });
    if (!result.ran) {
      throw new RegisterError(
        "check-not-run",
        `fabrica register: ${RECORDED_CHECK} could not be run at all, so nothing is proven about it: ` +
          `${result.reason}. Nothing was pushed, no pull request was opened, and nothing was registered.`
      );
    }
    if (result.exitCode !== 0) {
      throw new RegisterError(
        "check-failed",
        `fabrica register: ${RECORDED_CHECK} failed inside ${image} (exit ${result.exitCode}), so it is not yet ` +
          `a check Fabrica can hold work to. Nothing was pushed, no pull request was opened, and nothing was ` +
          `registered. Its output:\n\n${result.output}`
      );
    }

    notify(`${RECORDED_CHECK} passed. Committing and pushing ${REGISTER_BRANCH}...`);
    const written = [INSPECTOR_CONFIG, CHECK_SCRIPT, ...(dockerfile === "written" ? [DOCKERFILE_INSPECTOR] : [])];
    try {
      git(worktree, ["add", "--", ...written]);
      git(worktree, ["commit", "-m", commitMessageFor(name, check, dockerfile)]);
    } catch (err) {
      throw new RegisterError(
        "commit-failed",
        `fabrica register: could not commit ${written.join(", ")}: ${gitFailure(err)}. ` +
          `Nothing was pushed, no pull request was opened, and nothing was registered.`
      );
    }

    // The only push anywhere in Fabrica, and it is as narrow as a push
    // gets: one new branch, by name, never --force, as the Client.
    try {
      git(worktree, ["push", "origin", REGISTER_BRANCH]);
      pushed = true;
    } catch (err) {
      throw new RegisterError(
        "push-failed",
        `fabrica register: could not push ${REGISTER_BRANCH} to origin: ${gitFailure(err)}. No pull request was ` +
          `opened and nothing was registered.`
      );
    }

    notify(`Opening a pull request into ${defaultBranch}...`);
    const pr = tools.openPullRequest({
      worktree,
      base: defaultBranch,
      head: REGISTER_BRANCH,
      title: `Set ${name} up for Fabrica`,
      body: pullRequestBodyFor(name, check, image, {
        ...(request.timeoutSeconds !== undefined ? { timeoutSeconds: request.timeoutSeconds } : {}),
        dockerfile,
        shape,
        warnings,
      }),
    });
    if (pr.url === null) {
      throw new RegisterError(
        "pull-request-failed",
        `fabrica register: ${REGISTER_BRANCH} is pushed to origin, but \`gh pr create\` opened no pull ` +
          `request: ${pr.message}. Nothing was registered. Open it yourself from ${REGISTER_BRANCH}, or delete ` +
          `that branch on origin and run this again.`
      );
    }

    const { tomlPath, appended } = appendProjectEntry({
      recordHome: request.recordHome,
      name,
      path: project,
      check: RECORDED_CHECK,
    });

    return {
      kind: "full",
      name,
      path: project,
      check: RECORDED_CHECK,
      defaultBranch,
      tomlPath,
      tomlEntry: appended,
      branch: REGISTER_BRANCH,
      pullRequestUrl: pr.url,
      checkOutput: result.output,
      dockerfile,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } finally {
    teardown(project, parentDir, { deleteBranch: !pushed });
  }
}
