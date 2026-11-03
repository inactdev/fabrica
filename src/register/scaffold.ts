// The three files `fabrica register` writes into the temporary worktree.
//
// `.inspector.json`'s schema is taken from this repository's own working
// copy of it - never from a key nothing has been seen to accept. `check`
// is always `./check.sh`, so .inspector.json, check.sh and projects.toml
// cannot disagree about what has to pass. Since inspector#47 there is no
// `image` key and no `network` key: the check box is built from
// `Dockerfile.inspector` (see dockerfile.ts) and has no network.

import {
  CHECK_SCRIPT,
  INSPECTOR_CONFIG,
  RECORDED_CHECK,
  TERMS_MOUNT,
  TERMS_RECORDED_CHECK,
} from "./origin.ts";
import {
  DEPS_DIR,
  DOCKERFILE_INSPECTOR,
  GROUP_FILE,
  PASSWD_FILE,
  SCRATCH_DIR_VAR,
  SERVICE_WAIT_SECONDS,
  USER_ENTRY_NAME,
  comment,
  needsScratchDir,
  type BoxService,
  type DependencyShape,
} from "./dockerfile.ts";

/**
 * Where this project's terms live, which decides two things about the
 * files written for it: what `.inspector.json` may name as the check,
 * and whether `check.sh` may `cd` to its own folder.
 *
 * `"repository"` - committed at the repository root, so `./check.sh` is
 * the script and the script's own folder *is* the repository.
 *
 * `"folder"` - a folder outside the repository that Inspector mounts at
 * `/terms` (work mode, issue #316). The check is `sh /terms/check.sh`,
 * and `/terms` is emphatically not the repository: Inspector runs the
 * check with the repository at `/workspace`, as its working directory,
 * which is where the suite has to run from.
 */
export type TermsLocation = "repository" | "folder";

/**
 * The paths a Worker may never quietly change. `check.sh`,
 * `.inspector.json` and `Dockerfile.inspector` are always in the list -
 * the gate, the gate's own definition, and the box the gate runs in; a
 * setup that protected the check but not the files deciding what it is
 * and where it runs would protect nothing (CONTRACT rule 9's whole
 * subject). `--protected` adds to those three rather than replacing
 * them.
 */
export function protectedPathsFor(extra: readonly string[]): string[] {
  const paths = [CHECK_SCRIPT, INSPECTOR_CONFIG, DOCKERFILE_INSPECTOR];
  for (const glob of extra) {
    if (!paths.includes(glob)) paths.push(glob);
  }
  return paths;
}

/**
 * The check command `.inspector.json` names for terms in that place.
 *
 * The two are not interchangeable, and getting it wrong is silent until
 * a real Inspector run (issue #337's first finding): `./check.sh`
 * resolves against the check's working directory, which is the
 * repository at `/workspace`, so from a terms folder it names
 * `/workspace/check.sh` - a file a work-mode repository does not have
 * and may never be given.
 */
export function checkCommandFor(terms: TermsLocation): string {
  return terms === "folder" ? TERMS_RECORDED_CHECK : RECORDED_CHECK;
}

/** `.inspector.json`'s contents, pretty-printed with a trailing newline -
 * a file a human reads and edits later, not a blob. Key order follows
 * this repository's own .inspector.json, the one live example of the
 * schema in reach. */
