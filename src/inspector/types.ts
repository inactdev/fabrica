import type {
  Brain,
  Delivery as ContractDelivery,
  FabricaEvent as ContractFabricaEvent,
  FabricaEventName as ContractFabricaEventName,
  FabricaTask as ContractFabricaTask,
  Receipt as ContractReceipt,
} from "../../contract/surface.ts";
import type { MeterReading } from "../brain/meters.ts";
import type { ReaderOnDelivery } from "../reader/types.ts";
import type { TestMapReport } from "../testmap/types.ts";

/** Inspector's independent verdict after Fabrica's own checks are green.
 * `refused` is deliberately separate from `red`: no verdict was reached. */
export interface Inspection {
  verdict: "green" | "red" | "refused";
  report: string;
  /** The URL from Inspector's own "pull request: <url>" stdout line, when
   * it printed one - never inferred from the verdict alone, so a green
   * result that opened nothing carries no url. */
  prUrl?: string;
}

/** The socket for Inspector's local handoff. Inspector reads HEAD from the
 * checked-out ProductionLine and owns any later publishing itself. */
export interface Inspector {
  inspect(request: {
    branch: string;
    workdir: string;
    /** The task's own first line, trimmed - handed to Inspector so a
     * green result's pull request carries it as the title. */
    prTitle?: string;
    /** The pull request body Fabrica wants Inspector to use if it opens
     * one - written to a temp file and passed as -pr-body-file. */
    prBody?: string;
    /** The commit origin's copy of `branch` is expected to still be at,
     * so Inspector publishes a rewritten branch with force-with-lease
     * instead of a blind force (inspector#53). Set only when this
     * round's host-side rebase actually moved the branch and origin had
     * a copy to lease against - see src/foreman/fix-rebase.ts's
     * `publishLeaseAfterRebase`. Omitted means "publish as before":
     * there is nothing here that may turn a working publish into a
     * failure. */
    expectedTip?: string;
  }): Promise<Inspection>;
  /** Whether this Inspector can run at all (its command is installed).
   * Omitted means it can - a test's fake always can. */
  installed?(): boolean;
  /** Called once before a task's first worker starts in Inspector mode.
   * Throws, with a message to show the Client verbatim, when Inspector
   * could not run for a reason known up front (no GitHub token). */
  prepare?(): void;
}

/** Where the model a task asked for came from (issue #184): the
 * Client's own `fabrica do --model`, the project's own setting in
 * projects.toml, or nothing at all - in which case the brain's
 * configuration decided and nothing declared anything. Declared here,
 * beside the `Receipt` field that carries it, rather than in
 * `src/foreman/model.ts` where the rest of the model logic lives: the
 * record's own shapes are this file's business, and the alternative is
 * two declarations of one union. */
export type ModelSource = "flag" | "project" | "default";

/**
 * What a task's change hashes to, independent of where it sits in
 * history: `git patch-id --stable` over the branch's diff against its
 * merge-base with origin's default branch. `src/foreman/fingerprint.ts`
 * is where it is taken and worded; declared here, beside the `Receipt`
 * and `Delivery` fields that carry it, for the same reason
 * `ModelSource` above is - the record's own shapes are this file's
 * business.
 *
 * `patchId` is null exactly when no id could be taken, and `reason`
 * then says why in one line, shown to the Client verbatim.
 */
export interface ChangeFingerprint {
  patchId: string | null;
  /** The commit the diff was taken against - `merge-base(HEAD,
   * origin/<default>)` - or null when that could not be resolved. */
  base: string | null;
  /** origin's default branch the base came from, e.g. "main". Never
   * assumed to be "master"; null when it could not be read. */
  baseBranch: string | null;
  /** Present exactly when `patchId` is null. */
  reason?: string;
}

/**
 * How one pass's stamp compares with the stamps the task already has.
 * Compared against the immediately preceding stamped pass (Client
 * ruling); a pass whose change comes back to an id an earlier pass
 * carried reads as matched against that earlier pass, and `matchedPass`
 * says which.
 */
export interface FingerprintMatch {
  /** True when this pass's patch id is one this task already stamped. */
  matched: boolean;
  /** The patch id the immediately preceding stamped pass carried. */
  previous: string;
  /** Which pass that was - 1-based, counting the task's own passes. */
  previousPass: number;
  /** Which pass's stamp this one matched - absent when none did. */
  matchedPass?: number;
  /** True exactly when `matched` is false: every Inspector stamp, check
   * result and CI conclusion already on this task's record was made
   * about a different change and says nothing about this one. Written
   * down and shown; it blocks nothing, since the Client keeps the last
   * word under rule 6 (Client ruling). Verdicts, quiz results and the
   * clarify step's questions and answers are not observations of the
   * change and are never voided. */
  voidsEarlierObservations: boolean;
}

