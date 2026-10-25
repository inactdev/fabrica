// CONTRACT rule 6 ("You get the last word"): the Client's ruling on a
// delivered task. `accept` and `wrong` both close the loop - `wrong` is a
// real outcome, not a failure of the system, and the record shows it
// plainly rather than folding it into "failed". `fix` does not close the
// task: the Client's note re-enters the SAME warm worker on the SAME line
// (src/line/resume.ts) as a correction. Unlike Fabrica's own retry loop
// (src/foreman/attempts.ts, rule 3's "three means three"), a `fix` has no
// budget and no refusal - the Client asked for it, so the Client is the
// stop condition, not a counter (issue #65). Each round is still counted
// and reported, derived from the record rather than stored separately -
// see `fixRoundOf` in queries.ts. `verdict-recorded` lands on the record
// for every ruling, per rule 6, before any of "fix"'s follow-up work
// happens.

import { appendEvent, appendTaskFile, readEventsForTask, readTaskFile } from "../record/index.ts";
import { abortRebase, destroyProductionLine, rebaseInProgress, reopenProductionLine } from "../line/index.ts";
import { withTaskNetwork } from "../brain/index.ts";
import type { Brain } from "../brain/index.ts";
import { networkPolicyFor } from "./network-policy.ts";
import { ForemanError } from "./errors.ts";
import {
  failedWithNoDelivery,
  gateDeclarationsOf,
  latestDeliveredDetails,
  receiptsOf,
  redPublishedChecksOf,
  refusalAfterDelivery,
  refusedWithNoDelivery,
} from "./queries.ts";
import { checksCorrection } from "../ci/index.ts";
import { prepareRound, skipIfUnchanged } from "./judge.ts";
import type { ChecksReader } from "./ci-checks.ts";
import type { TokenMinter } from "../githubapp/index.ts";
import type { DiffReader } from "./reader-round.ts";
import type { Judgement } from "./judge.ts";
import { closesIssueFor } from "./pr-body.ts";
import { storedClosesIssue, taskIssueText, withIssueText } from "./task-issue.ts";
import { knowledgeNotesFor, withKnowledge } from "./task-knowledge.ts";
import { testMapFor } from "./test-map.ts";
import { workerBrief } from "./touched-tests.ts";
import { recordingFailure } from "./task-failure.ts";
import { sweepTaskNetworks } from "./task-networks.ts";
import { runAttempts } from "./attempts.ts";
import type { AttemptLoopResult } from "./attempts.ts";
import { recordRoundResult } from "./round.ts";
import { readAndFlag } from "./reader-round.ts";
import { alreadyReadFor } from "./queries.ts";
import {
  continueStoppedRebase,
  publishLeaseAfterRebase,
  rebaseConflictInstructions,
  rebaseForFixRound,
  recordStop,
} from "./fix-rebase.ts";
import type { FixRebaseStep, PublishLease, StoppedRebase } from "./fix-rebase.ts";
import { baseCommitOf, diffFiles } from "../delivery/index.ts";
import { recordReceipt, requireRoomToStart, spendLimitsFor } from "./caps.ts";
import { pauseRuleFor, requireMeterRoomToStart } from "./meters.ts";
import { readModelChoice } from "./model.ts";
import type { Caps } from "../../contract/surface.ts";
import type { Inspector, Receipt } from "../inspector/types.ts";
import type { CheckBox } from "../brain/index.ts";

const RULINGS = new Set(["accept", "fix", "wrong"]);

/**
 * The fast, synchronous half of a verdict: validates the ruling against
 * the record and writes `verdict`/`"verdict-recorded"` - everything a
 * "fix" needs to actually run (project, baseCommit, prior receipts, the
 * note) is already derivable from the record afterwards (see
 * `runRecordedFix` below), so this returns nothing. Split out so the CLI
 * (issue #123) can run this part in the foreground - a bad ruling fails
 * immediately, before anything is handed to a detached process - while
 * only the "fix" round's worker call, the slow part, is deferred.
 * `recordVerdict` (below) composes this with actually running that round,
 * which is what every library caller (the contract tests included) still
 * gets: a verdict call that doesn't resolve until a "fix" round is done.
 */
