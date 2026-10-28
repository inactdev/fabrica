// A rebase-only fix round: what the Client's note "master moved" asks
// for, in one place (Client ruling, issue "make a rebase-only fix round
// short").
//
// The shape of a fix round is decided by the Client's own note. A note
// that begins "master moved" means this round is a rebase and nothing
// else, and three things narrow because of it:
//
//   1. the brief tells the worker to resolve the conflicts the host's
//      rebase could not, change nothing else, and run exactly the tests
//      the project's committed `tests.map` maps the CONFLICTED files to -
//      never the whole suite, and never a set the worker picked itself
//      (Client ruling: "the project's committed tests.map, exactly as
//      the brief already uses it for touched files; never the machine's
//      own judgment"). Nothing mapped, or nothing conflicted, means it
//      runs nothing in its box and says so: Inspector's full run is the
//      independent check for this round either way;
//   2. the write-up is one section - which files were resolved and how -
//      rather than the four-section template a round of real work
//      renders (`pr-body.ts`);
//   3. that one section is APPENDED to the pull request's existing body
//      under a fixed "## Rebase rounds" heading, each round its own
//      dated entry, so the description already written there survives
//      and the history of rebases accumulates. The body is never
//      rewritten from a rebase round's own words.
//
// Everything else about a fix round is untouched: the host-side rebase
// and its conflict handling (`fix-rebase.ts`), Inspector's own full run,
// its stamp, and the read-back of the checks the repository runs on the
// pull request. Only the worker's own run inside its box narrows (Client
// ruling); the check stage stays whole.
//
// A note that does not begin with "master moved" gets exactly the round
// it got before any of this existed - every seam below is optional and
// its absence is today's behaviour.

import { TEST_MAP_FILENAME } from "../testmap/index.ts";
import type { TestMapReport } from "../testmap/index.ts";
import { describeInvalidWriteup, finalMessageFor, titleProblem, writeupProblem } from "./pr-body.ts";
import type { FinalMessageForCommit } from "./pr-body.ts";
import { WRITEUP_STRING_FIELDS } from "../brain/index.ts";
import type { WorkerWriteup } from "../brain/index.ts";
import type { FabricaEvent } from "../record/index.ts";

/** The exact opening the Client writes when a round is a rebase and
 * nothing else. */
export const REBASE_ONLY_PREFIX = "master moved";

/** The fixed section a rebase-only round's one section is appended
 * under, at the end of the pull request's body - the same heading every
 * time, so the Client finds the rebase history of a pull request in one
 * known place. */
export const REBASE_ROUNDS_HEADING = "## Rebase rounds";

/**
 * Whether this fix note asks for a rebase-only round.
 *
 * Anchored at the start, like `pr-body.ts`'s `issueNamedByTaskText` and
 * for the same reason: a note that merely mentions master having moved
 * part-way through a sentence is asking for ordinary work on top of that
 * fact, and must get the full round. Leading whitespace and the Client's
 * own capitalization are tolerated - those are typing, not meaning.
 */
export function isRebaseOnlyNote(note: string): boolean {
  return note.trimStart().toLowerCase().startsWith(REBASE_ONLY_PREFIX);
}

/**
 * The conditional notice a rebase-only round's brief carries in place of
 * the test-map notice (or the only-touched-tests one) an ordinary round
 * gets - see `touched-tests.ts`'s `workerBrief`, which resolves exactly
 * one of the three.
 *
 * `conflicted` is every file this round's worker has been handed a
 * conflict in, including earlier stops of the same rebase: the earlier
 * resolutions are still in the branch, so the tests covering them are
 * still this round's to run. `report` is those files resolved against
 * the project's own map (`test-map.ts`'s `reportForRound`), or undefined
 * when the project commits no map at all.
 */
