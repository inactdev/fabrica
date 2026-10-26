// Builds the Delivery block (SPEC.md "The delivery block") and its
// delivery.md rendering. This module only assembles the object — do.ts
// calls src/delivery's validateDelivery on the result before treating it
// as real (CONTRACT rule 4, issue #9).

import type { GateResult } from "../../contract/surface.ts";
import type { RebaseConflict } from "../line/index.ts";
// Type only, so this stays a one-way runtime dependency: fix-rebase.ts
// calls the builder below, not the other way round.
import type { ConflictReportReason } from "./fix-rebase.ts";
import type { Delivery, Inspection } from "../inspector/types.ts";
import { gateForRecord } from "./attempts.ts";
import type { CapStop } from "./attempts.ts";
import { formatUsd, SPEND_UNKNOWN_LINE } from "./spend.ts";
import { formatPercent } from "./meters.ts";
import { SELF_TESTED } from "./judge.ts";
import { describeFingerprint } from "./fingerprint.ts";
import { describeInvalidWriteup } from "./pr-body.ts";
import { describeTestMapReport } from "../testmap/index.ts";
import type { TestMapReport } from "../testmap/index.ts";
import { describeRead } from "../reader/index.ts";
import type { ReaderOnDelivery } from "../reader/index.ts";

/**
 * How many lines of a check's output a delivery's `evidence` shows. The
 * tail is the larger half for the same reason `gateForRecord` keeps the
 * tail rather than the head: a check announces what failed at the end.
 */
export const EVIDENCE_HEAD_LINES = 5;
export const EVIDENCE_TAIL_LINES = 15;

/**
 * A delivery's `evidence` for a check that reached a verdict (issue #68,
 * Client ruling 2026-10-22): a pointer to the receipt that holds the
 * output, plus the first and last few lines so the report still reads on
 * its own.
 *
 * The receipt is the source. The same text used to be stored twice - once
 * as the receipt's `checks.output` and once here - and every later
 * `"delivered"` event of the same task re-stored this copy, while
 * `src/record/read.ts` parses the whole file for every query. The copy
 * was weighed against keeping it ("a delivery is meant to stand on its
 * own and travel to the Client as one readable thing") and the pointer
 * plus excerpt was chosen as what satisfies both.
 *
 * `attempt` is the attempt whose receipt holds it. Undefined means the
 * caller could not name one, in which case the output is shown as it was
 * stored rather than pointing at a receipt that may not exist - never
 * less than before.
 */
export function checkEvidence(gate: GateResult | undefined, attempt: number | undefined): string {
  if (gate === undefined) return "No check reached a verdict.";
  const output = gateForRecord(gate).output;
  if (attempt === undefined) return output;

  const lines = output.split("\n");
  // A trailing newline leaves an empty last element that is not a line of
  // output; dropping it keeps the excerpt's own count honest.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const where =
    `Full check output: on attempt ${attempt}'s receipt in this task's record (its "receipt-recorded" ` +
    `event).`;
  if (lines.length <= EVIDENCE_HEAD_LINES + EVIDENCE_TAIL_LINES) {
    return `${where} It ran as:\n\n${lines.join("\n")}`;
  }
  const dropped = lines.length - EVIDENCE_HEAD_LINES - EVIDENCE_TAIL_LINES;
  const excerpt = [
    ...lines.slice(0, EVIDENCE_HEAD_LINES),
    `[... ${dropped} line(s) not shown here - the receipt has them ...]`,
    ...lines.slice(lines.length - EVIDENCE_TAIL_LINES),
  ];
  return `${where} Its first ${EVIDENCE_HEAD_LINES} and last ${EVIDENCE_TAIL_LINES} lines:\n\n${excerpt.join("\n")}`;
}

/** Where a task stands once this outcome is delivered: anything handed to
 * the Client for a ruling is "delivered"; the rest are honest failures. */
export function deliveredState(outcome: Delivery["outcome"] | undefined): "delivered" | "failed" {
  return outcome === "done" ||
    outcome === "inspection-red" ||
    outcome === "not-verified" ||
    outcome === "nothing-changed" ||
    // Issue #189: a meter pause waits on the Client's own `fix` verdict
    // to resume (nothing resumes it by itself, Client's clarification),
    // which is exactly what "delivered" already means here - and it is
    // explicitly never a failure. `fabrica status` names the pause on
    // the line itself, so "delivered" never has to stand in for the
    // reason.
    outcome === "paused-by-meter"
    ? "delivered"
    : "failed";
}