export function inspectorConfigJson(
  opts: {
    /** The command that must pass. Defaults to whatever `terms` means:
     * `./check.sh` in the repository, `sh /terms/check.sh` from a terms
     * folder. Passing it explicitly is only `propose.ts`, for a
     * repository whose own evidence names an indirect command (`npm
     * test`) and that has no check.sh for `register` to point at. */
    check?: string;
    /** Where this project's terms live, which decides the default
     * `check` - see `TermsLocation`. Defaults to the repository. */
    terms?: TermsLocation;
    /** Omitted from the document entirely when `undefined` - which is
     * not the same as an empty list: `[]` is "nothing is protected",
     * stated, and is what `register` writes when `protectedPathsFor`
     * somehow produces nothing. `propose.ts` passes `undefined` for a
     * check the Client has to pick the protected paths for himself. */
    protectedPaths?: readonly string[];
    /** `--timeout <seconds>`: writes `timeoutSeconds`. */
    timeoutSeconds?: number;
  } = {}
): string {
  return `${JSON.stringify(
    {
      check: opts.check ?? checkCommandFor(opts.terms ?? "repository"),
      // Written only when asked for. "Off" is the absence of the key,
      // never `timeoutSeconds: 0`: no live config shows that spelling,
      // and a value nothing has been seen to accept is not one to write
      // on a guess (the same rule that keeps this file to keys this
      // repository's own config uses).
      ...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}),
      ...(opts.protectedPaths !== undefined ? { protectedPaths: [...opts.protectedPaths] } : {}),
    },
    null,
    2
  )}\n`;
}

/**
 * `check.sh`'s contents: the Client's own command, verbatim, under a
 * `set -e` so a multi-command check fails on the first failure instead
 * of reporting the last one's status. The header says where the file came
 * from, because the next person to read it will not have been here.
 *
 * A project whose dependencies the check image bakes in (`shape`, see
 * dockerfile.ts) gets the other half of that mechanism here: the check
 * box has no network, and a `node_modules` nothing links in is a
 * `node_modules` that is never there. The preamble is this repository's
 * own check.sh, the reference shape - it links what the image installed
 * when it finds it, and installs for real when run anywhere else (a
 * laptop, a worker's own box, `register`'s own proving run).
 *
 * A shape with servers of its own (issue #324's Ruby shape, when the
 * lockfile names `pg` or `redis`) gets the rest of the preamble: each is
 * started here, waited for until it answers, and stopped again however
 * this script ends - for the same reason the dependencies are baked in,
 * that the box has no network to reach anything over. The command the
 * Client named still goes in verbatim, as the last line.
 */
export function checkScript(
  command: string,
  shape: DependencyShape | null = null,
  terms: TermsLocation = "repository"
): string {
  const header =
    `#!/bin/sh\n` +
    `# The one command that must pass for work on this project to be green.\n` +
    `# Written by \`fabrica register\`. Inspector runs this file, and so does\n` +
    `# a worker's own box when no Inspector is installed - edit it here,\n` +
    (terms === "folder"
      ? `# in this project's own terms folder, rather than anywhere in Fabrica.\n`
      : `# in the repository, rather than anywhere in Fabrica.\n`) +
    `set -e\n`;

  const preamble =
    shape === null
      ? ``
      : `${linkPreamble(shape)}${scratchPreamble(shape)}${userEntryPreamble(shape)}` +
        `${servicePreamble(shape)}${runtimeEnvPreamble(shape)}${preparePreamble(shape)}`;
  if (preamble === ``) return `${header}${command}\n`;

  return `${header}${workingDirectory(terms)}${preamble}${command}\n`;
}

/**
 * Getting this script into the repository, which is where every command
 * below it runs.
 *
 * In the repository that is `cd "$(dirname "$0")"`: the script's own
 * folder is the repository root, and a `cd` there makes the check
 * independent of where it was invoked from.
 *
 * From a terms folder it is nothing at all, and that is issue #337's
 * second finding: `$0` is `/terms/check.sh` there, so the same `cd`
 * lands in the mounted terms folder, where there is no checkout, no
 * `Gemfile` and no suite. Inspector already runs the check from
 * `/workspace` - so what this needs is not a different `cd` but none,
 * plus the sentence saying so.
 */