export function rebaseOnlyBriefNotice(conflicted: string[], report: TestMapReport | undefined): string {
  const parts: string[] = [
    `This round is a rebase and nothing else. The Client's note begins "${REBASE_ONLY_PREFIX}": the project's ` +
      `default branch has moved on, and this task's branch has already been brought up to it before you were ` +
      `called. Resolve what that rebase could not, and change nothing else - no refactoring, no improvements, ` +
      `no second look at the work itself, however tempting. Anything beyond the conflicts belongs to a round ` +
      `the Client asks for in his own words.`,
  ];

  if (conflicted.length === 0) {
    parts.push(
      `Nothing conflicted, so there is nothing here to resolve and nothing for you to run: say exactly that in ` +
        `your write-up and finish. The independent check runs this project's whole suite after you, as it always ` +
        `does, so nothing goes unchecked.`
    );
  } else if (report === undefined || report.tests.length === 0) {
    parts.push(
      `Run nothing in this box: ${
        report === undefined
          ? `this project commits no ${TEST_MAP_FILENAME}`
          : `nothing in this project's ${TEST_MAP_FILENAME} maps to the files that conflicted`
      }, so there is no mapped test to run, and the whole suite is deliberately not yours to run this round. ` +
        `Say that in your write-up. The independent check runs the whole suite after you, as it always does, so ` +
        `nothing goes unchecked.`
    );
  } else {
    parts.push(
      `Run exactly these tests, and nothing else - NOT the project's whole suite. They are what this project's ` +
        `own ${TEST_MAP_FILENAME} maps the conflicted files to; the independent check runs the whole suite after ` +
        `you, as it always does, so running it yourself only costs the Client minutes. Fix a failure here before ` +
        `you finish, and list the ones you ran in your write-up's testsRun field:\n${report.tests
          .map((test) => `  - ${test}`)
          .join("\n")}`
    );
  }

  if (report !== undefined && report.unmapped.length > 0) {
    parts.push(
      `These conflicted files are mapped to nothing, and are already reported to the Client as unmapped - name ` +
        `them in your write-up too rather than leaving it to be noticed:\n${report.unmapped
          .map((file) => `  - ${file}`)
          .join("\n")}`
    );
  }

  parts.push(
    `Your write-up for this round is one section. Put it in the \`how\` field: every file whose conflicts you ` +
      `resolved and how you resolved each one - one line per file, enough for a reviewer to see which side won ` +
      `and why - plus which of the tests above you ran, or that there were none. That section is the whole of ` +
      `what this round publishes: it becomes this round's commit message, and it is appended to the pull ` +
      `request's existing body under a "${REBASE_ROUNDS_HEADING.replace(/^#+\s*/, "")}" heading, which leaves ` +
      `everything already written there exactly as it is. The answer format still asks you for its other ` +
      `fields; only \`title\` (a short imperative line for the commit) and \`how\` are used this round, so keep ` +
      `the rest to one short line each.`
  );

  return parts.join("\n\n");
}

/** What the pull request this task already has says, as its last round
 * of real work left it, plus every rebase round since. */
export interface PullRequestMessage {
  title: string;
  body: string;
}

/**
 * Everything wrong with a rebase-only round's write-up, as one clause -
 * or undefined when it is usable. Deliberately narrower than
 * `writeupProblem`: this round publishes one section, so the only fields
 * that have to be there are the commit's title and the section itself.
 * Holding a rebase round to all ten would cost the Client a whole extra
 * round over an empty `expectedOutcomes` nothing would ever render.
 */
export function rebaseOnlyProblem(writeup: WorkerWriteup | undefined): string | undefined {
  if (writeup === undefined) return "the worker returned no write-up";
  const problems: string[] = [];
  // `typeof` first, not just the contents: both adapters build a
  // write-up out of whatever their brain actually sent, and one read
  // back off the record can predate a field existing at all - the same
  // reason `quizProblem` takes `unknown` rather than trusting the
  // declaration.
  if (typeof writeup.title !== "string") problems.push("the title field is empty");
  else {
    const title = titleProblem(writeup.title);
    if (title !== undefined) problems.push(title);
  }
  if (typeof writeup.how !== "string" || writeup.how.trim().length === 0) {
    problems.push("the how field is empty - it is the one section a rebase round reports");
  }
  return problems.length > 0 ? problems.join("; ") : undefined;
}