export function buildDelivery(
  outcome: Delivery["outcome"],
  ctx: {
    taskText: string;
    attempts: number;
    /** The last red or green verdict - absent when none was reached. */
    lastGate: GateResult | undefined;
    /** The attempt whose receipt holds `lastGate`'s output in full - what
     * `evidence` points at instead of copying the text (issue #68). */
    evidenceAttempt?: number;
    branch: string;
    files: string[];
    declaredGateChanges: string | undefined;
    inspection?: Inspection;
    /** No Inspector: the check ran in the worker's own box (issue #64). */
    selfTested?: boolean;
    /** Required for outcome "not-verified": why the box could not run it. */
    notVerifiedReason?: string;
    /** Required for outcome "cap-stopped": what stopped it. */
    capStop?: CapStop;
    taskId?: string;
    /** Rule 10: true when a cap is set and some attempt of this task has
     * an unknown cost - the report then says new work is blocked. */
    spendUnknownUnderCap?: boolean;
    /** Set when the last attempt's write-up was missing or invalid: the
     * failure report says so, and that no check judged it. */
    writeupInvalid?: string;
    /** Issue #267: set when the round is red because the checks the
     * repository runs on the pull request went red after Inspector had
     * already called the branch green - the one-phrase summary of them.
     * The outcome is still `inspection-red` (it is a red result waiting
     * on the Client's verdict, which is what that outcome means), but the
     * wording must say what actually went red: Inspector said green, and
     * a report claiming otherwise would send the Client to the wrong
     * log. */
    ciRed?: string;
  }
): Delivery {
  if (outcome === "cap-stopped") return buildCapStoppedDelivery(ctx);
  if (outcome === "not-verified") return buildNotVerifiedDelivery(ctx);
  if (outcome === "failure-report" && ctx.writeupInvalid !== undefined) return buildWriteupInvalidDelivery(ctx);

  const summary =
    outcome === "done"
      ? `Completed: ${ctx.taskText}`
      : outcome === "failure-report"
        ? `The project's check did not pass after ${ctx.attempts} attempt(s).`
        : ctx.ciRed !== undefined
          ? `The pull request's own checks went red after ${ctx.attempts} attempt(s): ${ctx.ciRed}.`
          : `Inspector reported the committed branch red after ${ctx.attempts} attempt(s).`;

  const evidence = checkEvidence(ctx.lastGate, ctx.evidenceAttempt);

  const gaps =
    outcome === "failure-report"
      ? "The project's check did not pass; see evidence for the failure output."
      : outcome === "inspection-red"
        ? ctx.ciRed !== undefined
          ? "Inspector called this branch green and published it; the checks the repository itself runs on the " +
            "pull request then went red. See evidence for each red check and the end of its job log. A fix " +
            "verdict hands that same output back to the worker."
          : "Inspector could not reach green after its mechanical repairs. The Client can give a fix verdict for work that needs the request's context."
        : "";

  // No Inspector: the builder checked the builder. Said plainly, and the
  // push is left to the Client rather than done for him.
  const selfTestNote =
    ctx.selfTested && outcome === "done"
      ? `${SELF_TESTED}. Pushing it is your choice: \`git push origin ${ctx.branch}\`.`
      : "";

  const spendNote = ctx.spendUnknownUnderCap
    ? `${SPEND_UNKNOWN_LINE}: this task's cost was never measured. Record it with ` +
      `\`fabrica cost ${ctx.taskId} <usd>\` before new work can start.`
    : "";

  return {
    outcome,
    confidence: outcome === "done" ? 100 : 0,
    summary,
    evidence,
    assumptions: "",
    gaps: [gaps, selfTestNote, spendNote].filter(Boolean).join("\n\n"),
    branch: ctx.branch,
    files: ctx.files,
    gateChanges: ctx.declaredGateChanges ?? "",
    ...(ctx.inspection === undefined ? {} : { inspection: ctx.inspection }),
  };
}