function workingDirectory(terms: TermsLocation): string {
  if (terms === "repository") return `cd "$(dirname "$0")"\n`;
  return (
    `# There is deliberately no \`cd "$(dirname "$0")"\` here. This file\n` +
    `# lives in this project's terms folder, which Inspector mounts at\n` +
    `# ${TERMS_MOUNT} - not in the repository. Inspector runs the check with the\n` +
    `# repository at /workspace and that as the working directory, which is\n` +
    `# where everything below belongs; a cd to this file's own folder would\n` +
    `# land outside the checkout. Run it from the repository root anywhere\n` +
    `# else.\n`
  );
}

/**
 * The scratch directory everything this check writes goes in, removed
 * again however the script ends (issue #337).
 *
 * It exists because the checkout is not writable: Inspector mounts every
 * top-level path the repository tracks read-only, and a read-only mount
 * covers its whole subtree - so even creating a new file in a tracked
 * directory fails. A Rails application writing `log/test.log` is the
 * case that found this.
 *
 * The cleanup is an `EXIT` trap that runs no `exit` of its own, so the
 * suite's own status is still this script's status, and the servers
 * below hang their own stop lines on the same trap rather than
 * installing a second one.
 *
 * It also reads the exiting status as its first act, for one reason:
 * every server below logs into this directory, so removing it on a
 * *failing* exit would destroy the only explanation of why the check
 * failed. A cluster that would not initialize, or a server that never
 * answered, has to say so in the check's own output - see
 * `serviceLogDump`.
 */
function scratchPreamble(shape: DependencyShape): string {
  if (!needsScratchDir(shape)) return ``;
  const services = shape.services ?? [];
  return (
    `\n` +
    comment(
      `Everything this check writes goes in here, and it is removed again on the way out. Nothing may write ` +
        `inside the checkout: Inspector mounts every top-level path this repository tracks read-only, and that ` +
        `covers whole directories - log/ and tmp/ included.`
    ).join("\n") +
    `\n` +
    `${SCRATCH_DIR_VAR}=$(mktemp -d "\${TMPDIR:-/tmp}/fabrica-check-XXXXXX")\n` +
    comment(
      `Traversable by anyone, because a server started below may drop to a system user of its own (see ` +
        `PostgreSQL). It holds no secrets - a throwaway database and a log.`
    ).join("\n") +
    `\n` +
    `chmod 755 "$${SCRATCH_DIR_VAR}"\n` +
    `\n` +
    comment(
      `However this script ends, including a failing suite below. The trap runs no exit of its own, so the ` +
        `suite's status is still this script's status.`
    ).join("\n") +
    `\n` +
    `fabrica_cleanup() {\n` +
    `  fabrica_status=$?\n` +
    serviceLogDump(services) +
    services.flatMap((service) => service.stop).map((line) => `  ${line}\n`).join("") +
    `  rm -rf "$${SCRATCH_DIR_VAR}"\n` +
    `}\n` +
    `trap fabrica_cleanup EXIT\n`
  );
}

/**
 * What the servers wrote about themselves, on a failing exit only.
 *
 * Every server above keeps its log in the scratch directory, because the
 * checkout is read-only - and the `rm -rf` that directory needs would
 * otherwise take the log with it. A check that went red because
 * PostgreSQL would not initialize, or because it never answered inside
 * the wait, would then report sixty seconds of nothing and no reason.
 *
 * On a green exit they are not printed at all: a passing check's output
 * is read by people, and a server's startup chatter is noise there.
 *
 * Nothing in here can fail the cleanup under the script's own `set -e`:
 * a glob that matches nothing stays literal and is skipped by the `-f`
 * test, and the `cat` carries its own `|| true`.
 */
function serviceLogDump(services: readonly BoxService[]): string {
  if (services.length === 0) return ``;
  return (
    comment(
      `Only on the way out of a failing check: every server above logs in there, and the rm below would take ` +
        `the one explanation of what went wrong with it. On a green check they are not printed at all.`
    )
      .map((line) => `  ${line}\n`)
      .join("") +
    `  if [ "$fabrica_status" -ne 0 ]; then\n` +
    `    for fabrica_log in "$${SCRATCH_DIR_VAR}"/*/*.log; do\n` +
    `      [ -f "$fabrica_log" ] || continue\n` +
    `      echo "${CHECK_SCRIPT}: $fabrica_log, after a failing check:" >&2\n` +
    `      cat "$fabrica_log" >&2 || true\n` +
    `    done\n` +
    `  fi\n`
  );
}

