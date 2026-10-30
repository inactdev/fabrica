// Who judges each attempt (issue #64, Client ruling 2026-10-08). Fabrica
// runs no project check on the host - the check command is a file the
// worker just edited. Two modes, chosen once per round:
//
//   a. "inspector": Inspector is installed and the task's base commit has
//      .inspector.json. Each attempt's work is committed and handed to
//      Inspector, whose containerized run is the verdict. Fabrica runs
//      nothing itself.
//   b. "self-test": otherwise. The project's check runs once per attempt
//      inside the worker's own box (CheckBox), never on the host. That is
//      the builder checking the builder - the delivery says so.

import { appendEvent } from "../record/index.ts";
import { defaultInspector, inspectorIsConfigured } from "../inspector/index.ts";
import { checksOutputForWorker, isRedReport } from "../ci/index.ts";
import type { ChecksReport } from "../ci/index.ts";
import { handToPullRequestChecks } from "./ci-checks.ts";
import type { ChecksReader } from "./ci-checks.ts";
import { defaultCheckBox } from "../brain/index.ts";
import type { CheckBox } from "../brain/index.ts";
import type { GateResult, ProductionLine } from "../../contract/surface.ts";
import type { RebaseConflict } from "../line/index.ts";
// Type only: this module is a judgement's shape, not the rebase policy.
import type { ConflictReportReason, PublishLease } from "./fix-rebase.ts";
import type { Inspection, Inspector } from "../inspector/index.ts";
import type { ResolvedReviewer } from "../reviewer/index.ts";
import type { Delivery } from "../inspector/types.ts";
import type { ScopedToken, TokenMinter } from "../githubapp/index.ts";
import { publishToken } from "./github-token.ts";
import { requireCheckCommand, resolveCheckCommand } from "./resolve-check.ts";
import { readerForRound } from "./reader.ts";
import type { RoundReader } from "./reader.ts";
import { requireReviewer } from "./reviewer.ts";
import { requireInspectorConfig } from "./inspector-config.ts";
import { ForemanError } from "./errors.ts";
import { handToInspector } from "./inspection.ts";
import { withClosesLine } from "./pr-body.ts";
import type { ClosesIssue, FinalMessageForCommit } from "./pr-body.ts";
import { baseCommitOf } from "../delivery/index.ts";

/** One attempt's judgement. Only "verdict" is a red or green result; the
 * rest stop the loop with no verdict at all. */
export type Judgement =
  | {
      kind: "verdict";
      gate: GateResult;
      inspection?: Inspection;
      /** Set when the attempt is red because its write-up was missing or
       * invalid (attempts.ts) - never judged at all. */
      writeupInvalid?: string;
      /** Issue #267: set when this attempt is red because the checks the
       * repository runs on the pull request itself went red, AFTER
       * Inspector had already called the branch green. The value is the
       * one-phrase summary (`src/ci/report.ts`'s `summarizeChecks`), so
       * the delivery can say what actually went red instead of blaming
       * Inspector for a verdict it did not reach. */
      ciRed?: string;
    }
  /** Inspector reached no verdict. */
  | { kind: "refused"; inspection: Inspection }
  /** The worker's box could not run the check - not verified, not red. */
  | { kind: "not-verified"; reason: string }
  /** Committing the attempt failed (a host problem). */
  | { kind: "commit-failed"; error: string }
  /** The branch has no new commit versus where this round started - never
   * judged at all (`skipIfUnchanged` below), so there is nothing for a
   * check or Inspector to say. */
  | { kind: "unchanged" }
  /** The stopped rebase this round's worker was handed (issue #235) could
   * not be finished: markers were still in the working tree, the rebase
   * kept stopping on fresh conflicts past the round's ceiling
   * (`fix-rebase.ts`'s `MAX_REBASE_STOPS_PER_ROUND`), or the round ended
   * underneath it. The rebase is aborted by the time the round records
   * this, so the branch is back at its own last commit; nothing was
   * committed and nothing was judged. `stops` is how many times that
   * rebase stopped in all. */
  | { kind: "rebase-conflicted"; base: string; reason: ConflictReportReason; conflict: RebaseConflict; stops: number }
  /** Issue #189: a subscription meter past its stop threshold stopped
   * this attempt mid-flight, so nothing was ever handed to a check or
   * to Inspector. `round.ts` branches on `attempts.meterStop` itself
   * (which carries the numbers); this exists so the loop's own
   * `lastJudgement` is never a judgement that did not happen. */
  | { kind: "paused-by-meter" };

export type Judge = (attempt: number, gateChanges: string | undefined, finalMessage: FinalMessageForCommit) => Promise<Judgement>;

export type CheckMode = { mode: "inspector"; inspector: Inspector } | { mode: "self-test"; reason: string };

