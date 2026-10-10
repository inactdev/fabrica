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
}

/** The socket for Inspector's local handoff. Inspector reads HEAD from the
 * checked-out ProductionLine and owns any later publishing itself. */
export interface Inspector {
  inspect(request: { branch: string; workdir: string }): Promise<Inspection>;
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
   * check at all - nothing judged the work, which is not the same as red. */
  outcome: ContractDelivery["outcome"] | "inspection-red" | "not-verified";
  /** Present only when this branch was handed to Inspector. */
  inspection?: Inspection;
};

export type FabricaTask = Omit<ContractFabricaTask, "state"> & {
  state: ContractFabricaTask["state"] | "refused";
};

export type FabricaEventName =
  | ContractFabricaEventName
  | "inspector-called"
  | "inspection-finished"
  | "inspection-skipped";

export interface FabricaEvent extends Omit<ContractFabricaEvent, "name"> {
  name: FabricaEventName;
}

/** Fabrica's public Foreman shape, extended with Inspector handoff outcomes. */
export interface Foreman {
  do(
    taskText: string,
    opts: { project: string; attempts?: number; brain?: Brain }
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