/** A round that ended on a missing or invalid write-up: the worker's own
 * failure, found before any check ran - never an Inspector red, and never
 * "the check did not pass". */
function buildWriteupInvalidDelivery(ctx: {
  attempts: number;
  branch: string;
  files: string[];
  declaredGateChanges: string | undefined;
  writeupInvalid?: string;
}): Delivery {
  const summary = describeInvalidWriteup(ctx.writeupInvalid!);
  return {
    outcome: "failure-report",
    confidence: 0,
    summary,
    evidence: `${summary} (attempt ${ctx.attempts}).`,
    assumptions: "",
    gaps:
      "The last attempt returned no valid write-up, so it was never checked. Its work is committed on " +
      `\`${ctx.branch}\`; give a fix verdict to have the worker write it up.`,
    branch: ctx.branch,
    files: ctx.files,
    gateChanges: ctx.declaredGateChanges ?? "",
  };
}

/** The self-tested path's honest report when the worker's box could not
 * run the check at all (a missing toolchain, no Docker): nothing judged
 * this work, which is said as exactly that - never dressed up as red. */
function buildNotVerifiedDelivery(ctx: {
  attempts: number;
  branch: string;
  files: string[];
  declaredGateChanges: string | undefined;
  notVerifiedReason?: string;
}): Delivery {
  const reason = ctx.notVerifiedReason ?? "unknown reason";
  return {
    outcome: "not-verified",
    confidence: 0,
    summary: `Not verified: the worker's box could not run the check - ${reason.split("\n")[0]}`,
    evidence: reason,
    assumptions: "",
    gaps:
      "Nothing checked this work: no Inspector is configured, and the worker's box could not run the " +
      `project's check. The work is committed on \`${ctx.branch}\` for you to check by hand, or give the ` +
      "box what the check needs and give a fix verdict.",
    branch: ctx.branch,
    files: ctx.files,
    gateChanges: ctx.declaredGateChanges ?? "",
  };
}

/** Rule 10's honest report for a task a cap stopped: it says the cap
 * stopped it, with the numbers, and is never worded as the work having
 * failed. The work so far is committed on the branch like any outcome. */
function buildCapStoppedDelivery(ctx: {
  attempts: number;
  lastGate: GateResult | undefined;
  evidenceAttempt?: number;
  branch: string;
  files: string[];
  declaredGateChanges: string | undefined;
  capStop?: CapStop;
  taskId?: string;
}): Delivery {
  const stop = ctx.capStop!;
  const lastCheck = ctx.lastGate
    ? `The last check (attempt ${stop.attempt}) was ${ctx.lastGate.green ? "green" : "red"}.`
    : "No check reached a verdict.";
  const summary =
    stop.reason === "spend-unknown"
      ? `${SPEND_UNKNOWN_LINE}. Stopped after attempt ${stop.attempt}: its cost was never measured, and a ` +
        "spending cap is set, so the task stopped rather than spend money nobody can count."
      : `Stopped by the per-task cap of ${formatUsd(stop.capUsd!)}: this task has spent ${formatUsd(stop.spentUsd)} ` +
        `over ${ctx.attempts} attempt(s), so no further attempt was started.`;
  const gaps =
    stop.reason === "spend-unknown"
      ? `A cap stopped this task, not its work. ${lastCheck} New work stays blocked until the real cost is ` +
        `recorded with \`fabrica cost ${ctx.taskId} <usd>\`. The work so far is committed on \`${ctx.branch}\`.`
      : `A cap stopped this task, not its work. ${lastCheck} The work so far is committed on \`${ctx.branch}\`. ` +
        "To continue, raise [caps].perTaskUsd in projects.toml, then give a fix verdict.";
  return {
    outcome: "cap-stopped",
    confidence: 0,
    summary,
    evidence: checkEvidence(ctx.lastGate, ctx.evidenceAttempt),
    assumptions: "",
    gaps,
    branch: ctx.branch,
    files: ctx.files,
    gateChanges: ctx.declaredGateChanges ?? "",
  };
}

