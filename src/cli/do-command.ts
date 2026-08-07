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
import { waitForAskOutcome } from "./wait-for-ask-outcome.ts";

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

Runs a task against a project. If the task is materially ambiguous, the
worker's first pass produces numbered questions instead of doing any
work - they print here and the command stops; answer with
\`fabrica answer <id> "<text>"\` to resume it. Otherwise runs detached:
prints the task id and returns immediately while the work continues in
the background. The transcript streams live to the task's record as it
runs.

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
  /** Test-only: how long to wait for the task to reach "asking" or
   * "work-started" before giving up and printing just the id, and how
   * often to poll while waiting. See wait-for-ask-outcome.ts. */
  askTimeoutMs?: number;
  askPollMs?: number;
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

    // SPEC.md step 2 (issue #8): the task's own first pass, running
    // inside the detached process, decides ask-or-proceed before any
    // ProductionLine is cut. This waits (bounded) to find out which, so
    // an ambiguous task's questions print here and the command stops,
    // rather than only ever printing the id and leaving the Client to
    // discover the stop some other way.
    const outcome = await waitForAskOutcome(recordHome, taskId, {
      timeoutMs: opts.askTimeoutMs,
      pollMs: opts.askPollMs,
    });

    if (outcome.status === "asking") {
      stdout(taskId);
      stdout("");
      stdout("This task is materially ambiguous - answer before any work starts:");
      outcome.questions.forEach((question, i) => stdout(`  ${i + 1}. ${question}`));
      stdout("");
      stdout(`  fabrica answer ${taskId} "<text>"`);
      return 0;
    }

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