export function recordVerdictDecision(
  recordHome: string,
  taskId: string,
  ruling: "accept" | "fix" | "wrong",
  note: string | undefined,
  opts: { caps?: Caps }
): void {
  if (!RULINGS.has(ruling)) {
    throw new ForemanError(
      "invalid-verdict",
      `fabrica verdict: "${ruling}" is not a verdict. Use one of: accept, fix, wrong.`
    );
  }

  const events = readEventsForTask(recordHome, taskId);
  if (events.length === 0) {
    throw new ForemanError(
      "unknown-task",
      `fabrica verdict: no task "${taskId}" in this record. Check the id with \`fabrica status\`.`
    );
  }

  const lastVerdict = events.filter((e) => e.name === "verdict-recorded").at(-1);
  const lastRuling = (lastVerdict?.details as { ruling?: string } | undefined)?.ruling;
  if (lastRuling === "accept" || lastRuling === "wrong") {
    throw new ForemanError(
      "already-closed",
      `fabrica verdict: task "${taskId}" already has a final verdict ("${lastRuling}") and is closed. ` +
        `There is nothing left to rule on.`
    );
  }

  const deliveredIndex = events.map((event) => event.name).lastIndexOf("delivered");
  // A task Inspector refused before it ever reached a delivery has
  // nothing for "accept" or "fix" to work with - no delivery details to
  // reopen a line from, no verdict to repair toward, nothing on the
  // branch anyone has reviewed. "wrong" needs none of that (it only
  // closes the task), so it is the one ruling the Client can still use
  // to close this state instead of it refusing every ruling forever
  // (Client ruling), and it stays the only one.
  const closesRefusedWithNoDelivery = ruling === "wrong" && refusedWithNoDelivery(events);
  if (refusedWithNoDelivery(events) && !closesRefusedWithNoDelivery) {
    throw new ForemanError(
      "inspection-refused",
      `fabrica verdict: Inspector reached no verdict for task "${taskId}", and it never reached a delivery - ` +
        `there is nothing to accept and nothing to fix, so only "wrong" can close it. Read ` +
        `\`fabrica log ${taskId}\` for why.`
    );
  }
  // A refusal that comes AFTER a real delivery is a different case: that
  // delivery is still there for the Client to rule on directly, so
  // "accept"/"wrong" rule on it as if the later refusal never happened
  // (recorded as superseded below). "fix" used to refuse here too, on the
  // reasoning that Inspector's own refusal had to be resolved by hand
  // before a fresh worker attempt was worth running - which left the task
  // with no way forward through Fabrica at all. By Client ruling it now
  // re-enters the same warm worker on the same line with the refusal's
  // own reason as its correction, exactly like a fix after an
  // inspection-red delivery: the refusal is for this loop to clear, not
  // for the Client to go and clear outside it. See `runRecordedFix`
  // below and `queries.ts`'s `refusalAfterDelivery`.
  const refusalToFix = refusalAfterDelivery(events);
  const rulesOnDeliveryDespiteLaterRefusal = refusalToFix !== null && (ruling === "accept" || ruling === "wrong");

  // A task that failed before it ever reached a delivery (brain.ask()
  // threw, a spending cap refused its first start, or some other error
  // killed it) has no `fix` path and nothing for "accept" to work with
  // either - same shape as the Inspector-refused case above, and the
  // same exception: "wrong" alone can still close it (issue #143).
  const closesFailedWithNoDelivery = ruling === "wrong" && failedWithNoDelivery(events);
  if (failedWithNoDelivery(events) && !closesFailedWithNoDelivery) {
    throw new ForemanError(
      "not-delivered",
      `fabrica verdict: task "${taskId}" failed before it ever reached a delivery and has no \`fix\` path - ` +
        `only "wrong" can close it. Read \`fabrica log ${taskId}\` for why.`
    );
  }

  if (deliveredIndex === -1 && !closesRefusedWithNoDelivery && !closesFailedWithNoDelivery) {
    throw new ForemanError(
      "not-delivered",
      `fabrica verdict: task "${taskId}" has not been delivered yet — there is nothing to rule on until ` +
        `\`fabrica do\` finishes it. Check \`fabrica status\`.`
    );
  }

  if (ruling === "fix" && (!note || note.trim().length === 0)) {
    throw new ForemanError(
      "missing-note",
      `fabrica verdict: a "fix" verdict needs a note saying what to change - it becomes the correction ` +
        `handed back to the worker. Usage: fabrica verdict ${taskId} fix -m "<what to fix>"`
    );
  }

  // Only what this half actually decides on: a "fix" needs a line to
  // reopen, and that needs both of these. The round itself re-derives
  // everything else from the record (`runRecordedFix` below), receipts
  // included - and since issue #68 a single delivery's `receipts` is one
  // round's anyway, never the task's whole list.
  const details = latestDeliveredDetails(recordHome, taskId);
  const project = details?.project;
  const baseCommit = details?.baseCommit;

  if (ruling === "fix" && (project === undefined || baseCommit === undefined)) {
    throw new ForemanError(
      "not-delivered",
      `fabrica verdict: task "${taskId}"'s delivery record is missing what a "fix" needs to reopen its ` +
        `line. Record "accept" or "wrong" instead.`
    );
  }

  // Rule 10: a fix spends money, so it is held to the caps like any new
  // start - checked before the verdict is recorded, so a refused fix can
  // simply be asked for again once there is room.
  // Issue #189: and the pause rule too - including on a fix the Client
  // is ruling to resume a task the pause rule itself stopped. That is
  // deliberate rather than an awkward edge: his fix is what restarts a
  // paused task, and it restarts it only once there is room again (or
  // once he has raised the threshold), which is the whole point of
  // there being no automatic resume.
  if (ruling === "fix") {
    const project = latestDeliveredDetails(recordHome, taskId)?.project;
    requireRoomToStart(recordHome, taskId, opts.caps, { project });
    requireMeterRoomToStart(recordHome, taskId, { project });
  }

  // Write the human-readable verdict file before the record event that
  // closes (or reopens) the loop on it — same principle as the
  // commit-failure delivery in do.ts writing delivery.md before its
  // "delivered" event: a failure between the two must never leave a task
  // showing as ruled on with no record of what the Client actually said.
  appendTaskFile(recordHome, taskId, "verdict", `${new Date().toISOString()} ${ruling}${note ? `: ${note}` : ""}\n`);
  appendEvent(recordHome, {
    taskId,
    name: "verdict-recorded",
    details: {
      ruling,
      note: note ?? "",
      ...(rulesOnDeliveryDespiteLaterRefusal ? { supersedesRefusal: true } : {}),
      // Bookkeeping only, for anyone reading the record afterwards:
      // this round is answering Inspector's own refusal, not a red
      // report, so its brief carries that reason alongside the note
      // (`refusalCorrection` below). Nothing branches on it - the round
      // re-derives the refusal from the record the same way it
      // re-derives everything else.
      ...(refusalToFix !== null && ruling === "fix" ? { answersRefusal: true } : {}),
    },
  });
}

