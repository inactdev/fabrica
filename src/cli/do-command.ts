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

import { ConfigError, notSetUpMessage, originSetup, resolveReviewer } from "../index.ts";
import type { FabricaConfig } from "../index.ts";
import { CliError } from "./errors.ts";
import { loadConfigOrDefault } from "./load-config.ts";
import { DO_USAGE, parseDoArgs } from "./do-args.ts";
import { resolveProjectPath } from "./resolve-project.ts";
import { resolveRecordHome } from "./record-home.ts";
import { spawnDetachedTask } from "./spawn-detached.ts";
import { waitForAskOutcome } from "./wait-for-ask-outcome.ts";

export const DO_HELP = `Usage: ${DO_USAGE}

Runs a task against a project. If the task is materially ambiguous, the
worker's first pass produces numbered questions instead of doing any
work - they print here and the command stops; answer with
\`fabrica answer <id> -m "<text>"\` to resume it. That case still exits 0.
If the task fails before any work starts - its first pass throws, a
spending cap refuses it, or anything else stops it - the real reason
prints here and the command exits non-zero. There is no time limit on
that first pass; a "still waiting" line prints every 15 seconds. Otherwise runs
detached: prints the task id and returns immediately while the work
continues in the background. The transcript streams live to the task's
record as it runs.

  <task text>              What to do, in plain words. Quote it.
  --project <path-or-name> A project's own path, or a name already
                            registered in projects.toml. A project whose
                            base commit has no .inspector.json is refused
                            here, before anything is registered - set it
                            up first with \`fabrica register\`.
  --issue <N>              This task is the whole of GitHub issue N's
                            work. The issue's title and body are read
                            from GitHub before anything starts and go
                            into every round's brief, in full, so the
                            task need not repeat them; the opened pull
                            request's body also closes the issue. Only
                            for a task that IS the issue, not part of
                            it; omit otherwise. The same closing applies
                            automatically when <task text> itself starts
                            with "Issue #N:", but only --issue fetches
                            the issue. An issue in another repository is
                            named as owner/repo#N, or by pasting its
                            URL. If it cannot be read, nothing starts
                            and the cause prints here.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

/**
 * Refuses, before the task is registered, a project that cannot have
 * its work properly judged - on either of two grounds, both read from
 * the same single look at origin.
 *
 * First: a base commit carrying no `.inspector.json` at all. There is
 * nothing there saying how the work should be checked, so there is no
 * verified work to be had, and a task that cannot be verified should
 * cost nothing at all.
 *
 * Second: a base commit whose `.inspector.json` declares `testPaths` -
 * asking for its test changes to be judged by a model - while no
 * reviewer is configured, or one is configured that cannot work (no
 * key, or the worker's own vendor). Refused here, up front, for exactly
 * the reason the first case is: a task nothing can properly judge
 * should never reach a worker or spend a cent.
 *
 * "Base commit" means origin's default branch, which is where a task's
 * branch is actually cut from (src/line/cut.ts) - never the Client's
 * local checkout. `originSetup` answering `null` means it could not
 * find out (no origin, origin unreachable): deliberately not treated as
 * "not set up", since telling someone whose network is down to run
 * `fabrica register` would be both wrong and less use than the real git
 * error the task itself then reports. Neither is a missing reviewer
 * then assumed - with no answer about `testPaths`, there is no basis to
 * demand one.
 */
function refusalForUnsetUpProject(
  projectPath: string,
  recordHome: string,
  config: FabricaConfig,
  projectArg: string
): string | null {
  const setup = originSetup(projectPath);
  if (setup === null) return null;
  if (!setup.inspectorConfigured) return `fabrica do: ${notSetUpMessage(projectPath)}`;

  const reviewer = resolveReviewer({
    recordHome,
    config,
    projectPath,
    // The Client's own word for this project when he gave one, so the
    // message names what he typed rather than a path he did not.
    projectLabel: Object.hasOwn(config.projects, projectArg) ? projectArg : projectPath,
    declaresTestPaths: setup.declaresTestPaths,
    env: process.env,
  });
  return reviewer.kind === "refused" ? `fabrica do: ${reviewer.message}` : null;
}

export interface RunDoCommandOptions {
  recordHome?: string;
  /** Test-only: forwarded to spawnDetachedTask so a test can run the
   * real spawn-and-discover mechanism against a fake brain. */
  entryScript?: string;
  timeoutMs?: number;
  /** Test-only: how often to poll the record while waiting for the task
   * to ask, fail, or reach "work-started". See wait-for-ask-outcome.ts. */
  askPollMs?: number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Test-only seam for the "can this project's work be properly
   * judged" question, which otherwise fetches origin. */
  setUpRefusal?: (
    projectPath: string,
    recordHome: string,
    config: FabricaConfig,
    projectArg: string
  ) => string | null;
}

/** Returns the process exit code - never throws. */
export async function runDoCommand(argv: string[], opts: RunDoCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  try {
    const { taskText, projectArg, issue } = parseDoArgs(argv);
    const recordHome = opts.recordHome ?? resolveRecordHome();
    const config = loadConfigOrDefault(recordHome);
    const projectPath = resolveProjectPath(config, projectArg);

    // Before registering anything: a project with no .inspector.json at
    // its base commit cannot have its work independently checked, and
    // one that asks for its test changes to be judged without a usable
    // reviewer cannot either - so there is no task worth starting on it
    // yet. Refusing here - rather than letting the detached task reach a
    // worker first - is what makes this cost nothing, and what lets the
    // message name exactly what to add.
    const notSetUp = (opts.setUpRefusal ?? refusalForUnsetUpProject)(projectPath, recordHome, config, projectArg);
    if (notSetUp !== null) {
      stderr(notSetUp);
      return 1;
    }

    const { taskId, isRunning } = await spawnDetachedTask({
      recordHome,
      projectPath,
      taskText,
      issue,
      entryScript: opts.entryScript,
      timeoutMs: opts.timeoutMs,
    });

    // SPEC.md step 2 (issue #8): the task's own first pass, running
    // inside the detached process, decides ask-or-proceed before any
    // ProductionLine is cut. This waits - with no fixed cutoff, saying
    // so every 15s (#73) - to find out which, so an ambiguous task's
    // questions print here and the command stops, and a failed start
    // prints its reason, rather than only ever printing the id.
    const outcome = await waitForAskOutcome(recordHome, taskId, {
      pollMs: opts.askPollMs,
      onStillWaiting: stderr,
      isAlive: isRunning,
    });

    // stdout stays exactly the task id, one line, nothing else, in every
    // case - that contract is what makes `id=$(fabrica do "..." --project
    // foo) || exit 1` (src/cli/README.md) safe to script against. The
    // task was genuinely registered even when it goes on to fail, so the
    // id is still worth printing (the record under it is real and worth
    // inspecting) - only the exit code and the human explanation change.
    stdout(taskId);

    if (outcome.status === "asking") {
      // Guidance for the Client's screen, not data a script should ever
      // have to parse, so it goes to stderr - Client ruling (issue #8
      // follow-up): no separate exit code for this case either, since
      // restoring the documented stdout contract already fixes every
      // script this could have broken. The questions themselves are
      // never only on the terminal: they are already on the record, in
      // the "questions-asked" event's own details, recoverable long
      // after this output has scrolled away - this is a convenience
      // view of that, not the source.
      stderr("");
      stderr("This task is materially ambiguous - answer before any work starts:");
      outcome.questions.forEach((question, i) => stderr(`  ${i + 1}. ${question}`));
      stderr("");
      stderr(`  fabrica answer ${taskId} -m "<text>"`);
      return 0;
    }

    if (outcome.status === "failed") {
      // A failed task must never look like a started one (Client ruling,
      // issue #8 follow-up): a non-zero exit here is what makes
      // `id=$(fabrica do "..." --project foo) || exit 1` actually catch
      // it, instead of a script reading a success code off a task that
      // never got past its own first step.
      stderr(`fabrica do: the task failed before any work started: ${outcome.reason}`);
      return 1;
    }

    if (outcome.status === "cap-refused") {
      // Rule 10 (issue #11, Client ruling 2026-10-08): a refusal by a cap -
      // including SPEND UNKNOWN, which names each unmeasured task - is a
      // non-zero exit, never a warning a script reads past.
      stderr(`fabrica do: refused before any work started. ${outcome.reason}`);
      return 1;
    }

    return 0;
  } catch (err) {
    if (err instanceof CliError || err instanceof ConfigError) {
      stderr(err.message);
      return 1;
    }
    throw err;
  }
}
