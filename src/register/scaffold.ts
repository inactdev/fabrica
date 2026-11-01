// The three files `fabrica register` writes into the temporary worktree.
//
// `.inspector.json`'s schema is taken from this repository's own working
// copy of it - never from a key nothing has been seen to accept. `check`
// is always `./check.sh`, so .inspector.json, check.sh and projects.toml
// cannot disagree about what has to pass. Since inspector#47 there is no
// `image` key and no `network` key: the check box is built from
// `Dockerfile.inspector` (see dockerfile.ts) and has no network.

import { CHECK_SCRIPT, INSPECTOR_CONFIG, RECORDED_CHECK } from "./origin.ts";
import {
  DEPS_DIR,
  DOCKERFILE_INSPECTOR,
  SERVICE_WAIT_SECONDS,
  comment,
  type DependencyShape,
} from "./dockerfile.ts";

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

/** `.inspector.json`'s contents, pretty-printed with a trailing newline -
 * a file a human reads and edits later, not a blob. Key order follows
 * this repository's own .inspector.json, the one live example of the
 * schema in reach. */
export function inspectorConfigJson(
  opts: {
    /** The command that must pass. `./check.sh` unless told otherwise -
     * which only `propose.ts` ever does, for a repository whose own
     * evidence names an indirect command (`npm test`) and that has no
     * check.sh for `register` to point at. */
    check?: string;
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
      check: opts.check ?? RECORDED_CHECK,
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
export function checkScript(command: string, shape: DependencyShape | null = null): string {
  const header =
    `#!/bin/sh\n` +
    `# The one command that must pass for work on this project to be green.\n` +
    `# Written by \`fabrica register\`. Inspector runs this file, and so does\n` +
    `# a worker's own box when no Inspector is installed - edit it here, in\n` +
    `# the repository, rather than anywhere in Fabrica.\n` +
    `set -e\n`;

  const preamble =
    shape === null ? `` : `${linkPreamble(shape)}${servicePreamble(shape)}${preparePreamble(shape)}`;
  if (preamble === ``) return `${header}${command}\n`;

  return `${header}cd "$(dirname "$0")"\n${preamble}${command}\n`;
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
    `# ${labels} run inside this same container: the check box has no\n` +
    `# network, so there is no server to reach over one. See\n` +
    `# ${DOCKERFILE_INSPECTOR} for how they got here.\n` +
    `stop_services() {\n` +
    services.map((service) => `  ${service.stop} >/dev/null 2>&1 || true\n`).join("") +
    `}\n` +
    `# However this script ends, including a failing suite below. The trap\n` +
    `# runs no exit of its own, so the suite's status is still this\n` +
    `# script's status.\n` +
    `trap stop_services EXIT\n` +
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
    `\n` +
    services
      .map((service) => `${service.start}\nwait_for ${service.label} ${service.ready.join(" ")}\n`)
      .join("") +
    `\n`
  );
}

/** The one step between the servers answering and the suite running -
 * the test database. */
function preparePreamble(shape: DependencyShape): string {
  if (shape.prepare === undefined) return ``;
  return `${comment(shape.prepare.note).join("\n")}\n${shape.prepare.run}\n`;
}
