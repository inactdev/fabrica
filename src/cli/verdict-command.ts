// `fabrica verdict` end to end: parse the ruling, hand it to the Foreman,
// and report plainly what happened - CONTRACT rule 6, and the one command
// SPEC.md needs before the Client can close the loop by hand.
//
// `accept` and `wrong` are instant (they only append record events) and
// still run synchronously, reporting the outcome directly - though an
// `accept` additionally marks whichever older quiz questions its files
// may have dated, and can hand a cheap re-check of those to the same
// detached mechanism `fix` uses (`quizNoticeAfterAccept`). `fix` (issue
// #123) returns immediately instead: the ruling is validated and
// recorded right here - a bad "fix" still fails on the spot - but the
// round itself (the same warm worker re-entering the same line) is
// handed to a detached process, the same mechanism `fabrica do` uses.
// There is no cap on how many rounds a task can have (issue #65) - see
// `fixRoundOf` for where the round number printed below comes from.

import { createForeman, fixRoundOf, onTaskAccepted, recordVerdictDecision, recordVerdictFailure } from "../index.ts";
import { parseVerdictArgs, VERDICT_USAGE } from "./verdict-args.ts";
import { resolveRecordHome } from "./record-home.ts";
import { loadConfigOrDefault } from "./load-config.ts";
import { spawnDetachedResume } from "./spawn-detached.ts";

/** The three ruling names, for reading what was attempted off the raw
 * arguments when the parse itself fails (issue #353 - see
 * `runVerdictCommand`). The parser is still the authority on everything
 * else about them. */
const RULINGS = ["accept", "fix", "wrong"];

export const VERDICT_HELP = `Usage: ${VERDICT_USAGE}

Records the Client's ruling on a delivered task - the last word CONTRACT
rule 6 requires before a task can close. A task stays open and listed in
\`fabrica status\` until this is called.

  accept   The work is right. Closes the task.
  fix      Right direction, wrong details. The note becomes a correction
           handed back to the same warm worker on the same line, in the
           background - this command returns as soon as the ruling is
           recorded. No limit on how many times you can rule fix; each
           round reports which one it is. The task stays open; follow
           progress with \`fabrica log <id>\`/\`fabrica watch <id>\`.
  wrong    Not what was wanted, and not worth correcting. Closes the
           task - a real outcome, not a failure of the system.

Options:
  -m "<note>"   Your note on the work, in the shape \`git commit -m\` uses.
                Optional for accept and wrong, required for fix - it is
                the correction the worker is handed.

Environment:
  FABRICA_HOME  Overrides the record home (default: ~/.fabrica).
`;