/**
 * A rebase-only round's own message: the worker's title, and the one
 * section (`rebaseRoundEntry` below) as its whole body. What
 * `attempts.ts` commits with - and, being the entry itself, what
 * `appendRebaseRound` puts at the end of the pull request's body.
 *
 * Same contract as `finalMessageFor`, which an ordinary round uses: it
 * always returns something committable, falling back to a label naming
 * what was wrong rather than ever reaching for the task's own words -
 * and `ok: false` is what makes the attempt red without ever being
 * handed to Inspector (see attempts.ts).
 */
export function rebaseOnlyMessage(
  writeup: WorkerWriteup | undefined,
  fallbackTitle: string,
  ctx: { date: string; base?: string }
): FinalMessageForCommit {
  const reason = rebaseOnlyProblem(writeup);
  if (reason !== undefined || writeup === undefined) {
    // `describeInvalidWriteup`, not a second copy of its wording: a red
    // attempt, its receipt and the failure report all read the same
    // sentence whichever renderer the round was using.
    return { title: fallbackTitle, body: `${describeInvalidWriteup(reason!)}.`, ok: false, reason };
  }
  return { title: writeup.title.trim(), body: rebaseRoundEntry(writeup.how, ctx), ok: true };
}

/**
 * One rebase round's entry under `REBASE_ROUNDS_HEADING`: its own date,
 * the branch it was brought up to where that is known, and the worker's
 * account of the conflicts it resolved, verbatim.
 *
 * The dated line is bold rather than a markdown heading on purpose, and
 * this is the one detail here worth not "tidying": the same text is this
 * round's commit message, and git strips every line beginning with `#`
 * from a message it considers edited - which is exactly what a message
 * written through `git rebase --continue` is (src/line/rebase.ts runs it
 * with `GIT_EDITOR: "true"`, so git's cleanup mode is "strip", not
 * "whitespace"). A `###` date line would therefore survive in the pull
 * request's body and silently vanish from the commit's. Bold reads the
 * same in both.
 */
export function rebaseRoundEntry(account: string, ctx: { date: string; base?: string }): string {
  const onto = ctx.base === undefined ? "" : ` - rebased onto \`origin/${ctx.base}\``;
  return `**${ctx.date}${onto}**\n\n${account.trim()}`;
}

/**
 * `body` with `entry` appended under `REBASE_ROUNDS_HEADING` - the
 * heading added only when the body does not already carry it, so the
 * second and later rebase rounds of one pull request accumulate as
 * dated entries under the same section instead of repeating it (Client
 * ruling: "each rebase-only round appends its own dated entry under it,
 * so the history accumulates").
 */
export function withRebaseRoundSection(body: string, entry: string): string {
  const base = body.trimEnd();
  const hasHeading = base.split("\n").some((line) => line.trim() === REBASE_ROUNDS_HEADING);
  return `${base}\n\n${hasHeading ? "" : `${REBASE_ROUNDS_HEADING}\n\n`}${entry}`;
}

/** This round's pull request message: the one the task already had, with
 * this round's section appended to its body. The title is carried
 * through untouched - the pull request is the same pull request, and a
 * rebase round has no business renaming the work. */
export function appendRebaseRound(prior: PullRequestMessage, entry: string): PullRequestMessage {
  return { title: prior.title, body: withRebaseRoundSection(prior.body, entry) };
}

/**
 * The pull request's own text as this task's record describes it:
 * whatever `pullRequestOnRecord` rebuilt when the latest delivered round
 * was a rebase-only one (that round's own entry included, since it is
 * delivered), and the ordinary four-section render of the round's
 * write-up otherwise.
 *
 * One reader: the review page, which shows the Client "the pull
 * request's own write-up" and must show what was actually published -
 * for a rebase round that is the description plus the rebase history,
 * not a four-section render of a write-up whose other fields were never
 * used. A write-up this round made unusable falls through to
 * `finalMessageFor`, which is what names the problem.
 */