/**
 * A `Delivery` for a round the pause rule stopped in flight (issue
 * #189): the 7-day subscription window was past its stop threshold, so
 * the attempt was stopped gracefully rather than run the week down.
 *
 * Worded, deliberately, the way `buildCapStoppedDelivery` words its
 * own: a limit stopped the work, which is not the same as the work
 * having failed (Client's clarification: "recorded as its own outcome,
 * paused-by-meter, never as a failure"). Nothing resumes it by itself -
 * the Client's `fix` verdict does, once the window has rolled forward
 * or he has raised the threshold. There is no check output to report,
 * honestly, because nothing was ever judged.
 */
export function buildPausedByMeterDelivery(ctx: {
  attempts: number;
  branch: string;
  files: string[];
  declaredGateChanges: string | undefined;
  pause: { usedPercent: number; thresholdPercent: number; attempt: number; message: string; workerStopped: boolean };
}): Delivery {
  const stopped = ctx.pause.workerStopped
    ? `The worker was stopped gracefully during attempt ${ctx.pause.attempt}.`
    : `Nothing could be asked to stop the worker, so attempt ${ctx.pause.attempt} ran to its own end; the ` +
      `round stopped there.`;
  return {
    outcome: "paused-by-meter",
    confidence: 0,
    summary: ctx.pause.message,
    evidence:
      `7-day subscription window: ${formatPercent(ctx.pause.usedPercent)} used, stop threshold ` +
      `${formatPercent(ctx.pause.thresholdPercent)}. ${stopped} Nothing was handed to a check or to Inspector.`,
    assumptions: "",
    gaps:
      `A limit stopped this task, not its work. Whatever the worker had done is committed on ` +
      `\`${ctx.branch}\`, unreviewed and unchecked. Nothing restarts by itself: give a fix verdict once the ` +
      `window has rolled forward, or raise [pause].sevenDayStopPercent in projects.toml to continue now.`,
    branch: ctx.branch,
    files: ctx.files,
    gateChanges: ctx.declaredGateChanges ?? "",
  };
}

/**
 * A `Delivery` for the one path `buildDelivery` above doesn't cover: the
 * pre-teardown commit itself failed (a stale `.git/index.lock`, a full
 * disk, a read-only mount) and there is no branch content or check
 * outcome left to describe honestly the usual way. Reuses the
 * `failure-report` outcome rather than adding a new one to the contract
 * type - Client ruling (PR #54 follow-up), scoped minimally: the record
 * must always say what happened, not add retry machinery. `files` is
 * always `[]` here: a failed commit means nothing landed on the branch.
 */
export function buildCommitFailureDelivery(ctx: {
  attempts: number;
  lastGate: GateResult | undefined;
  evidenceAttempt?: number;
  branch: string;
  declaredGateChanges: string | undefined;
  error: string;
}): Delivery {
  return {
    outcome: "failure-report",
    confidence: 0,
    summary:
      `The Worker's changes could not be committed onto the branch ` +
      `after ${ctx.attempts} attempt(s).`,
    evidence: ctx.lastGate
      ? `Last check: ${checkEvidence(ctx.lastGate, ctx.evidenceAttempt)}`
      : "No check reached a verdict.",
    assumptions: "",
    gaps:
      `Committing the Worker's changes onto \`${ctx.branch}\` failed: ${ctx.error}. The throwaway ` +
      "workspace is destroyed regardless of outcome, so nothing survived to hand over - this is a " +
      "host environment failure (a stale lock file, a full disk, a read-only mount), not something " +
      "the Worker or the project's checks caused. Retrying the task from scratch is the only recovery.",
    branch: ctx.branch,
    files: [],
    gateChanges: ctx.declaredGateChanges ?? "",
  };
}

/**
 * A `Delivery` for a fix round whose worker left the branch exactly where
 * it already was - no new commit versus what this round's line was
 * reopened at. `verdict.ts`'s `skipIfUnchanged` (`judge.ts`) already kept
 * this round from ever handing that same commit back to Inspector (which
 * would only draw a refusal, since Inspector already reviewed it) or
 * re-running a self-test check that could only repeat its last answer -
 * so there is no check output to report, honestly, rather than a
 * fabricated green or red.
 */