/** One attempt's receipt, extended with what issue #189 asks every
 * receipt to record: the two subscription meters as they stood when the
 * attempt ran. Widened here rather than in `contract/surface.ts` for
 * the same reason `Delivery` and `FabricaEventName` below are - this
 * file is the one place that widening happens, the contract is a path
 * `rule9-gate.yml` protects, and a meter reading is Fabrica's own
 * bookkeeping about the Client's subscription, not a new promise about
 * a seam. Every reader in `src/` imports Receipt from here. */
export type Receipt = Omit<ContractReceipt, "outcome"> & {
  /** Both meters as the attempt's own worker last saw them, or null
   * when no reading was available at all - a worker whose brain cannot
   * report them, or one that never got a reading before it finished.
   * Null is "nobody knows", never "0%": the pause rule treats an
   * unknown reading as refusing nothing (Client's clarification: fail
   * open), and recording it as zero would both hide that and read as a
   * fresh, empty quota. */
  meters: MeterReading | null;
  /** Which model this attempt asked for, and where that choice came
   * from (issue #184) - `null`/`"default"` when nothing declared one
   * and the brain's own configuration decided. Widened here for the
   * same reason `meters` above is: a declaration the Client made is
   * Fabrica's own bookkeeping, not a new promise about a seam. The
   * ratified `model` field keeps its name and now holds the model that
   * actually ran, which is the only thing a reader ever wanted from it
   * (see `src/foreman/model.ts`). */
  declaredModel: string | null;
  modelSource: ModelSource;
  /** "paused-by-meter" (issue #189): a subscription meter past its stop
   * threshold stopped this attempt mid-flight. Deliberately its own
   * outcome and never "failed" (Client's clarification) - the work was
   * going fine, the week's quota was not. */
  outcome: ContractReceipt["outcome"] | "paused-by-meter";
  /** What this attempt's change hashes to, independent of where it sits
   * in history (`src/foreman/fingerprint.ts`) - `git patch-id --stable`
   * over the branch's diff against its merge-base with origin's default
   * branch, so a rebase onto newer upstream leaves it untouched.
   *
   * Optional, and absent means unstamped - a receipt written before
   * fingerprints existed simply has none, and nothing is ever computed
   * retroactively for it (Client ruling). An attempt that ran but could
   * not be hashed carries the stamp with `patchId: null` and a reason,
   * never nothing at all.
   *
   * Widened here rather than in `contract/surface.ts` for the same
   * reason `meters` and `declaredModel` above are: this is Fabrica's own
   * bookkeeping about its own record, not a new promise about a seam,
   * and the contract is a path `rule9-gate.yml` protects. */
  fingerprint?: ChangeFingerprint;
};

export type Delivery = Omit<ContractDelivery, "outcome"> & {
  /** "not-verified": self-tested, but the worker's box could not run the
   * check at all - nothing judged the work, which is not the same as red.
   * "nothing-changed": a fix round's worker left the branch exactly where
   * it already was - no new commit, so nothing was handed to a check or
   * Inspector at all (two fixes in the fix-round path).
   * "paused-by-meter": a subscription meter past its stop threshold
   * stopped the round in flight (issue #189) - like "cap-stopped", a
   * limit stopping the work, which is not the same as the work having
   * failed, and it waits on the Client's own `fix` verdict to resume. */
  outcome:
    | ContractDelivery["outcome"]
    | "inspection-red"
    | "not-verified"
    | "nothing-changed"
    | "paused-by-meter";
  /** Present only when this branch was handed to Inspector. */
  inspection?: Inspection;
  /** What the project's committed `tests.map` said about the files this
   * round touched: the tests they mapped to, the worker's own report of
   * which of those it ran, the touched files nothing covers, and any
   * mapping naming a test file the project no longer has. Absent for a
   * project that commits no map at all - an empty report would read as
   * "nothing was mapped" when the truth is "nothing here maps
   * anything". Widened here for the same reason `outcome` above is: the
   * contract is a path `rule9-gate.yml` protects, and a project's own
   * bookkeeping about its own test suite is not a new promise about a
   * seam. See src/testmap/README.md. */
  tests?: TestMapReport;
  /** What the change this pass hands over hashes to - the same stamp
   * the pass's own attempts carry (`Receipt.fingerprint` above), taken
   * once more after everything that could still move the branch this
   * round has finished moving it. Absent on a delivery written before
   * fingerprints existed, which reads as unstamped. */
  fingerprint?: ChangeFingerprint;
  /** How this pass's stamp compares with the one the task's previous
   * pass carried, and whether a changed one voids the Inspector stamps,
   * check results and CI conclusions already on the record
   * (`src/foreman/fingerprint.ts`). Absent on a task's first pass, on a
   * pass that could not be stamped, and on a delivery written before
   * fingerprints existed - in all three there is nothing to compare. */
  fingerprintMatch?: FingerprintMatch;
  /** The code reader's own read of the whole diff, after Inspector
   * turned this change green (inspector issue #34): what it flagged,
   * which model read it, and the worker's reason for any finding it
   * declined. Absent when this task never reached a read - a round
   * that never went green, a self-tested task with no Inspector at
   * all, or a round of a task whose one read already happened.
   *
   * It is never a verdict. The reader does not block and does not
   * approve, so nothing here moves `outcome`; a reader that failed
   * outright says so (`state: "failed"`) and the delivery still
   * stands. */
  reader?: ReaderOnDelivery;
};