export interface RunVerdictCommandOptions {
  recordHome?: string;
  /** Test-only, "fix" only: forwarded to spawnDetachedResume so a test
   * can run a real fix round against a fake brain, the same way
   * do-command.test.ts uses entryScript. Omitted, the real default
   * entry script runs, which is what every real invocation does. */
  entryScript?: string;
  /** Test-only, "accept" only: the same override for the quiz re-check
   * round an accept can start (see `quizNoticeAfterAccept`). */
  quizRecheckEntryScript?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/**
 * The quiz's own bookkeeping on an accept, and the one line it prints
 * about it: an accepted task's files may be the files an older accepted
 * task's quiz questions were written about, which makes those questions
 * possibly untrue, so they are marked and stop being asked until a cheap
 * re-check round rules on them (src/quiz/). This is the moment the code
 * changed, which is why it happens here and on no schedule and behind no
 * button (Client ruling).
 *
 * Here rather than inside `recordVerdictDecision` for the same reason the
 * "fix" round above is spawned here: the Foreman records the ruling, and
 * everything that follows from it in the background belongs to the layer
 * that has a process to spawn. A library caller using `Foreman.verdict`
 * directly therefore marks nothing and starts nothing, exactly as it
 * starts no fix round of its own.
 *
 * Never throws: an accept is already on the record by the time this runs,
 * and a quiz the Client never asked about must not be able to turn a
 * recorded verdict into a failed command. Returns null when there is
 * nothing to say.
 */
function quizNoticeAfterAccept(recordHome: string, taskId: string, entryScript: string | undefined): string | null {
  try {
    const { marked, pending } = onTaskAccepted(recordHome, taskId);
    if (pending === 0) return null;
    spawnDetachedResume({ recordHome, taskId, kind: "quiz-recheck", entryScript });
    const markedNow = marked.length > 0 ? `${marked.length} earlier ${marked.length === 1 ? "task's" : "tasks'"} ` : "";
    return (
      `quiz: ${markedNow}questions may be out of date after this change - ` +
      `${pending} task${pending === 1 ? "" : "s"} queued for a re-check in the background.`
    );
  } catch (err) {
    return `quiz: could not check whether this change dates any earlier questions (${(err as Error).message}).`;
  }
}

/** Returns the process exit code - never throws. */
export async function runVerdictCommand(argv: string[], opts: RunVerdictCommandOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((line: string) => console.log(line));
  const stderr = opts.stderr ?? ((line: string) => console.error(line));

  // Issue #353 asks that every verdict attempt reach the task's own log,
  // failures included - so what was attempted has to be known in the
  // catch below as well as inside the `try`.
  //
  // Read straight off the two positionals this command's own usage line
  // declares (`<taskId> <accept|fix|wrong>`), deliberately, rather than
  // waiting for the parse to succeed: `parseVerdictArgs` refuses a `fix`
  // with no note, which is one of the real ways a ruling fails, and it
  // refuses it AFTER it has already read both positionals. Taking them
  // from here covers that case too. The ruling is recognised rather than
  // trusted - anything that is not one of the three names no ruling, and
  // `recordVerdictFailure`'s own check keeps an id that is not a task in
  // this record from ever being written down.
  let attempted: { taskId: string; ruling: string; note?: string } | undefined =
    argv.length >= 2 && RULINGS.includes(argv[1]) ? { taskId: argv[0], ruling: argv[1] } : undefined;
  // Resolved before the parse rather than after it, for the same reason:
  // it is an environment variable and a home directory, it cannot fail,
  // and the catch below needs it.
  const recordHome = opts.recordHome ?? resolveRecordHome();

  try {
    const { taskId, ruling, note } = parseVerdictArgs(argv);
    attempted = { taskId, ruling, ...(note === undefined ? {} : { note }) };
    const caps = loadConfigOrDefault(recordHome).caps;

    // Validates and records the ruling right here, synchronously - a bad
    // ruling (an unknown task, an already-closed one, a missing note, a
    // cap refusal) fails on the spot, before anything is handed off to
    // the background.
    recordVerdictDecision(recordHome, taskId, ruling, note, { caps });

    if (ruling === "fix") {
      const round = fixRoundOf(recordHome, taskId);
      spawnDetachedResume({ recordHome, taskId, kind: "fix", entryScript: opts.entryScript });
      stdout(
        `fix round ${round} recorded: ${taskId} is running again with your note in the background. ` +
          `Follow progress with \`fabrica log ${taskId}\` or \`fabrica watch ${taskId}\`.`
      );
      return 0;
    }

    if (ruling === "accept") {
      const events = await createForeman({ recordHome, caps }).events(taskId);
      const prEvent = events.filter((e) => e.name === "pr-opened").at(-1);
      const url = (prEvent?.details as { url?: string } | undefined)?.url;
      stdout(`${ruling} recorded: ${taskId} is closed.${url ? ` pull request: ${url}` : ""}`);
      const quizNotice = quizNoticeAfterAccept(recordHome, taskId, opts.quizRecheckEntryScript);
      if (quizNotice !== null) stdout(quizNotice);
    } else {
      stdout(`${ruling} recorded: ${taskId} is closed.`);
    }
    return 0;
  } catch (err) {
    // Anything at all, by its message - never a class list. A "fix"
    // reaches every layer Fabrica has (the CLI's own parsing, the
    // Foreman, the ProductionLine, config, the record, and whichever
    // brain adapter is wired in) and CONTRACT rule 8 makes that last one
    // pluggable, so the set of error types reachable here is not
    // knowable from this file. `verdict-recorded` is already on the
    // record by the time most of them can fire, so an escaped one would
    // replace an instruction the Client can act on with a stack trace,
    // on a task that then looks unruled. Nothing here branches on a
    // `code`, so nothing here needs the type.
    //
    // Issue #353: and before it is printed, it goes on the task's own
    // log. `recordVerdictDecision` already records whatever it refuses
    // itself; this covers everything after it - reading the round
    // number, handing the round off - and is a no-op for a failure that
    // already has its own event. A failure that cannot be attributed to
    // a task at all (the arguments themselves) is still printed and
    // nothing more: there is no log to write to yet.
    if (attempted !== undefined) {
      try {
        recordVerdictFailure(recordHome, attempted.taskId, attempted.ruling, attempted.note, err);
      } catch {
        // A record that cannot be written must not replace the real
        // error with its own. The Client still gets the message below.
      }
    }
    stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