export function buildNothingChangedDelivery(ctx: {
  attempts: number;
  branch: string;
  files: string[];
  declaredGateChanges: string | undefined;
}): Delivery {
  return {
    outcome: "nothing-changed",
    confidence: 100,
    summary: "Nothing changed: this round's worker left the branch exactly where it already was.",
    evidence:
      "No new commit landed this round, so nothing was handed to a check or Inspector - the branch is " +
      "identical to what was already reviewed.",
    assumptions: "",
    gaps:
      `The work from earlier rounds is still committed on \`${ctx.branch}\` and unchanged. Give a fix ` +
      "verdict again with a clearer correction if more work is needed, or rule accept/wrong to close it.",
    branch: ctx.branch,
    files: ctx.files,
    gateChanges: ctx.declaredGateChanges ?? "",
  };
}

/**
 * A `Delivery` for a fix round whose branch could not be brought up to
 * origin's current default branch (issue #235): the round's own worker
 * was handed the stopped rebase with the Client's note and the conflict
 * is still unresolved, so it goes to him as `inspection-red` to rule on.
 * Red rather than a failure report because this is work waiting on his
 * judgment, not the machine having failed at something it could retry -
 * `deliveredState` puts `inspection-red` in front of him, which is the
 * whole point.
 *
 * The branch is always back at its own last commit by the time this is
 * built (`fix-rebase.ts`'s `continueStoppedRebase` aborts before the
 * report is written), so nothing was rewritten and the `files` diff still
 * describes the task's own work. `evidence` carries the conflict markers
 * themselves, capped per `MAX_CONFLICT_LINES_PER_FILE`/`_TOTAL` and
 * saying so where a cap cut something.
 */
export function buildRebaseConflictDelivery(ctx: {
  branch: string;
  files: string[];
  declaredGateChanges: string | undefined;
  /** origin's default branch name, e.g. "main". */
  base: string;
  conflict: RebaseConflict;
  /** Why the host stopped trying - the worker left markers behind, the
   * rebase kept stopping on fresh conflicts past the round's ceiling, or
   * the round itself ended underneath it. Three different sentences: the
   * first is about this worker's resolution, the second about a branch
   * that has drifted too far to replay at all, the third about nothing to
   * do with the conflict. */
  reason: ConflictReportReason;
  /** How many times this round's rebase stopped on a conflict - the
   * number itself, so this wording never has to name the ceiling
   * `fix-rebase.ts` owns. */
  stops: number;
}): Delivery {
  const count = ctx.conflict.files.length;
  const files = `${count} file${count === 1 ? "" : "s"}`;
  const summary =
    ctx.reason === "markers-remain"
      ? `Rebasing \`${ctx.branch}\` onto origin/${ctx.base} still conflicts in ${files} after the worker's attempt.`
      : ctx.reason === "too-many-stops"
      ? `Rebasing \`${ctx.branch}\` onto origin/${ctx.base} stopped on a conflict ${ctx.stops} times in one ` +
        `round, and ${files} are still conflicted.`
      : `Rebasing \`${ctx.branch}\` onto origin/${ctx.base} was still unfinished when this round stopped, ` +
        `with ${files} conflicted.`;
  const instruction =
    ctx.reason === "markers-remain"
      ? "The worker had your note and the conflicted file list and did not resolve every marker. Give a fix " +
        "verdict with more specific instructions to hand it the stopped rebase again, or rule wrong to close it."
      : ctx.reason === "too-many-stops"
      ? "The worker resolved every stop it was handed and the rebase stopped on yet another commit. Give a fix " +
        "verdict saying how to resolve this branch against origin, or rule wrong to close it and start the work " +
        "again from today's default branch."
      : "This round stopped for a reason of its own before the rebase could be finished - the record says " +
        "which. Give a fix verdict once that is cleared, and the round starts by rebasing afresh.";
  return {
    outcome: "inspection-red",
    confidence: 0,
    summary,
    evidence: [`Conflicted files:`, ...ctx.conflict.files.map((path) => `  ${path}`), "", ctx.conflict.markers].join(
      "\n"
    ),
    assumptions: "",
    gaps:
      `origin/${ctx.base} has moved on, and the task's own commits do not replay cleanly on top of it. ` +
      `Nothing was rewritten: \`${ctx.branch}\` is exactly where it was, and the rebase was aborted. ` +
      `${instruction}`,
    branch: ctx.branch,
    files: ctx.files,
    gateChanges: ctx.declaredGateChanges ?? "",
    // Deliberately no `inspection`: that field means "this branch was
    // handed to Inspector" (src/inspector/types.ts), and this branch
    // never was - the round stopped before any worker or judge ran. The
    // markers are the delivery's own `evidence` instead, which is what
    // `delivery.md` and the review page already show as the report.
  };
}