export function publishedPullRequestMessage(
  events: FabricaEvent[],
  writeup: WorkerWriteup | undefined,
  fallbackTitle: string
): FinalMessageForCommit {
  if (latestRoundWasRebaseOnly(events) && rebaseOnlyProblem(writeup) === undefined) {
    const published = pullRequestOnRecord(events);
    if (published !== undefined) return { ...published, ok: true };
  }
  return finalMessageFor(writeup, fallbackTitle);
}

/** Whether the round that produced this task's latest delivery was a
 * rebase-only one - decided by the Client's own last ruling before it,
 * the same way `pullRequestOnRecord` decides it per delivery. */
export function latestRoundWasRebaseOnly(events: FabricaEvent[]): boolean {
  let rebaseOnly = false;
  for (const event of events) {
    if (event.name !== "verdict-recorded") continue;
    const details = event.details as { ruling?: string; note?: string } | undefined;
    rebaseOnly = details?.ruling === "fix" && isRebaseOnlyNote(details.note ?? "");
  }
  return rebaseOnly;
}

/**
 * The pull request message this task already has, rebuilt from its own
 * record: the latest delivered round that carried a usable write-up and
 * was NOT itself a rebase round, rendered through `finalMessageFor` (the
 * one renderer, never a second copy of it), plus one dated entry for
 * every rebase-only round since.
 *
 * Nothing extra is stored for this - a round re-derives it the same way
 * a detached fix round re-derives its project, note and receipts. Which
 * rounds were rebase-only is read off the `"verdict-recorded"` events
 * the Client's own rulings left: the ruling immediately before a
 * delivery is the one that asked for the round that produced it.
 *
 * Undefined when there is no earlier write-up to append to at all (a
 * task whose only delivery was a conflict report, say). This round's
 * message then stands exactly as it would have, which loses nothing:
 * there is no description anywhere to preserve.
 *
 * Named limit: the latest usable write-up may belong to a round that
 * went red, which Inspector never published - the body handed over is
 * then a little newer than the one on the pull request. That is the same
 * body every ordinary round already hands over, and no description is
 * ever lost either way, which is the property this exists to protect.
 */
export function pullRequestOnRecord(events: FabricaEvent[]): PullRequestMessage | undefined {
  let base: FinalMessageForCommit | undefined;
  let entries: string[] = [];
  let roundIsRebaseOnly = false;

  for (const event of events) {
    if (event.name === "verdict-recorded") {
      const details = event.details as { ruling?: string; note?: string } | undefined;
      roundIsRebaseOnly = details?.ruling === "fix" && isRebaseOnlyNote(details.note ?? "");
      continue;
    }
    if (event.name !== "delivered") continue;
    const writeup = (event.details as { writeup?: WorkerWriteup } | undefined)?.writeup;
    if (writeup === undefined) continue;
    if (roundIsRebaseOnly) {
      if (rebaseOnlyProblem(writeup) === undefined) {
        entries.push(rebaseRoundEntry(writeup.how, { date: dateOf(event.occurredAt) }));
      }
      continue;
    }
    // Shape before contents, for the reason `rebaseOnlyProblem` gives:
    // `writeupProblem` reads each required field directly, so a
    // write-up on an old event missing one must never reach it.
    if (!WRITEUP_STRING_FIELDS.every((field) => typeof writeup[field] === "string")) continue;
    if (writeupProblem(writeup) !== undefined) continue;
    base = finalMessageFor(writeup, "");
    entries = [];
  }

  if (base === undefined || !base.ok) return undefined;
  return { title: base.title, body: entries.reduce(withRebaseRoundSection, base.body) };
}

/** The calendar day an entry is dated by: a round's own date, to the
 * day, which is what a reader of a pull request's rebase history wants -
 * not the second it landed. */
export function dateOf(occurredAt: string): string {
  return occurredAt.slice(0, 10);
}

/** Today, in the same shape - for the round being run right now, which
 * has no event of its own yet. */
export function today(): string {
  return dateOf(new Date().toISOString());
}