/**
 * Runs the "fix" round a prior `recordVerdictDecision(..., "fix", note,
 * ...)` call already validated and recorded - everything the round needs
 * (project, baseCommit, prior receipts, the declared gate changes so
 * far, and the note itself) is re-derived from the record rather than
 * threaded through a parameter, since that's exactly what lets the CLI
 * (issue #123) hand this off to a detached process with nothing to
 * serialize beyond `recordHome`/`taskId` - the same reason `fabrica do`'s
 * own detached runner re-derives everything `doTask` needs from its own
 * arguments rather than smuggling state across the process boundary.
 */
export async function runRecordedFix(
  recordHome: string,
  taskId: string,
  opts: { brain: Brain; inspector?: Inspector; checkBox?: CheckBox; checksReader?: ChecksReader; minter?: TokenMinter; readDiff?: DiffReader; caps?: Caps }
): Promise<void> {
  const details = latestDeliveredDetails(recordHome, taskId);
  const totalAttempts = details?.totalAttempts;
  const project = details?.project;
  const baseCommit = details?.baseCommit;

  const events = readEventsForTask(recordHome, taskId);
  const lastVerdict = events.filter((e) => e.name === "verdict-recorded").at(-1);
  const note = (lastVerdict?.details as { note?: string } | undefined)?.note ?? "";
  // The refusal this round is being asked to clear, if that is what the
  // task's latest word is - read back off the record exactly like the
  // note, the project and the base commit above.
  const refusal = refusalAfterDelivery(events);
  // Issue #267: and the pull request's own red checks, when that is what
  // the delivery being fixed went red on. Read back off the record the
  // same way, and handed to the worker alongside the Client's note - his
  // note says what he wants changed, this says what GitHub found.
  const redChecks = redPublishedChecksOf(events);

  // Every receipt the task has, not just the ones the latest *delivery*
  // carried: a round Inspector refused delivers nothing, so its attempts
  // are on the record only as their own "receipt-recorded" events
  // (`receiptsOf` merges both sources). Reading the stale delivery's list
  // instead would restart `startAttempt` on an attempt number this task
  // has already used - and `receiptsOf` de-duplicates by attempt, so the
  // new receipt would then be dropped from the next delivery's
  // cumulative list altogether. For a fix after an ordinary delivery
  // this is the same set it always was, since every receipt lands on
  // both the "delivered" event and its own "receipt-recorded" one.
  const priorReceipts = receiptsOf(recordHome, taskId);

  // #73: whatever throws in the fix round lands on the record as task-failed.
  // The `finally` below is the same end-of-round sweep do.ts's first
  // round gets: a fix round opens its own worker box, on its own
  // throwaway Docker networks, and they go when it does
  // (./task-networks.ts).
  try {
    await recordingFailure(recordHome, taskId, () =>
      runFixRound(recordHome, taskId, note, {
        brain: opts.brain,
        project: project!,
        totalAttempts,
        baseCommit: baseCommit!,
        priorReceipts,
        refusalReport: refusal?.report,
        redChecksOutput: redChecks?.output,
        // Every earlier round's own declaration, not the previous delivery's
        // already-merged text (issue #68): keeping them separate is what lets
        // each one be keyed by the gate it names, so the newest declaration
        // per gate is the one this round's delivery reports instead of every
        // round's being appended forever.
        priorGateDeclarations: gateDeclarationsOf(events),
        inspector: opts.inspector,
        checkBox: opts.checkBox,
        checksReader: opts.checksReader,
        minter: opts.minter,
        readDiff: opts.readDiff,
        caps: opts.caps,
      })
    );
  } finally {
    await sweepTaskNetworks(taskId);
  }
}