/**
 * `delivery` carrying this round's test-map report, or `delivery`
 * untouched when the project commits no `tests.map`.
 *
 * A decoration applied beside each build site rather than a parameter
 * every builder takes: there are seven builders in this file and one
 * more in `fix-rebase.ts`, every one of them already reports the same
 * `files` diff, and the report is derived from exactly that - so one
 * function keeps all of them in step without eight signatures growing a
 * field none of their own wording uses.
 */
export function withTestMapReport(delivery: Delivery, report: TestMapReport | undefined): Delivery {
  return report === undefined ? delivery : { ...delivery, tests: report };
}

/** Human-readable rendering of a Delivery (SPEC.md's field order), for
 * `delivery.md` — a convenience view; the "delivered" event's `details`
 * carries the structured object deliveryOf() actually reads.
 *
 * The read and the test-map block go last, after `gateChanges` and the
 * one-line `fingerprint`: they are the two parts of a delivery that run
 * to several lines of their own, and the fields above them are the ones
 * every reader scans for first. */
export function renderDeliveryMarkdown(delivery: Delivery, cost?: string): string {
  const tests = describeTestMapReport(delivery.tests);
  return (
    [
      ...(cost === undefined ? [] : [`cost:       ${cost}`]),
      `confidence: ${delivery.confidence}`,
      `summary:    ${delivery.summary}`,
      `evidence:   ${delivery.evidence}`,
      `inspection: ${delivery.inspection ? `${delivery.inspection.verdict}: ${delivery.inspection.report}` : ""}`,
      `assumptions: ${delivery.assumptions}`,
      `gaps:       ${delivery.gaps}`,
      `branch:     ${delivery.branch}`,
      `files:      ${delivery.files.join(", ")}`,
      `gateChanges: ${delivery.gateChanges}`,
      // The one wording every surface shows, from the one function
      // (`fingerprint.ts`'s `describeFingerprint`) - `fabrica status`
      // and `fabrica log` render the identical string.
      `fingerprint: ${describeFingerprint(delivery.fingerprint, delivery.fingerprintMatch)}`,
      // The two blocks that can run to several lines of their own go
      // last, after every one-line fact, so the facts above them stay
      // scannable as a column: the read (one line plus a line per
      // finding), then the test-map report.
      `reader:     ${delivery.reader ? renderRead(delivery.reader) : ""}`,
      ...(tests.length === 0 ? [] : [`tests:\n${tests}`]),
    ].join("\n") + "\n"
  );
}

/** The read as `delivery.md` shows it: the one-phrase summary every
 * other surface shows (`describeRead`), then one indented line per
 * finding with the worker's reason beneath any it declined - which is
 * what "recorded in the delivery beside the finding" means in a
 * plain-text view. Never a verdict line: there is no verdict to show. */
function renderRead(read: ReaderOnDelivery): string {
  const lines = [describeRead(read)];
  read.findings.forEach((finding, index) => {
    lines.push(`  ${index + 1}. ${finding.file}: ${finding.finding}`);
    if (finding.declined !== undefined) lines.push(`     declined by the worker: ${finding.declined}`);
  });
  if (read.note !== undefined) lines.push(`  note: ${read.note}`);
  return lines.join("\n");
}

/** Puts the read onto a delivery the builders above have finished with.
 * One place rather than a `reader` parameter on all five of them: the
 * read is not an input to what any of them decides - it never moves an
 * outcome, a confidence or a summary, because the reader does not block
 * and does not approve - so threading it through their arguments would
 * imply a say it deliberately does not have. */
export function withRead(delivery: Delivery, read: ReaderOnDelivery | undefined): Delivery {
  return read === undefined ? delivery : { ...delivery, reader: read };
}