/**
 * An `/etc/passwd` entry for the uid this check is running as, when it
 * has none (issue #337).
 *
 * Inspector runs the check as `docker run --user <host uid>:<host gid>`,
 * and that uid is nobody in the image: nothing in `/etc/passwd`
 * mentions it. Most things do not care. PostgreSQL's `initdb` resolves
 * its own effective uid to a user *name* before it does anything at all
 * - `get_user_name_or_exit`, which is `getpwuid` - and there is no flag
 * that skips it, so with no entry it stops dead on "could not look up
 * effective user ID". `--username` names the role it creates, which is
 * a different thing entirely.
 *
 * So the entry is written here, by the uid that needs it, which is the
 * only place it can be written: at build time that uid is unknowable.
 * `Dockerfile.inspector` leaves the two files writable for exactly this
 * (`userEntryLines` in dockerfile.ts), and if it has not, this refuses
 * with a line naming that - a missing entry otherwise surfaces as an
 * error from whichever server happened to look first.
 *
 * It is written once, for any service that needs it, rather than inside
 * PostgreSQL's own lines: the box's uid is a property of the box, and
 * anything else in there that looks a user up now finds one.
 *
 * Two shell details that are not incidental. The group entry is added
 * only when the gid has none of its own, because a gid that already
 * resolves needs nothing and a duplicate name in `/etc/group` would be
 * a worse file than the one it replaced. And `getent` deciding this,
 * rather than a `grep` of the file, is what makes a box whose users
 * come from somewhere other than the file (an `nsswitch.conf` with
 * anything else in it) answer for itself instead of being read wrong.
 */
function userEntryPreamble(shape: DependencyShape): string {
  const services = shape.services ?? [];
  const needing = services.filter((service) => service.needsUserEntry);
  if (needing.length === 0) return ``;

  const labels = needing.map((service) => service.label).join(" and ");
  return (
    `\n` +
    comment(
      `${labels} looks up the user it is running as, and Inspector runs this check as the uid of whoever ` +
        `invoked it - which has no ${PASSWD_FILE} entry in the check box. So it gets one here, named ` +
        `"${USER_ENTRY_NAME}", before anything starts. Nothing is logged into and no password is set: this is ` +
        `a name for getpwuid to find.`
    ).join("\n") +
    `\n` +
    `fabrica_uid=$(id -u)\n` +
    `fabrica_gid=$(id -g)\n` +
    `if ! getent passwd "$fabrica_uid" >/dev/null 2>&1; then\n` +
    `  if [ ! -w ${PASSWD_FILE} ] || [ ! -w ${GROUP_FILE} ]; then\n` +
    `    echo "${CHECK_SCRIPT}: uid $fabrica_uid has no ${PASSWD_FILE} entry and ${PASSWD_FILE} is not` +
    ` writable, so ${labels} cannot look up the user it runs as - ${DOCKERFILE_INSPECTOR} has to keep its` +
    ` 'RUN chmod a+w ${PASSWD_FILE} ${GROUP_FILE}' line" >&2\n` +
    `    exit 1\n` +
    `  fi\n` +
    `  echo "${USER_ENTRY_NAME}:x:$fabrica_uid:$fabrica_gid:${USER_ENTRY_NAME} check:/tmp:/bin/sh" >>` +
    ` ${PASSWD_FILE}\n` +
    `  # Only when the gid has no entry of its own, which it may well\n` +
    `  # have: a duplicate name in ${GROUP_FILE} would be worse than the\n` +
    `  # file it replaced.\n` +
    `  getent group "$fabrica_gid" >/dev/null 2>&1 ||` +
    ` echo "${USER_ENTRY_NAME}:x:$fabrica_gid:" >> ${GROUP_FILE}\n` +
    `fi\n`
  );
}

