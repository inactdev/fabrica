// `fabrica do` end to end: read config for the record home and caps,
// resolve the project, spawn the detached loop (which selects the
// adapter and calls do() - see run-task-entry.ts), print the task id.
//
// Everything synchronous and cheap - argument parsing, config, project
// resolution - happens right here, so a wrong invocation refuses with
// an exact-instructions message and a non-zero exit before any
// background process ever starts. Once the task is actually registered,
// this prints just its id on its own line and returns - the rest of the
// work (CONTRACT rule 2's check, the delivery) happens after this
// process has already exited, which is the whole point of detachment
// (see the module README's "Why detached execution" section).

import { ConfigError, loadConfig } from "../index.ts";
import type { FabricaConfig } from "../index.ts";
import { CliError } from "./errors.ts";
import { DO_USAGE, parseDoArgs } from "./do-args.ts";
import { resolveProjectPath } from "./resolve-project.ts";
import { resolveRecordHome } from "./record-home.ts";
import { spawnDetachedTask } from "./spawn-detached.ts";

/** A record home with no projects.toml yet has no registered projects
 * and no caps - not an error. do()'s own resolveCheckCommand treats a
 * missing file the same way (falls back to the check.sh convention);
 * this mirrors that instead of refusing a first `fabrica do` ever run
 * against a plain `--project <path>` before any project is registered. */
function loadConfigOrDefault(recordHome: string): FabricaConfig {
  try {
    return loadConfig(recordHome);
  } catch (err) {
    if (err instanceof ConfigError && err.code === "not-found") return { caps: {}, projects: {} };
    throw err;
  }
}

export const DO_HELP = `Usage: ${DO_USAGE}

Runs a task against a project, detached: prints the task id and returns
immediately while the work continues in the background. The transcript
streams live to the task's record as it runs.

  <task text>              What to do, in plain words. Quote it.
  --project <path-or-name> A project's own path, or a name already
                            registered in projects.toml.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

export interface RunDoCommandOptions {
  recordHome?: string;
  /** Test-only: forwarded to spawnDetachedTask so a test can run the
   * real spawn-and-discover mechanism against a fake brain. */
  entryScript?: string;
  timeoutMs?: number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Returns the process exit code - never throws. */
export async function runDoCommand(argv: string[], opts: RunDoCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  try {
    const { taskText, projectArg } = parseDoArgs(argv);
    const recordHome = opts.recordHome ?? resolveRecordHome();
    const config = loadConfigOrDefault(recordHome);
    const projectPath = resolveProjectPath(config, projectArg);

    const { taskId } = await spawnDetachedTask({
      recordHome,
      projectPath,
      taskText,
      entryScript: opts.entryScript,
      timeoutMs: opts.timeoutMs,
    });

    stdout(taskId);
    return 0;
  } catch (err) {
    if (err instanceof CliError || err instanceof ConfigError) {
      stderr(err.message);
      return 1;
    }
    throw err;
  }
}
