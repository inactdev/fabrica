// The loop: SPEC.md "fabrica do". Wires src/record, src/line, src/brain,
// src/config, and src/inspector together - register the task,
// ask-or-proceed (issue #8, ask.ts), cut a ProductionLine, run the worker
// for a counted number of attempts, verify with the project's check, then
// deliver or record an Inspector refusal. See README.md
// for the design decisions this file leans on (why check.sh, why
// attempts behaves the way it does, why the promise doesn't resolve
// early).

import { appendEvent, appendTaskFile, readTaskFile } from "../record/index.ts";
import { createProductionLine, destroyProductionLine, reopenProductionLine } from "../line/index.ts";
import { withTaskNetwork } from "../brain/index.ts";
import type { Brain } from "../brain/index.ts";
import { prepareRound } from "./judge.ts";
import type { ChecksReader } from "./ci-checks.ts";
import type { TokenMinter } from "../githubapp/index.ts";
import { runAttempts } from "./attempts.ts";
import { deliveredState } from "./delivery.ts";
import { recordRoundResult } from "./round.ts";
import { closesIssueFor } from "./pr-body.ts";
import { storedClosesIssue, taskIssueText, withIssueText } from "./task-issue.ts";
import { knowledgeNotesFor, withKnowledge } from "./task-knowledge.ts";
import { testMapFor } from "./test-map.ts";
import { baseCommitOf } from "../delivery/index.ts";
import { registerAndAsk } from "./ask.ts";
import { readModelChoice } from "./model.ts";
import { networkPolicyFor } from "./network-policy.ts";
import { workerBrief } from "./touched-tests.ts";
import { recordingFailure } from "./task-failure.ts";
import { sweepTaskNetworks } from "./task-networks.ts";
import { recordReceipt, spendLimitsFor } from "./caps.ts";
import { pauseRuleFor } from "./meters.ts";
import type { Caps } from "../../contract/surface.ts";
import type { IssueReader } from "./task-issue.ts";
import type { FabricaTask } from "../inspector/types.ts";
import type { Inspector } from "../inspector/index.ts";
import type { CheckBox } from "../brain/index.ts";

export { DEFAULT_ATTEMPTS } from "./ask.ts";

export async function doTask(
  recordHome: string,
  taskText: string,
  opts: {
    project: string;
    attempts?: number;
    brain?: Brain;
    /** The issue the chat agent names explicitly - a number, or any
     * spelling src/github's `parseIssueArg` accepts. Its words are
     * fetched at registration and carried into every round's brief; see
     * src/foreman/task-issue.ts. */
    issue?: number | string;
    /** Where that issue is read from - tests supply a fake. */
    issueReader?: IssueReader;
    /** `fabrica do --model <name>` (issue #184): the model this task
     * asks for, overriding the project's own setting. The brain itself
     * is built with it by the caller (`defaultBrainAdapter`); this is
     * what gets persisted and recorded. */
    model?: string;
    inspector?: Inspector;
    checkBox?: CheckBox;
    /** Issue #267's seam (judge.ts's `ChecksReader`) - omitted reads
     * the pull request's real checks from GitHub. */
    checksReader?: ChecksReader;
    /** Issue #187's seam: where this round's GitHub App tokens are
     * minted from. Omitted uses the real App on this machine. */
    minter?: TokenMinter;
    caps?: Caps;
    onTaskRegistered?: (taskId: string) => void;
  }
): Promise<FabricaTask> {
  // SPEC.md steps 1-2: register the task, then give the brain one pass
  // at the bare task text (issue #8) before any ProductionLine exists.
  // registerAndAsk raises ForemanError("no-brain"/"invalid-attempts")
  // up front, same as this function always has, before anything is
  // registered.
  const { taskId, brief, questions, project, totalAttempts, explicitAttempts } = await registerAndAsk(
    recordHome,
    taskText,
    opts
  );

  // A materially ambiguous task stops here - no ProductionLine is ever
  // cut, no Worker ever runs. `fabrica answer <id> -m "<text>"`
  // (src/foreman/answer.ts) resumes it, extending this same brief.
  if (questions.length > 0) return { id: taskId, state: "asking" };

  // Always a first-ever round: registerAndAsk just claimed this taskId,
  // so no ProductionLine for it can exist yet. Never derived from
  // whether a branch happens to exist (see runProductionRound's own
  // comment for why that was the weaker, unsafe signal).
  return runProductionRound(recordHome, taskId, brief, {
    project,
    brain: opts.brain!,
    totalAttempts,
    explicitAttempts,
    isRetry: false,
    inspector: opts.inspector,
    checkBox: opts.checkBox,
    checksReader: opts.checksReader,
    minter: opts.minter,
    caps: opts.caps,
  });
}