/** Mode a when Inspector can run and the base commit asks for it; mode b
 * otherwise - never a refusal (Client ruling: no Inspector still works,
 * the Client is just the only reviewer). */
export function chooseCheckMode(
  line: ProductionLine,
  baseCommit: string,
  inspector: Inspector | undefined,
  /** Who judges this project's test changes, when one is configured
   * (src/reviewer/resolve.ts) - handed to the real Inspector adapter
   * as `-vendor`/`-model` plus that vendor's key on its environment. A
   * caller-supplied Inspector (a test's fake) is used as given. */
  reviewer?: ResolvedReviewer,
  /** Where the real adapter's publishing token is minted from (issue
   * #187): this task's repository alone, `contents: write` plus
   * `pull_requests: write` and `statuses: write`, one token per handoff. A caller-supplied
   * Inspector (a test's fake) needs none - it publishes nothing. */
  token?: ScopedToken
): CheckMode {
  if (!inspectorIsConfigured(line.workdir, baseCommit)) {
    return { mode: "self-test", reason: "no .inspector.json at the task base commit" };
  }
  const chosen =
    inspector ??
    defaultInspector({
      ...(reviewer === undefined ? {} : { reviewer }),
      ...(token === undefined ? {} : { token }),
    });
  if (chosen.installed && !chosen.installed()) return { mode: "self-test", reason: "Inspector is not installed" };
  return { mode: "inspector", inspector: chosen };
}

/** The exact words a self-tested delivery carries (issue #64, mode b). */
export const SELF_TESTED = "self-tested in the worker's box; no Inspector; not independently checked";

/** A shell exit status meaning the box lacks a command the check needs. */
const COMMAND_NOT_FOUND = 127;

export function inspectorJudge(
  recordHome: string,
  taskId: string,
  line: ProductionLine,
  baseCommit: string,
  inspector: Inspector,
  /** The issue this task's pull request should close (issue "make every
   * pull request it opens close its issue on merge"), or undefined when
   * this task is not the whole of one issue's work. Resolved once per
   * round by the caller (do.ts/verdict.ts) via pr-body.ts's
   * `closesIssueFor` and applied only to the body Inspector is asked to
   * open the pull request with - never to the commit message itself. */
  closesIssue?: ClosesIssue,
  /** Asked once per handoff, not resolved up front (inspector#53): a fix
   * round whose rebase stopped on a conflict only finishes moving the
   * branch after this judge already exists, so the lease its publish may
   * be made under is not knowable when the round is prepared. Undefined,
   * or a call that answers undefined, means no lease - see
   * fix-rebase.ts's `publishLeaseAfterRebase`. */
  publishLease?: () => PublishLease | undefined,
  /** Issue #267. Omitted uses the real GitHub read; a test supplies a
   * fake. Reached only after a green inspection that printed a pull
   * request URL - nothing else has a pull request to read. */
  checksReader?: ChecksReader,
  /** Issue #187: only reached when `checksReader` is omitted, to mint
   * the one scoped token that whole read uses. */
  minter?: TokenMinter
): Judge {
  return async (_attempt, _gateChanges, finalMessage) => {
    const lease = publishLease?.();
    // attempts.ts has already committed this attempt with this same
    // write-up as its message, and only calls judge() when the write-up is
    // valid - so the commit Inspector diffs and the pull request it may
    // open never disagree about what this attempt calls itself.
    const inspection = (await handToInspector(recordHome, taskId, line, baseCommit, inspector, {
      prTitle: finalMessage.title,
      prBody: withClosesLine(finalMessage.body, closesIssue),
      ...(lease ? { publishLease: lease } : {}),
    }))!;
    if (inspection.verdict === "refused") return { kind: "refused", inspection };
    const gate: GateResult = {
      green: inspection.verdict === "green",
      output: `check: delegated to Inspector - Inspector reported ${inspection.verdict}:\n${inspection.report}`,
    };
    // Issue #267: Inspector's green is not the last word any more. What
    // the repository itself runs on the pull request - the protected-path
    // gate, a formatter, a container rehearsal - happens after Inspector
    // has pushed, and used to be invisible here: the task read
    // "delivered" while the pull request page read red, and the only way
    // the failure reached anyone was the Client opening the job himself.
    //
    // Read only after a GREEN inspection that printed a pull request URL.
    // A red or refused inspection published nothing, so there is no pull
    // request whose checks could say anything about this attempt; and a
    // green run that opened nothing (no URL on Inspector's stdout) has no
    // pull request either.
    if (inspection.verdict !== "green" || !inspection.prUrl) return { kind: "verdict", gate, inspection };

    const report = await handToPullRequestChecks(
      recordHome,
      taskId,
      line.project,
      inspection.prUrl,
      checksReader,
      minter
    );
    // Nothing to read (not a GitHub pull request URL), or nothing red:
    // Inspector's own verdict stands, and the read is already on the
    // record either way. An unreadable API and a check that never
    // concluded both land here on purpose - inventing a red out of a
    // silence is the same lie as calling it green.
    if (report === undefined || !isRedReport(report)) {
      return {
        kind: "verdict",
        gate: report === undefined ? gate : { green: gate.green, output: `${gate.output}\n\n${checksNote(report)}` },
        inspection,
      };
    }
    return {
      kind: "verdict",
      gate: { green: false, output: `${gate.output}\n\n${checksOutputForWorker(report)}` },
      inspection,
      ciRed: report.summary,
    };
  };
}

