import type {
  Brain,
  Delivery as ContractDelivery,
  FabricaEvent as ContractFabricaEvent,
  FabricaEventName as ContractFabricaEventName,
  FabricaTask as ContractFabricaTask,
  Receipt,
} from "../../contract/surface.ts";

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
  }): Promise<Inspection>;
  /** Whether this Inspector can run at all (its command is installed).
   * Omitted means it can - a test's fake always can. */
  installed?(): boolean;
  /** Called once before a task's first worker starts in Inspector mode.
   * Throws, with a message to show the Client verbatim, when Inspector
   * could not run for a reason known up front (no GitHub token). */
  prepare?(): void;
}

export type Delivery = Omit<ContractDelivery, "outcome"> & {
  /** "not-verified": self-tested, but the worker's box could not run the
   * check at all - nothing judged the work, which is not the same as red.
   * "nothing-changed": a fix round's worker left the branch exactly where
   * it already was - no new commit, so nothing was handed to a check or
   * Inspector at all (two fixes in the fix-round path). */
  outcome: ContractDelivery["outcome"] | "inspection-red" | "not-verified" | "nothing-changed";
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
  | "stopped-by-owner";

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