/**
 * SPEC.md steps 3-6: isolate, work, verify, inspect when configured,
 * then deliver or refuse. Shared by a task
 * proceeding straight out of `doTask` and one resuming after `fabrica
 * answer` (answer.ts) - `brief` is the task's own words: the bare task
 * text in doTask's case, request.md plus every answer so far in
 * answer.ts's. What the worker receives is built from it here, once the
 * project is resolved (`workerBrief`, touched-tests.ts): the standing
 * prefix rule 11 requires, plus whatever this project's settings add.
 */
export async function runProductionRound(
  recordHome: string,
  taskId: string,
  brief: string,
  ctx: {
    project: string;
    brain: Brain;
    totalAttempts: number;
    explicitAttempts: boolean;
    isRetry: boolean;
    inspector?: Inspector;
    checkBox?: CheckBox;
    /** Issue #267's seam (judge.ts's `ChecksReader`) - omitted reads
     * the pull request's real checks from GitHub. */
    checksReader?: ChecksReader;
    /** Issue #187's seam: where this round's GitHub App tokens are
     * minted from. Omitted uses the real App on this machine. */
    minter?: TokenMinter;
    caps?: Caps;
  }
): Promise<FabricaTask> {
  // #73: whatever throws from here on lands on the record as task-failed.
  try {
    return await recordingFailure(recordHome, taskId, () => productionRound(recordHome, taskId, brief, ctx));
  } finally {
    // The round is over - delivered, refused or thrown - so nothing of
    // this task's is still running and any Docker network still open
    // for it is a leftover holding an address pool. Outside
    // productionRound's own `finally` (which only covers a line that
    // was actually cut) so a round that died on the cut itself is swept
    // too. See task-networks.ts.
    await sweepTaskNetworks(taskId);
  }
}