/** The `node_modules` half of the `/deps` mechanism - this repository's
 * own check.sh, the reference shape. */
function linkPreamble(shape: DependencyShape): string {
  if (!shape.linksNodeModules) return ``;
  return (
    `if [ ! -d node_modules ]; then\n` +
    `  if [ -d ${DEPS_DIR}/node_modules ]; then\n` +
    `    # Inside Inspector's check container (see ${DOCKERFILE_INSPECTOR}):\n` +
    `    # no network, and the dependencies were installed when the image\n` +
    `    # was built.\n` +
    `    ln -s ${DEPS_DIR}/node_modules node_modules\n` +
    `  else\n` +
    `    ${shape.install}\n` +
    `  fi\n` +
    `fi\n`
  );
}

/**
 * Starting, waiting for and stopping the servers the suite needs (issue
 * #324). Three properties are the whole of it:
 *
 *   - **They run here, in this container.** The check box has no
 *     network, so there is no server to reach over one.
 *   - **Each is waited for, not slept past.** A fixed sleep is either
 *     too short on a loaded machine or wasted on every run; a readiness
 *     command answering is the thing actually being waited for, and a
 *     server that never answers fails the check with a line saying
 *     which, rather than a connection error from the suite.
 *   - **They are stopped however this script ends.** The stop is an
 *     `EXIT` trap, so a failing suite stops them too. The trap runs no
 *     `exit` of its own, which is what keeps the suite's own status the
 *     script's status.
 */
function servicePreamble(shape: DependencyShape): string {
  const services = shape.services ?? [];
  if (services.length === 0) return ``;

  const labels = services.map((service) => service.label).join(" and ");
  return (
    `\n` +
    comment(
      `${labels} run inside this same container: the check box has no network, so there is no server to reach ` +
        `over one. See ${DOCKERFILE_INSPECTOR} for how they got here, and the trap above for what stops them ` +
        `again.`
    ).join("\n") +
    `\n` +
    `\n` +
    `# Waits for a server to answer rather than sleeping a fixed time: a\n` +
    `# connection can be made before the server is accepting one.\n` +
    `wait_for() {\n` +
    `  label=$1\n` +
    `  shift\n` +
    `  waited=0\n` +
    `  until "$@" >/dev/null 2>&1; do\n` +
    `    waited=$((waited + 1))\n` +
    `    if [ "$waited" -ge ${SERVICE_WAIT_SECONDS} ]; then\n` +
    `      echo "${CHECK_SCRIPT}: $label did not answer within ${SERVICE_WAIT_SECONDS} seconds" >&2\n` +
    `      exit 1\n` +
    `    fi\n` +
    `    sleep 1\n` +
    `  done\n` +
    `}\n` +
    services
      .map(
        (service) =>
          `\n${service.start.join("\n")}\nwait_for ${service.label} ${service.ready.join(" ")}\n`
      )
      .join("") +
    `\n`
  );
}

/** What the suite needs in its environment before anything runs it -
 * for a Rails application, the writable directories it would otherwise
 * look for inside the read-only checkout. Before `preparePreamble`,
 * since `bin/rails db:test:prepare` boots the application too. */
function runtimeEnvPreamble(shape: DependencyShape): string {
  if (shape.runtimeEnv === undefined) return ``;
  return `${comment(shape.runtimeEnv.note).join("\n")}\n${shape.runtimeEnv.run}\n\n`;
}

/** The one step between the servers answering and the suite running -
 * the test database. */
function preparePreamble(shape: DependencyShape): string {
  if (shape.prepare === undefined) return ``;
  return `${comment(shape.prepare.note).join("\n")}\n${shape.prepare.run}\n`;
}