/** Every library caller's shape (contract tests included): a verdict
 * call that doesn't resolve until a "fix" round it started is done.
 * `src/cli/verdict-command.ts` is the one caller that wants the two
 * halves apart - see `recordVerdictDecision`/`runRecordedFix` above. */
export async function recordVerdict(
  recordHome: string,
  taskId: string,
  ruling: "accept" | "fix" | "wrong",
  note: string | undefined,
  opts: { brain: Brain; inspector?: Inspector; checkBox?: CheckBox; checksReader?: ChecksReader; minter?: TokenMinter; readDiff?: DiffReader; caps?: Caps }
): Promise<void> {
  recordVerdictDecision(recordHome, taskId, ruling, note, { caps: opts.caps });
  if (ruling !== "fix") return;
  await runRecordedFix(recordHome, taskId, opts);
}

/** Told exactly what the Client asked for, on top of the original ask -
 * mirrors attempts.ts's correctionBrief, but from the Client's review
 * rather than a failed check. `extra` (issue #235) is anything the host
 * needs the worker to know about the state it is being handed, appended
 * after the Client's own words.
 *
 * This is the round's own words only; `workerBrief` puts the standing
 * prefix - and, when the project asks for it, the only-touched-tests
 * notice (issue #142) - in front of the whole thing at the call site,
 * the same way do.ts's round does. */
function buildFixBrief(originalBrief: string, note: string, extra?: string): string {
  return (
    `${originalBrief}\n\n---\n\nThe Client reviewed your previous delivery and asked for a change. ` +
    `Keep everything that was already right, and fix exactly this:\n\n${note}` +
    (extra ? `\n\n---\n\n${extra}` : "")
  );
}

/**
 * What the worker is told when the round it is re-entering is answering
 * an Inspector refusal rather than a red report (Client ruling): the
 * refusal's own reason, framed so the worker knows it was a refusal and
 * not a judgement on its work.
 *
 * Both shapes of refusal are covered in one text, deliberately. Inspector
 * exits the same way for either of its two no-verdict causes - it
 * declined before attempting any publication, or the local check passed
 * and a green publication was left incomplete - and publishes no exit
 * code, marker line or report field that tells the two apart, so Fabrica
 * cannot classify the refusal it is holding without pattern-matching
 * another project's prose. Inspector's own report is handed over verbatim
 * instead, with the instruction for each shape attached to what that
 * report actually says. (If this ever needs deciding in code, the
 * mechanism is `src/inspector/consumer-contract.json`, the ratified copy
 * of the call that syncs to Inspector's own test data - not a regex.)
 */
function refusalCorrection(report: string): string {
  return (
    `Inspector refused the previous round: ${report}\n\n` +
    `A refusal is not a red report - Inspector reached no verdict at all, so nothing about your work was ` +
    `judged, and this branch still carries it. Read that reason: if it names something in this tree, fix ` +
    `that and nothing else. If instead it says the check passed and the branch was not published, then the ` +
    `work itself is fine - publishing is the host's job after this round, not yours (you cannot push from ` +
    `here anyway), so change nothing and only confirm the tree is as intended.`
  );
}