/** One line about a read that did not turn the round red, appended to the
 * gate's output - which is what the delivery's `evidence` carries, so a
 * green delivery still says what the pull request's checks did (or that
 * they could not be read, or had not finished). Never silently omitted:
 * a delivery that says nothing about them reads as "there were none". */
function checksNote(report: ChecksReport): string {
  return `${CHECKS_PREFIX}: ${report.summary} (${report.prUrl})`;
}

/** The exact words a delivery's evidence uses for the pull request's own
 * checks. Kept here beside the one writer of it. */
const CHECKS_PREFIX = "the pull request's own checks";

export function selfTestJudge(
  recordHome: string,
  taskId: string,
  line: ProductionLine,
  check: string,
  box: CheckBox
): Judge {
  return async (attempt) => {
    appendEvent(recordHome, { taskId, name: "check-run", details: { attempt, phase: "started", where: "worker's box" } });
    const result = await box(line.workdir, check);
    if (!result.ran) {
      appendEvent(recordHome, { taskId, name: "check-run", details: { attempt, notVerified: result.reason } });
      return { kind: "not-verified", reason: result.reason };
    }
    if (result.exitCode === COMMAND_NOT_FOUND) {
      const reason = `the box has no command the check needs (${check} -> exit ${COMMAND_NOT_FOUND})\n${result.output}`;
      appendEvent(recordHome, { taskId, name: "check-run", details: { attempt, notVerified: reason } });
      return { kind: "not-verified", reason };
    }
    const gate: GateResult = {
      green: result.exitCode === 0,
      output: `${SELF_TESTED}: ${check} -> exit ${result.exitCode}${result.output ? `\n${result.output}` : ""}`,
    };
    appendEvent(recordHome, { taskId, name: "check-run", details: { attempt, green: gate.green } });
    return { kind: "verdict", gate };
  };
}

/** Everything a round needs settled before its first attempt: who judges
 * it, and - in Inspector mode - who will read its diff once Inspector
 * turns it green. Mode b refuses up front when there is no check to
 * run, as before; mode a needs no check file of Fabrica's own.
 *
 * The reader is settled HERE, before any worker starts, and not at the
 * moment of the read (inspector issue #34, the Client's own condition):
 * a task that spent its attempts and turned green before discovering
 * nobody can read it has spent money to reach a stage it could not
 * complete. Settled only in Inspector mode, for the same reason the
 * reviewer is - a self-tested round never reaches a read, and a reader
 * it will never use has no business refusing it. */