export type FabricaTask = Omit<ContractFabricaTask, "state"> & {
  /** "refused": Inspector reached no verdict. "stopped": the Client
   * stopped the task himself (issue #203) - terminal the moment the
   * `stopped-by-owner` event lands, since his decision is the fact and
   * whatever the worker's own process reports on its way down is
   * recorded but never reopens it (see `stateOf`). */
  state: ContractFabricaTask["state"] | "refused" | "stopped";
};

/** Fabrica's own event names beyond `contract/surface.ts`'s ratified,
 * closed set - the one place that widening happens, which
 * `src/record/types.ts` then re-exports as *the* record's event name
 * type. Mostly Inspector's trigger and result events, hence this file;
 * `stopped-by-owner` is here for the same reason rather than in the
 * contract (`contract/surface.ts` is a path `rule9-gate.yml` protects,
 * and nothing about this event is a promise to the Client about a seam -
 * it is Fabrica's own bookkeeping, the same as `inspector-called`). */
export type FabricaEventName =
  | ContractFabricaEventName
  | "inspector-called"
  | "inspection-finished"
  | "inspection-skipped"
  /** The Client stopped this task himself from the review page (issue
   * #203). Details: `src/foreman/stop.ts`'s `StoppedByOwnerDetails` -
   * who stopped it (the Tailscale login), and the worker's last
   * recorded activity at that moment. */
  | "stopped-by-owner"
  /** The host-side rebase a fix round starts with (issue #235) stopped on
   * a conflict - one event per stop, and one more wherever the host
   * aborted. Details: `{ base, baseCommit, files, stop, left, reason? }`
   * - origin's default branch and the commit it pointed at, the
   * conflicted paths, which stop of this round's rebase it is, whether it
   * was left stopped for the round's worker or aborted back to the
   * branch's own last commit, and why where there is a why
   * (`"new-conflict"`, `"markers-remain"`, `"too-many-stops"`,
   * `"round-ended"`, `"round-failed"` - see `src/foreman/fix-rebase.ts`).
   * Purely the record saying what the host did; no decision reads it. */
  | "rebase-conflicted"
  /** A model call Fabrica made - a worker's `work()` or the clarifying
   * step's `ask()` - failed the way a dropped connection fails, and is
   * being retried once on the SAME model (issue #199). Details:
   * `src/foreman/transport-retry.ts`'s `TransportRetryDetails` - which
   * call it was, Fabrica's own short reason, the failed call's own
   * message verbatim, the model, the wait, and (for a worker's call) the
   * attempt it belongs to. One event per retried call, so a long task
   * may carry several. Never an attempt: rule 3 counts attempts, not
   * reconnects. Here rather than in the contract for the same reason as
   * the names above it - a reconnect is Fabrica's own bookkeeping, not a
   * new promise to the Client about a seam. */
  | "transport-retry"
  /** Issue #189's pause rule refused to START anything - a new task, a
   * resumed round, or a fix round - because a subscription meter was
   * past its refuse threshold. Details:
   * `src/foreman/meters.ts`'s `MeterRefusedDetails`. Nothing ran; the
   * same shape rule 10's `"cap-refused"` has, kept as its own name
   * because a full week's quota is not a dollar cap and the record
   * should not say it was. */
  | "meter-refused"
  /** Issue #189's pause rule stopped an attempt that was already
   * running. Details: `src/foreman/meters.ts`'s `MeterPausedDetails`.
   * The counterpart of rule 10's `"cap-stopped"`. */
  | "meter-paused"
  /** One check the repository runs on the pull request itself reached a
   * conclusion (issue #267). Details: `src/ci/watch.ts`'s
   * `CiCheckConcludedDetails` - the check's name, which of GitHub's two
   * mechanisms reported it, its own conclusion word verbatim, whether
   * Fabrica reads that as red, where a human reads the run, and the tail
   * of the job log when it is red and the API served one. One event per
   * check, appended as it concludes. */
  | "ci-check-concluded"
  /** The Client marked one of an accepted task's quiz questions right or
   * wrong on the live view's review mode. Details: `src/quiz/events.ts`'s
   * `QuizAnsweredDetails`. The record holds the whole spaced-repetition
   * schedule - there is no browser storage anywhere in it - and this is
   * the only event the schedule is derived from. */
  | "quiz-answered"
  /** A later accepted task touched a file this task's own accepted work
   * touched, so every quiz question this task spawned "may be outdated"
   * and stops being asked until a re-check round rules on it. Details:
   * `src/quiz/events.ts`'s `QuizStaleDetails`. Per task rather than per
   * question, because file overlap is a fact about the task. */
  | "quiz-stale"
  /** A re-check round ruled on one outdated quiz question: confirmed it,
   * rewrote it, or retired it. Details: `src/quiz/events.ts`'s
   * `QuizRecheckedDetails`. */
  | "quiz-rechecked"
  /** What one re-check round cost (details:
   * `src/quiz/events.ts`'s `QuizRecheckCostDetails`), attributed to the
   * task whose questions it re-checked. Its own name rather than a
   * receipt: a re-check is not an attempt at the task and must never
   * move its attempt numbering - the same reason the clarifying step has
   * `"ask-cost-recorded"` instead of one. */
  | "quiz-recheck-cost-recorded"
  /** The whole read of a pull request's checks ended - every check
   * concluded, the bounded wait expired, or the API could not be read
   * (issue #267). Details: `src/ci/watch.ts`'s `CiChecksFinishedDetails`
   * - the head commit read, the verdict drawn from it, the one-phrase
   * summary every task line shows, and the checks that never concluded,
   * recorded as unknown and never as green. */
  | "ci-checks-finished"
  /** Fabrica minted a short-lived, one-repository GitHub App token for
   * one call this task made - a push and pull request, the issue it
   * names, or the checks on its pull request (issue #187). Details:
   * `src/foreman/github-token.ts`'s `TokenMintedDetails` - the
   * repository, the installation, the permissions GitHub granted, the
   * expiry, and what the token was for. Never the token itself, which
   * exists only in memory for the length of that one call.
   *
   * Here rather than in the contract for the same reason as the names
   * above it: which credential Fabrica reached GitHub with is its own
   * bookkeeping, not a new promise to the Client about a seam, and
   * `contract/surface.ts` is a path `rule9-gate.yml` protects. */
  | "token-minted"
  /** The code reader read this task's whole diff after Inspector turned
   * it green and found nothing to flag (inspector issue #34). Details:
   * `src/foreman/reader-round.ts`'s `ReaderReadDetails`. No fix round
   * followed; the delivery went ahead. */
  | "reader-clean"
  /** The same read, with findings. Details: the same shape, carrying
   * them and the model that produced them. Exactly one reader fix round
   * follows, which is why this lands at most once per task. */
  | "reader-flagged"
  /** The read itself never produced findings - an unreachable or
   * refusing model, an answer that could not be read as findings, a
   * diff too large to send. Details:
   * `src/foreman/reader-round.ts`'s `ReaderFailedDetails`. **Never
   * blocks the delivery** (the reader is a flagger, so a reader that
   * cannot run must not become a gate by failing), and never silent:
   * it shows on the status row, rides on the delivery, and is counted
   * on `fabrica status`'s own bottom line. Here rather than in the
   * contract for the same reason as the names above it. */
  | "reader-failed";