async function runFixRound(
  recordHome: string,
  taskId: string,
  note: string,
  ctx: {
    brain: Brain;
    project: string;
    totalAttempts: number | undefined;
    baseCommit: string;
    priorReceipts: Receipt[];
    /** Inspector's own reason, set exactly when this round is answering
     * a refusal that superseded an earlier delivery (`runRecordedFix`).
     * Two things follow from it: the worker's brief carries it as a
     * correction, and the round's judge is never wrapped with
     * `skipIfUnchanged` - see both call sites below. */
    refusalReport?: string;
    /** Issue #267: the delivery's own evidence, set exactly when the
     * delivery this round is fixing went red on the checks the
     * repository runs on the pull request rather than on Inspector's
     * verdict (`queries.ts`'s `redPublishedChecksOf`). One thing follows
     * from it: the worker's brief carries it as a correction, after the
     * Client's note. Unlike `refusalReport` it does NOT unwrap
     * `skipIfUnchanged` - the branch WAS reviewed and published here, so
     * a round whose worker changes nothing has genuinely nothing new to
     * hand anybody, and re-reading the same commit's checks would only
     * find the same red. */
    redChecksOutput?: string;
    /** Every gate declaration this task's earlier rounds made, oldest
     * first (`queries.ts`'s `gateDeclarationsOf`). */
    priorGateDeclarations: string[];
    inspector?: Inspector;
    checkBox?: CheckBox;
    /** Issue #267's seam (judge.ts's `ChecksReader`) - omitted reads
     * the pull request's real checks from GitHub. */
    checksReader?: ChecksReader;
    /** Issue #187's seam: where this round's GitHub App tokens are
     * minted from. Omitted uses the real App on this machine. */
    minter?: TokenMinter;
    /** Inspector issue #34's seam (reader-round.ts's `DiffReader`) -
     * omitted makes the real call to the project's configured reader. */
    readDiff?: DiffReader;
    caps?: Caps;
  }
): Promise<void> {
  const {
    brain,
    project,
    totalAttempts,
    baseCommit,
    priorReceipts,
    refusalReport,
    redChecksOutput,
    priorGateDeclarations,
    inspector,
    checkBox,
    checksReader,
    minter,
    readDiff,
    caps,
  } = ctx;
  const lastSession = priorReceipts.at(-1)?.session ?? undefined;
  const originalBrief = readTaskFile(recordHome, taskId, "brief.md") ?? "";
  const taskText = readTaskFile(recordHome, taskId, "request.md") ?? originalBrief;
  // Same re-derivation do.ts's productionRound does: an explicit issue
  // has no home in taskText, so both it and its fetched words are read
  // back from what ask.ts persisted at registration - a fix round runs
  // in its own process and never asks GitHub anything.
  const closesIssue = closesIssueFor(taskText, storedClosesIssue(recordHome, taskId));
  const issueText = taskIssueText(recordHome, taskId);
  // Same re-derivation, same reason (issue #184): a fix round reports
  // the declaration this task was registered with, not whatever
  // projects.toml says by the time the Client rules on it.
  const modelChoice = readModelChoice(recordHome, taskId);
  // The project's knowledge notes, read off the disk now - a fix round
  // reads them as they are today, not as the first round found them
  // (task-knowledge.ts). Read before the line is reopened below, so a
  // note that has gone missing fails the round with the same message,
  // and in the same place, as it would on a task's first one.
  const knowledgeNotes = knowledgeNotesFor(recordHome, project);
  // And the project's committed test map, read now and for the same
  // reason: a fix round is held to the map as it stands today, and a
  // `tests.map` that has become unreadable fails the round before the
  // line is reopened rather than halfway through it (test-map.ts).
  const testMap = testMapFor(project);

  // Reopens the same line directly rather than going through
  // runProductionRound, so this round appends "work-started" below but
  // no "line-cut" - deliberately: the task already has one from its
  // original round, and nothing here reads it again. See
  // src/foreman/README.md's `verdict(taskId, ruling, note?)` section for
  // why a general reader of "line-cut" as "this task has a live line"
  // must treat the fix path as an exception.
  const line = reopenProductionLine({ project, taskId, recordHome });

  // Issue #235: the rebase this round is carrying while it is stopped -
  // declared out here so the `finally` below can name the conflict it
  // abandoned if something throws mid-round.
  let stopped: StoppedRebase | undefined;

  // inspector#53: what a publish of this branch may lease against, once
  // the rebase has genuinely rewritten it. Undefined until then, and
  // undefined again wherever the rebase is undone - a branch that was
  // not rewritten is published exactly as it always was.
  let lease: PublishLease | undefined;

  try {
    // Issue #235, before anything else this round does: bring the branch
    // up to origin's current default branch, on the host, with git only.
    // See fix-rebase.ts's header for the whole policy.
    const rebase = rebaseForFixRound(recordHome, taskId, line);
    // A conflict is handled in this same round: the rebase is left
    // stopped with the markers in the working tree, and the worker below
    // gets the Client's note and the conflicted file list in one brief.
    if (rebase.status === "handed-to-worker") stopped = rebase.stopped;
    // A rebase that went through in one go is already done moving the
    // branch, so its lease is knowable here; a stopped one's is not
    // (below, once the host has finished it).
    if (rebase.status === "rebased") lease = publishLeaseAfterRebase(line, rebase.tips);

    // After a rebase, origin's tip IS the branch's fork point, and the
    // delivery's `files` diff must be pinned to it - against the old
    // base it would list every file origin itself changed as this task's
    // work. `already-current` keeps the base it already had, which is
    // still an ancestor of the branch. While the rebase is stopped this
    // is where the branch is heading, and it only becomes true once the
    // host finishes it below - so an abort puts the old base back.
    let roundBaseCommit =
      rebase.status === "already-current"
        ? baseCommit
        : rebase.status === "rebased"
          ? rebase.baseCommit
          : rebase.stopped.baseCommit;

    /**
     * This round's brief for one pass of it. `extra` is whatever that
     * pass needs to know about the state it is being handed - a stopped
     * rebase's conflicted files (issue #235), or the code reader's own
     * findings (inspector issue #34) - appended after the Client's note.
     *
     * Factored out because this round now starts passes from two places:
     * the rebase loop below, and the reader's fix pass after it. Two
     * copies of this would be two places for the issue text, the
     * knowledge notes, the refusal correction or the red-checks
     * correction to go missing from one of them.
     *
     * Both standing extras (a refusal being answered, a pull request's own
     * red checks) apply to every pass of this round, so they are built in
     * here rather than passed: each describes a different part of the
     * state this worker is in, and they are joined rather than one
     * winning.
     *
     * Declared here rather than beside the round's other derived values
     * above because the test map's `touched` list is read off
     * `roundBaseCommit`, which is only known once the rebase has been
     * attempted - and is re-read on every call, since a rebase that
     * stops and is continued moves it mid-round (issue #142).
     */
    const briefFor = (extra?: string): string =>
      workerBrief(
        recordHome,
        line.project,
        buildFixBrief(
          // The issue this task names, and the project's knowledge notes,
          // ride along on a fix round too: the Client's note corrects the
          // work, it does not replace the request the issue spells out or
          // the notes the project stands on.
          withKnowledge(withIssueText(originalBrief, issueText), knowledgeNotes),
          note,
          [
            refusalReport !== undefined ? refusalCorrection(refusalReport) : undefined,
            redChecksOutput !== undefined ? checksCorrection(redChecksOutput) : undefined,
            extra,
          ]
            .filter((part): part is string => part !== undefined)
            .join("\n\n---\n\n") || undefined
        ),
        {
          testMap,
          // Unlike a first round, a fix round's branch already carries
          // this task's own diff - so its worker is handed the concrete
          // tests its touched files map to, and the concrete files that
          // map to nothing, instead of only the lookup rule.
          touched: diffFiles(line.project, line.branch, roundBaseCommit),
        }
      );

    const { judge: roundJudge, mode, reader } = prepareRound(recordHome, taskId, line, roundBaseCommit, {
      inspector,
      checkBox,
      closesIssue,
      checksReader,
      minter,
      // Read at each handoff, not now: on the conflict path the rebase
      // is still stopped at this point and `lease` is only settled once
      // the host has finished it, inside `beforeCommit` below.
      publishLease: () => lease,
    });
    // Captured before this round's worker ever runs: the branch's HEAD at
    // the exact commit the task's last round left it at (and so, in
    // Inspector mode, the exact commit Inspector last reviewed). Compared
    // against HEAD again once the attempt below has committed, so a round
    // whose worker made no change is caught before it is ever handed back
    // to a check or Inspector (`skipIfUnchanged`, judge.ts) - re-handing
    // the identical, already-reviewed commit only draws a refusal. Read
    // AFTER the rebase, so a round that only rebased is not mistaken for
    // one whose worker changed something.
    //
    // A stopped rebase has no such fixed point to compare against - HEAD
    // is detached mid-rebase and the host moves it again after the worker
    // returns - and there is nothing to protect against either way: the
    // commits are being replayed, so none of them is one Inspector has
    // already seen.
    //
    // A round answering a refusal is the other path the wrapper is
    // skipped on, and for the same reason read the other way round: a
    // refusal is Inspector reaching NO verdict, so the commit on this
    // branch was never reviewed, and handing it over again is exactly
    // the retry that can succeed - it is the only way an unpublished
    // green branch ever gets published. Left wrapped, a worker that
    // correctly changed nothing (the incomplete-publication case, where
    // it is told to do just that) would deliver "nothing-changed"
    // without Inspector ever being called again: the same dead end, one
    // step further along.
    const judge =
      stopped || refusalReport !== undefined
        ? roundJudge
        : skipIfUnchanged(roundJudge, line.workdir, baseCommitOf(line.workdir));

    // `...modelChoice` for the same reason do.ts's own work-started
    // carries it (issue #184): this round's declared model has to be on
    // the record from the moment it starts, not only once an attempt
    // has produced a receipt.
    appendEvent(recordHome, {
      taskId,
      name: "work-started",
      details: { verdict: "fix", project: line.project, ...modelChoice },
    });

    // This round's own earlier passes over a stopped rebase, kept so the
    // delivery's attempt count and declared gate changes still cover
    // every worker call the round made, not just the last one.
    const earlierReceipts: Receipt[] = [];
    const earlierGateDeclarations: string[] = [];
    let session = lastSession;

    // Once per task (inspector issue #34), read off the record: a task
    // whose earlier rounds never went green reaches its one and only
    // read here, in the fix round that finally does.
    const alreadyRead = alreadyReadFor(readEventsForTask(recordHome, taskId));

    // Issue #186: a fix round's worker box reaches the network under the
    // same per-project policy an ordinary round's does (do.ts's own call
    // site says why this wraps the whole loop), and every pass below is
    // one round's work, so one policy covers all of them - the code
    // reader's own fix pass at the end included.
    const round = await withTaskNetwork(networkPolicyFor(recordHome, taskId, line.project), async () => {
      // One `runAttempts` call per pass. Almost always exactly one: a
      // round whose rebase did not conflict, or whose worker resolved the
      // one conflict it was handed, never comes back here. A rebase that
      // stops again on a later commit hands THAT conflict to the same
      // warm worker (same session), in this same round, until it finishes
      // or `continueStoppedRebase` gives up - so one conflicted rebase
      // costs the Client one round, not one round per conflicting commit.
      const runRebasePasses = async (): Promise<AttemptLoopResult> => {
        for (;;) {
          const handed = stopped;
          // Set from inside `beforeCommit`, the only place that learns how
          // this pass's rebase ended.
          let step: FixRebaseStep | undefined;
          // Issue #235: the worker resolves markers in place (its own git
          // is read-only), so the host stages that resolution and continues
          // the rebase - and that has to happen before this attempt's own
          // commit, which assumes a branch the rebase has finished moving.
          // Returning a judgement means this attempt is judged on the
          // rebase alone, never committed and never handed to a check or
          // Inspector; it is the round's own judgement only when the loop
          // ends here, and is discarded when another pass follows.
          const beforeCommit = handed
            ? async (): Promise<Judgement | undefined> => {
                step = continueStoppedRebase(recordHome, taskId, line, handed);
                // `stopped` tracks what is in flight RIGHT NOW, for the
                // cleanup below: nothing, once the rebase finished or was
                // aborted; the new conflict, when it stopped again.
                if (step.status === "completed") {
                  stopped = undefined;
                  // The branch has only just stopped moving: this is the
                  // first moment its publish lease is knowable (and the
                  // last before this attempt commits on top of it).
                  lease = publishLeaseAfterRebase(line, rebase.tips);
                  return undefined;
                }
                if (step.status === "give-up") {
                  stopped = undefined;
                  // Aborted, so nothing was rewritten and there is nothing
                  // to lease - and this round publishes nothing anyway.
                  lease = undefined;
                  // Aborted: the branch is back at its own fork point, so
                  // that is what this round's delivery is pinned to again.
                  roundBaseCommit = baseCommit;
                  return {
                    kind: "rebase-conflicted",
                    base: handed.base,
                    reason: step.reason,
                    conflict: step.conflict,
                    stops: step.stops,
                  };
                }
                stopped = step.stopped;
                return {
                  kind: "rebase-conflicted",
                  base: handed.base,
                  // Honest only if this is where the round ends (a cap stop
                  // in the same pass) - otherwise the next pass replaces it.
                  reason: "round-ended",
                  conflict: step.stopped.conflict,
                  stops: step.stopped.stop,
                };
              }
            : undefined;

          const result = await runAttempts({
            brain,
            // Issue #142: the project's own settings decide whether this
            // brief also carries the only-touched-tests ruling. Resolved
            // here, the same way do.ts's round resolves it, so a fix round
            // and a first attempt can never disagree about it.
            brief: briefFor(handed ? rebaseConflictInstructions(handed) : undefined),
            workdir: line.workdir,
            taskId,
            judge,
            totalAttempts: 1,
            stopEarlyOnGreen: true,
            // Re-read per pass: each one's receipt is on the record by the
            // time the next starts, so rule 10's per-task cap still counts
            // every worker call this round made.
            spendLimits: spendLimitsFor(recordHome, taskId, caps),
            modelChoice,
            // Issue #189: a fix round is held to the same stop threshold as
            // any other - see do.ts for why this is read here rather than
            // threaded in like `caps`.
            pauseRule: { rule: pauseRuleFor(recordHome) },
            onReceipt: (receipt) => recordReceipt(recordHome, receipt),
            ...(session ? { initialSession: session } : {}),
            startAttempt: priorReceipts.length + earlierReceipts.length + 1,
            commitLabel: "(fix)",
            ...(beforeCommit ? { beforeCommit } : {}),
            onHeartbeat: (attempt) => {
              appendEvent(recordHome, { taskId, name: "heartbeat", details: { attempt } });
            },
            // Issue #199: a fix round's worker call is retried once on a
            // dropped connection exactly like any other, and recorded.
            onTransportRetry: (details) => {
              appendEvent(recordHome, { taskId, name: "transport-retry", details });
            },
            // Issue #70: fires as each entry is known, not once per attempt -
            // see runAttempts' own onTranscriptEntry doc for why every entry
            // lands here exactly once either way.
            onTranscriptEntry: (entry) => {
              appendTaskFile(recordHome, taskId, "transcript.log", `${JSON.stringify(entry)}\n`);
            },
          });

          // Another pass only when the rebase is genuinely still stopped
          // AND nothing else ended this round: a spending cap or the pause
          // rule stopping the loop must never be answered by calling the
          // worker again.
          if (step?.status !== "handed-again" || result.capStop || result.meterStop) return result;
          // `stopped` is already this pass's new conflict (set above).
          session = result.receipts.at(-1)?.session ?? session;
          earlierReceipts.push(...result.receipts);
          if (result.declaredGateChanges) earlierGateDeclarations.push(result.declaredGateChanges);
        }
      };

      const attemptsResult = await runRebasePasses();

      // After Inspector's green, the code reader reads the whole diff
      // and anything it flags comes back to this same warm worker before
      // the delivery is written (inspector issue #34). Inside this same
      // network policy, because it is one more worker call of this round.
      //
      // `roundJudge`, deliberately, not `judge`: `readAndFlag` does its
      // own `skipIfUnchanged` wrapping, and double-wrapping would be
      // harmless but misleading about which comparison matters.
      return readAndFlag(
        recordHome,
        taskId,
        {
          line,
          baseCommit: roundBaseCommit,
          mode,
          reader,
          alreadyRead,
          judge: roundJudge,
          ...(readDiff ? { read: readDiff } : {}),
          startAttempt: priorReceipts.length + earlierReceipts.length + attemptsResult.receipts.length + 1,
          fixPass: ({ correction, judge: passJudge, startAttempt, beforeCommit }) =>
            runAttempts({
              brain,
              brief: briefFor(correction),
              workdir: line.workdir,
              taskId,
              judge: passJudge,
              totalAttempts: 1,
              stopEarlyOnGreen: true,
              spendLimits: spendLimitsFor(recordHome, taskId, caps),
              modelChoice,
              pauseRule: { rule: pauseRuleFor(recordHome) },
              onReceipt: (receipt) => recordReceipt(recordHome, receipt),
              startAttempt,
              beforeCommit,
              commitLabel: "(reader)",
              // The same machine the ruling asks for: the worker that
              // just did this work, resumed, so it reads the findings
              // against what it did rather than rediscovering it.
              ...(attemptsResult.receipts.at(-1)?.session ?? session
                ? { initialSession: (attemptsResult.receipts.at(-1)?.session ?? session)! }
                : {}),
              onHeartbeat: (attempt) => {
                appendEvent(recordHome, { taskId, name: "heartbeat", details: { attempt } });
              },
              onTransportRetry: (details) => {
                appendEvent(recordHome, { taskId, name: "transport-retry", details });
              },
              onTranscriptEntry: (entry) => {
                appendTaskFile(recordHome, taskId, "transcript.log", `${JSON.stringify(entry)}\n`);
              },
            }),
        },
        attemptsResult
      );
    });

    // A rebase still in flight here is one the round ended underneath (a
    // cap stop, the pause rule): the branch goes back to its own last
    // commit before anything is delivered, so the delivery's `files` diff
    // and its "nothing was rewritten" promise describe the same reality.
    if (rebaseInProgress(line.workdir)) {
      abortRebase(line.workdir);
      if (stopped !== undefined) recordStop(recordHome, taskId, stopped, { left: "aborted", reason: "round-ended" });
      roundBaseCommit = baseCommit;
      lease = undefined;
    }

    // judge-commit-outcome-deliver-record: one shared tail (issue #182),
    // round.ts's recordRoundResult, also used by do.ts's productionRound.
    recordRoundResult(
      recordHome,
      taskId,
      line,
      {
        baseCommit: roundBaseCommit,
        taskText,
        totalAttempts,
        mode,
        caps,
        priorReceipts,
        // The rebase loop's own earlier passes, then whatever the reader
        // stage left earlier than the result being honoured - both are
        // this round's, in the order they happened.
        roundReceipts: [...earlierReceipts, ...round.earlierReceipts],
        priorGateDeclarations,
        roundGateDeclarations: [...earlierGateDeclarations, ...round.earlierGateDeclarations],
        testMap,
        ...(round.reader === undefined ? {} : { reader: round.reader }),
      },
      round.attempts
    );
  } finally {
    // Issue #235: a rebase must never outlive the round that started it.
    // Every path above already aborts its own, so reaching this with one
    // in flight means something threw mid-round - abort it here so the
    // branch is provably back at its own last commit before the worktree
    // (and with it the rebase state git keeps per worktree) is removed,
    // and say on the record that that is what happened.
    try {
      if (rebaseInProgress(line.workdir)) {
        abortRebase(line.workdir);
        if (stopped !== undefined) {
          recordStop(recordHome, taskId, stopped, { left: "aborted", reason: "round-failed" });
        }
      }
    } catch {
      // Teardown below force-removes the worktree, which takes the
      // rebase state with it and leaves the branch where it was anyway -
      // a failed abort must not mask the round's own error.
    }
    destroyProductionLine(line);
  }
}