export function prepareRound(
  recordHome: string,
  taskId: string,
  line: ProductionLine,
  baseCommit: string,
  opts: {
    inspector?: Inspector;
    checkBox?: CheckBox;
    closesIssue?: ClosesIssue;
    /** A fix round's own (verdict.ts); asked at each handoff rather than
     * now - see `inspectorJudge`. Nothing else has a rebase to lease. */
    publishLease?: () => PublishLease | undefined;
    /** Issue #267's seam, threaded from `createForeman`'s options the
     * same way `inspector`/`checkBox` are - omitted uses the real
     * GitHub read. */
    checksReader?: ChecksReader;
    /** Issue #187: where this round's GitHub tokens are minted from.
     * Omitted uses the real GitHub App on this machine; a test supplies
     * `src/githubapp/helpers/fake-minter.ts`'s fake so no suite needs a
     * registered App or the network. Every mint is recorded on the
     * task either way (`github-token.ts`'s `recordingMinter`). */
    minter?: TokenMinter;
  }
): { judge: Judge; mode: CheckMode; reader?: RoundReader } {
  const check = resolveCheckCommand(recordHome, line.project);
  // Settled before the mode is chosen, but only for a task that will
  // actually be inspected: a project with no .inspector.json at its
  // base commit is self-tested, and a reviewer it will never use has no
  // business refusing it. Throws ForemanError("reviewer-not-ready")
  // when one is required and cannot be settled - the same three
  // refusals `fabrica do` already printed up front.
  const reviewer = inspectorIsConfigured(line.workdir, baseCommit)
    ? requireReviewer(recordHome, line.workdir, line.project, baseCommit)
    : undefined;
  const mode = chooseCheckMode(
    line,
    baseCommit,
    opts.inspector,
    reviewer,
    publishToken(recordHome, taskId, line.project, opts.minter)
  );
  // Settled before the first worker starts, so the answer is this
  // project's configuration as it stood when the round began rather
  // than whatever projects.toml says an hour later. Never throws - see
  // reader.ts's header for why a round must not be destroyed over this
  // - so an unsettleable reader is carried as a problem and recorded at
  // the moment the read was due.
  const reader = mode.mode === "inspector" ? readerForRound(recordHome, line.project) : undefined;
  if (mode.mode === "self-test") {
    requireCheckCommand(line.workdir, check);
    appendEvent(recordHome, { taskId, name: "inspection-skipped", details: { reason: mode.reason } });
  } else {
    // Issue #306: what Inspector is known to refuse about this project's
    // own configuration, asked of the commit this task was cut from,
    // before any worker starts. Only when the Inspector that will judge
    // the round is the one installed on this machine - a caller-supplied
    // Inspector is a different implementation (in practice a test's
    // fake), and the claim being made here is specifically that the
    // *installed* Inspector would turn this config away.
    if (opts.inspector === undefined) requireInspectorConfig(line.workdir, baseCommit);
    // Anything Inspector can tell is missing up front (its GitHub token,
    // issue #103) refuses here, before any worker starts.
    try {
      mode.inspector.prepare?.();
    } catch (err) {
      throw new ForemanError("inspector-not-ready", err instanceof Error ? err.message : String(err));
    }
  }

  const judge =
    mode.mode === "inspector"
      ? inspectorJudge(
          recordHome,
          taskId,
          line,
          baseCommit,
          mode.inspector,
          opts.closesIssue,
          opts.publishLease,
          opts.checksReader,
          opts.minter
        )
      : selfTestJudge(recordHome, taskId, line, check, opts.checkBox ?? defaultCheckBox());
  return { judge, mode, ...(reader === undefined ? {} : { reader }) };
}

/**
 * Wraps a round's judge so an attempt that lands no new commit on the
 * branch - identical to `priorHead`, the branch's HEAD the moment this
 * round's line was reopened, captured before any attempt ran - is never
 * handed to the real judge at all. Scoped to the fix-round path
 * (`verdict.ts`): re-handing an already-reviewed commit to Inspector only
 * draws a refusal, since Inspector has already judged it; a self-test
 * re-run of the same workdir could only repeat its own last answer.
 * `attempts.ts` already committed the attempt (a no-op when nothing
 * changed) by the time this runs, so comparing HEAD now against
 * `priorHead` is exactly "did this round's worker change anything."
 */
export function skipIfUnchanged(judge: Judge, workdir: string, priorHead: string): Judge {
  return async (attempt, gateChanges, finalMessage) => {
    if (baseCommitOf(workdir) === priorHead) return { kind: "unchanged" };
    return judge(attempt, gateChanges, finalMessage);
  };
}

/**
 * Wraps a round's judge so the pull request's title and body are not
 * this round's own message but whatever `map` makes of it - everything
 * else about the handoff unchanged.
 *
 * The one user is a rebase-only fix round (`rebase-only.ts`), whose
 * section is appended to the pull request's existing body rather than
 * replacing it. Written as a wrapper rather than another parameter on
 * `inspectorJudge` deliberately: `finalMessage` is the only thing a
 * judge does with a message, and only `inspectorJudge` looks at it at
 * all (a self-tested round has no pull request), so a wrapper leaves
 * both judges exactly as they were. The message `attempts.ts` commits
 * with is untouched by this - it holds its own copy.
 */
export function withPullRequestMessage(
  judge: Judge,
  map: (message: FinalMessageForCommit) => { title: string; body: string }
): Judge {
  return async (attempt, gateChanges, finalMessage) =>
    judge(attempt, gateChanges, { ...finalMessage, ...map(finalMessage) });
}

/** A round's delivery outcome from how its last attempt was judged.
 * Inspector red is inspection-red (the Client's verdict); a red self-test
 * is a failure report; a box that could not run the check is not-verified,
 * never a red. Refusals and commit failures are handled before this. */
export function roundOutcome(ctx: {
  capStopped: boolean;
  lastJudgement: Judgement;
  mode: CheckMode;
}): Delivery["outcome"] {
  if (ctx.capStopped) return "cap-stopped";
  // A write-up failure is the worker's own, found before any check ran -
  // never an Inspector red, whichever mode the round is in.
  if (ctx.lastJudgement.kind === "verdict" && ctx.lastJudgement.writeupInvalid !== undefined) return "failure-report";
  if (ctx.lastJudgement.kind === "not-verified") return "not-verified";
  if (ctx.lastJudgement.kind === "verdict" && ctx.lastJudgement.gate.green) return "done";
  return ctx.mode.mode === "inspector" ? "inspection-red" : "failure-report";
}
