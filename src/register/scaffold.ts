// The two files `fabrica register` writes into the temporary worktree.
//
// `.inspector.json`'s schema is taken from this repository's own working
// copy of it plus contract/helpers/fixture.ts's FIXTURE_INSPECTOR_CONFIG
// (which proves the minimal `check` + `image` form is valid) - never from
// a key neither of those shows. `check` is always `./check.sh`, so
// .inspector.json, check.sh and projects.toml cannot disagree about what
// has to pass.

import { CHECK_SCRIPT, INSPECTOR_CONFIG, RECORDED_CHECK } from "./origin.ts";

/**
 * The paths a Worker may never quietly change. `check.sh` and
 * `.inspector.json` are always in the list - the gate and the gate's own
 * definition; a setup that protected the check but not the file naming it
 * would protect nothing (CONTRACT rule 9's whole subject). `--protected`
 * adds to those two rather than replacing them.
 */
export function protectedPathsFor(extra: readonly string[]): string[] {
  const paths = [CHECK_SCRIPT, INSPECTOR_CONFIG];
  for (const glob of extra) {
    if (!paths.includes(glob)) paths.push(glob);
  }
  return paths;
}

/** `.inspector.json`'s contents, pretty-printed with a trailing newline -
 * a file a human reads and edits later, not a blob. Key order follows
 * this repository's own .inspector.json, the one live example of the
 * schema in reach. */
export function inspectorConfigJson(opts: {
  image: string;
  protectedPaths: readonly string[];
  /** `--network`: writes `network: true`, so the check box can reach the
   * network - what a check that installs its own tools needs. */
  network?: boolean;
  /** `--timeout <seconds>`: writes `timeoutSeconds`. */
  timeoutSeconds?: number;
}): string {
  return `${JSON.stringify(
    {
      check: RECORDED_CHECK,
      image: opts.image,
      // Each of these is written only when asked for. "Off" is the
      // absence of the key, never `network: false` or `timeoutSeconds:
      // 0`: no live config shows either of those spellings, and a value
      // nothing has been seen to accept is not one to write on a guess
      // (the same rule that keeps this file to keys this repository's
      // own config uses).
      ...(opts.network === true ? { network: true } : {}),
      ...(opts.timeoutSeconds !== undefined ? { timeoutSeconds: opts.timeoutSeconds } : {}),
      protectedPaths: [...opts.protectedPaths],
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
 */
export function checkScript(command: string): string {
  return (
    `#!/bin/sh\n` +
    `# The one command that must pass for work on this project to be green.\n` +
    `# Written by \`fabrica register\`. Inspector runs this file, and so does\n` +
    `# a worker's own box when no Inspector is installed - edit it here, in\n` +
    `# the repository, rather than anywhere in Fabrica.\n` +
    `set -e\n` +
    `${command}\n`
  );
}
