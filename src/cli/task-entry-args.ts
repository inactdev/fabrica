// The argv contract between spawn-detached.ts and the detached task
// runner it spawns (run-task-entry.ts, and the fake standing in for it
// in tests).
//
// Three positionals - recordHome, projectPath, taskText - then named
// flags for everything optional. `--issue` used to ride as a trailing
// fourth positional, which worked only while it was the single optional
// value: a second one (issue #184's `--model`) would have had to carry a
// placeholder for an absent issue, in argv, between two processes, with
// nothing checking the order. Named flags cost one small parser and
// cannot be shifted out of alignment.
//
// Nothing here is Client-facing: `fabrica do`'s own arguments are
// do-args.ts's business, and a wrong shape here is a Fabrica bug, not a
// usage error - hence plain Errors rather than CliError.

export interface TaskEntryArgs {
  recordHome: string;
  projectPath: string;
  taskText: string;
  /** `fabrica do --issue <N>` - the value as the Client spelled it, one
   * of the three forms do-args.ts has already proved legal (a plain
   * number, `owner/repo#N`, or a pasted issue URL). Carried on as the
   * text it arrived as rather than re-derived into a number here:
   * registration parses it in exactly one place
   * (src/foreman/task-issue.ts). */
  issue?: string;
  /** `fabrica do --model <name>` (issue #184) - the model this task
   * asks for, which the entry also builds its brain with. */
  model?: string;
}

/** Parses `process.argv` as handed to a detached task runner (so the
 * first two entries are the node binary and this script). */
export function parseTaskEntryArgs(argv: string[]): TaskEntryArgs {
  const [recordHome, projectPath, taskText, ...rest] = argv.slice(2);
  if (recordHome === undefined || projectPath === undefined || taskText === undefined) {
    throw new Error(
      `expected <recordHome> <projectPath> <taskText> [--issue <issue>] [--model <name>], got ` +
        `${argv.length - 2} argument(s).`
    );
  }

  let issue: string | undefined;
  let model: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[++i];
    if (value === undefined) throw new Error(`"${flag}" was given no value.`);
    if (flag === "--issue") {
      issue = value.trim();
      if (issue.length === 0) throw new Error(`"${flag}" was given no value.`);
    } else if (flag === "--model") {
      model = value;
    } else {
      throw new Error(`unknown argument "${flag}".`);
    }
  }

  return {
    recordHome,
    projectPath,
    taskText,
    ...(issue !== undefined ? { issue } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

/** The flags `spawnDetachedTask` appends after the three positionals -
 * the one place their spelling is decided, so the spawner and the parser
 * above cannot drift apart. */
export function taskEntryFlags(opts: { issue?: number | string; model?: string }): string[] {
  return [
    ...(opts.issue !== undefined ? ["--issue", String(opts.issue)] : []),
    ...(opts.model !== undefined ? ["--model", opts.model] : []),
  ];
}