export interface FabricaEvent extends Omit<ContractFabricaEvent, "name"> {
  name: FabricaEventName;
}

/** Fabrica's public Foreman shape, extended with Inspector handoff outcomes. */
export interface Foreman {
  do(
    taskText: string,
    /** `issue` mirrors contract/surface.ts's `Foreman.do` - the chat
     * agent's explicit alternative to `taskText` starting with
     * "Issue #N:" (src/foreman/pr-body.ts's `closesIssueFor`) - widened
     * to the two other spellings the Client asked for, `owner/repo#N`
     * and a pasted issue URL (src/github's `parseIssueArg`). A plain
     * number, the only form the ratified type names, still means
     * exactly what it always did.
     *
     * `model` (issue #184): which model this task asks for, overriding
     * the project's own `model` setting. Recorded on every receipt
     * beside the model that actually ran. */
    opts: { project: string; attempts?: number; brain?: Brain; issue?: number | string; model?: string }
  ): Promise<FabricaTask>;
  answer(taskId: string, text: string): Promise<FabricaTask>;
  deliveryOf(taskId: string): Promise<Delivery | null>;
  receiptsOf(taskId: string): Promise<Receipt[]>;
  verdict(taskId: string, ruling: "accept" | "fix" | "wrong", note?: string): Promise<void>;
  status(): Promise<FabricaTask[]>;
  events(taskId: string): Promise<FabricaEvent[]>;
  recordCost(taskId: string, usd: number): Promise<void>;
  recordPath(): string;
}