async function productionRound(
  recordHome: string,
  taskId: string,
  brief: string,
  ctx: {
    project: string;
    brain: Brain;
    totalAttempts: number;
    explicitAttempts: boolean;
    isRetry: boolean;
    inspector?: Inspector;
    checkBox?: CheckBox;
    /** Issue #267's seam (judge.ts's `ChecksReader`) - omitted reads
     * the pull request's real checks from GitHub. */
    checksReader?: ChecksReader;
    /** Issue #187's seam: where this round's GitHub App tokens are
     * minted from. Omitted uses the real App on this machine. */
    minter?: TokenMinter;
    caps?: Caps;
  }
): Promise<FabricaTask> {
  const { project, brain, totalAttempts, explicitAttempts, isRetry, inspector, checkBox, checksReader, minter, caps } = ctx;
  // The delivery's summary/evidence want the Client's original one-line
  // ask, not the full brief a resumed round's worker receives - `brief`
  // for an answer.ts retry is request.md plus the whole "## Clarification"
  // Q/A block, which would otherwise turn `delivery.summary` (`Completed:
  // ${taskText}`) and delivery.md into a multi-paragraph blob instead of
  // one line. verdict.ts's fix path already draws this exact distinction
  // (`readTaskFile(..., "request.md")` for taskText, `brief.md` only for
  // the worker's own brief) - mirrored here rather than reinvented.
  const taskText = readTaskFile(recordHome, taskId, "request.md") ?? brief;
  // Re-derived the same way taskText is: an explicit issue number has no
  // home in taskText, so ask.ts persisted it once, at registration, for
  // every round of this task to read back here.
  const closesIssue = closesIssueFor(taskText, storedClosesIssue(recordHome, taskId));
  // The issue this task names, as it was fetched at registration
  // (ask.ts) - read back off the record, never fetched again: the issue
  // is frozen for the life of the task, so every round's worker reads
  // the same words, and a round running in another process needs no
  // GitHub access of its own.
  const issueText = taskIssueText(recordHome, taskId);
  // Re-derived from the record the same way, and for the same reason
  // (issue #184): the model this task asked for was resolved once at
  // registration, so a resumed round reports the same declaration as
  // the first one even if projects.toml has changed since.
  const modelChoice = readModelChoice(recordHome, taskId);
  // The knowledge-base notes this project names, read off the disk now -
  // not from the record, because unlike the issue they are not the
  // request: they are what the project knows today, and a note corrected
  // between rounds is one this round should read corrected (see
  // task-knowledge.ts).
  //
  // Read HERE, before the line is cut below, so a project naming a note
  // that cannot be read fails the task with no ProductionLine behind it,
  // naming which - the Client's own condition on this.
  const knowledgeNotes = knowledgeNotesFor(recordHome, project);
  // The project's committed test map, read here for the same reason and
  // with the same timing: a `tests.map` whose own text cannot be read
  // fails the task before any ProductionLine exists, naming the line to
  // fix (test-map.ts). Null for a project that commits none, which
  // leaves the brief and the delivery exactly as they were.
  const testMap = testMapFor(project);
  // `isRetry` is an explicit signal the caller derives from the RECORD -
  // answer.ts sets it true only when this exact taskId, in this exact
  // record home, already has a "line-cut" event: proof that
  // createProductionLine genuinely returned for this task once, so the
  // `fabrica/<taskId>` branch out there is this task's own.
  // doTask's first-ever call always passes false.
  //
  // Proof of the cut specifically, not proof the Client answered: a
  // resume records "answers-given" before this function ever runs, so a
  // round that died on the cut itself (a moved project path, a stale
  // .git/index.lock) leaves that event behind with no branch to match
  // it. Keyed on "answers-given", every later `fabrica answer` would
  // then reopen a line that was never cut and die on `no-such-branch`
  // forever, even after the Client fixed the real cause - the task
  // permanently stuck, which is exactly what staying resumable is
  // supposed to prevent.
  //
  // This used to be decided by asking git whether a `fabrica/<taskId>`
  // branch already existed, on the theory that a first-ever round could
  // never see one. That was the weaker evidence: a taskId is only unique
  // within one record home (registerTask claims tasks/<id>/), while
  // branches live in the project - a same-named branch left by a
  // different record home, a record home recreated while the project's
  // branches survived, or a hand-made branch, would all have been
  // silently reopened and committed onto, on what was actually this
  // task's first round, exactly where createProductionLine's own loud
  // refusal used to apply. The record - whether this taskId's own
  // history shows a prior incomplete resume - is a claim only this
  // task's own retry can make true, so it can't be spoofed by an
  // unrelated branch happening to share a name.
  //
  // Note what reopening does and doesn't fix. It makes a retry possible
  // at all, and a failure unrelated to the branch's own content (an
  // unreachable brain, a transient error) then succeeds once that
  // condition clears. It does NOT re-cut from the project's current
  // HEAD: the reopened branch is still forked from wherever it was
  // first cut, so a failure baked into that history - no check.sh in
  // that commit, a project path already wrong then - throws the same
  // error on every retry.
  const line = isRetry
    ? reopenProductionLine({ project, taskId, recordHome })
    : createProductionLine({ project, taskId, recordHome });

  try {
    // Pin the diff's fork point to the exact commit the ProductionLine was
    // cut from, before any worker attempt runs — so the delivery's `files`
    // list can't drift if the Client's own checkout moves to a different
    // branch while the task is still running. Computed before "line-cut"
    // is appended so that event's own record of the base commit (for a
    // fresh cut, origin's default branch — see src/line/cut.ts) is never
    // missing.
    const baseCommit = baseCommitOf(line.workdir);

    // The line demonstrably exists now - recorded here, inside the try,
    // so teardown still runs if this append itself fails, and before
    // anything that can throw between the cut and "work-started"
    // (prepareRound's own refusals). A later resume reads
    // this event and nothing else to know it must reopen this branch
    // rather than cut a new one.
    appendEvent(recordHome, {
      taskId,
      name: "line-cut",
      details: { branch: line.branch, reopened: isRetry, baseCommit },
    });

    // Who judges each attempt: Inspector, or the worker's own box (issue
    // #64) - never a check run on the host.
    const { judge, mode } = prepareRound(recordHome, taskId, line, baseCommit, {
      inspector,
      checkBox,
      closesIssue,
      checksReader,
      minter,
    });

    // `project` rides on work-started's details, not a dedicated event -
    // it's the earliest point in the loop the resolved project path is
    // known, and issue #12's `fabrica status`/`log` need it to label an
    // open task without waiting for delivery. The declared model rides
    // along for exactly the same reason (issue #184): a task row has to
    // say which model the round asked for from the moment work starts,
    // not only once an attempt's receipt has landed.
    appendEvent(recordHome, {
      taskId,
      name: "work-started",
      details: { project: line.project, ...modelChoice },
    });

    // Issue #186: every call this round makes runs under the project's
    // own network policy - the hosts it declared in projects.toml, the
    // relay's limits, and this task's record for a refusal to land on.
    // Wrapped around the whole loop rather than each attempt: one
    // policy holds for the task, and every attempt's relay is started
    // from inside this call (src/brain/task-network.ts).
    const attemptsResult = await withTaskNetwork(networkPolicyFor(recordHome, taskId, line.project), () =>
      runAttempts({
        brain,
        // Issue #142: the project's own settings decide whether this
        // brief also carries the only-touched-tests ruling. Built here,
        // not at each caller, so a resumed round (answer.ts) and a
        // first attempt resolve it identically.
        // The task's own words, the issue it names, then the project's
        // knowledge notes - all inside what `workerBrief` puts the
        // standing prefix in front of.
        // No `touched` here, deliberately: a first round has changed
        // nothing yet, and a round resumed from questions cannot have
        // either (answer.ts refuses a second answer once a round
        // completed), so there is no diff to resolve the map against.
        // Its worker gets the lookup rule; a fix round, whose branch
        // does carry a diff, gets the concrete tests (verdict.ts).
        brief: workerBrief(recordHome, line.project, withKnowledge(withIssueText(brief, issueText), knowledgeNotes), {
          testMap,
        }),
        workdir: line.workdir,
        taskId,
        judge,
        totalAttempts,
        stopEarlyOnGreen: !explicitAttempts,
        spendLimits: spendLimitsFor(recordHome, taskId, caps),
        modelChoice,
        // Issue #189: the thresholds that stop an attempt already
        // running. Read from projects.toml here rather than threaded in
        // like `caps`, since the pause rule has no "unset" - a record
        // home with no projects.toml still has one, at its defaults.
        pauseRule: { rule: pauseRuleFor(recordHome) },
        onReceipt: (receipt) => recordReceipt(recordHome, receipt),
        onHeartbeat: (attempt) => {
          appendEvent(recordHome, { taskId, name: "heartbeat", details: { attempt } });
        },
        // Issue #199: a dropped model call is retried once, on the same
        // model, and the record says so - never a silent reconnect, and
        // never a silent downgrade to a different model.
        onTransportRetry: (details) => {
          appendEvent(recordHome, { taskId, name: "transport-retry", details });
        },
        // Issue #70: fires as each entry is known, not once per attempt -
        // see runAttempts' own onTranscriptEntry doc for why every entry
        // lands here exactly once either way.
        onTranscriptEntry: (entry) => {
          appendTaskFile(recordHome, taskId, "transcript.log", `${JSON.stringify(entry)}\n`);
        },
      })
    );

    // judge-commit-outcome-deliver-record: one shared tail (issue #182),
    // round.ts's recordRoundResult, also used by verdict.ts's fix round.
    const result = recordRoundResult(
      recordHome,
      taskId,
      line,
      { baseCommit, taskText, totalAttempts, mode, caps, testMap },
      attemptsResult
    );

    if (result.kind === "refused") return { id: taskId, state: "refused" };
    return { id: taskId, state: deliveredState(result.outcome) };
  } finally {
    destroyProductionLine(line);
  }
}
