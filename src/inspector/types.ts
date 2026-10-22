import type {
  Brain,
  Delivery as ContractDelivery,
  FabricaEvent as ContractFabricaEvent,
  FabricaEventName as ContractFabricaEventName,
  FabricaTask as ContractFabricaTask,
  Receipt as ContractReceipt,
} from "../../contract/surface.ts";
import type { MeterReading } from "../brain/meters.ts";

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
  /** "paused-by-meter" (issue #189): a subscription meter past its stop
   * threshold stopped this attempt mid-flight. Deliberately its own
   * outcome and never "failed" (Client's clarification) - the work was
   * going fine, the week's quota was not. */
  outcome: ContractReceipt["outcome"] | "paused-by-meter";
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
  /** The whole read of a pull request's checks ended - every check
   * concluded, the bounded wait expired, or the API could not be read
   * (issue #267). Details: `src/ci/watch.ts`'s `CiChecksFinishedDetails`
   * - the head commit read, the verdict drawn from it, the one-phrase
   * summary every task line shows, and the checks that never concluded,
   * recorded as unknown and never as green. */
  | "ci-checks-finished";

export interface FabricaEvent extends Omit<ContractFabricaEvent, "name"> {
  name: FabricaEventName;
}

/** Fabrica's public Foreman shape, extended with Inspector handoff outcomes. */
export interface Foreman {
  do(
    taskText: string,
    /** `issue` mirrors contract/surface.ts's `Foreman.do` - the chat
     * agent's explicit alternative to `taskText` starting with
     * "Issue #N:" (src/foreman/pr-body.ts's `closesIssueFor`). */
    opts: { project: string; attempts?: number; brain?: Brain; issue?: number }
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
