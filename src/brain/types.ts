// The brain socket (CONTRACT rule 8: "No favorite brain"). Declared once
// in contract/surface.ts (issue #45) and re-exported here as a type only -
// `import type` is erased at compile time, so this creates no runtime
// dependency on contract/. This is the ONLY interface a Worker's model
// plugs into; nothing past this file may know which brain is behind it.

import type { Brain as ContractBrain, BrainAskResult as ContractBrainAskResult } from "../../contract/surface.ts";
import type { AskQuestion } from "./ask-shape.ts";

export type {
  BrainWorkOptions,
  BrainWorkResult,
  TranscriptEntry,
  WriteupQuizEntry,
} from "../../contract/surface.ts";

import type { WorkerWriteup as RatifiedWriteup } from "../../contract/surface.ts";

/**
 * The write-up every reader in `src/` uses: the ratified shape plus the
 * one field a project's committed test map asks for.
 *
 * Widened here rather than in `contract/surface.ts` for the same reason
 * `src/inspector/types.ts` widens `Delivery` and `Receipt` - the
 * contract is a path `rule9-gate.yml` protects, and which of a
 * project's own mapped tests a worker says it ran is bookkeeping about
 * that project's test suite, not a new promise about the brain seam.
 * Optional, like `couldNotVerify`: a project that commits no
 * `tests.map` has nothing to report here, and a write-up without it is
 * as valid as it ever was (`src/foreman/pr-body.ts`'s
 * `writeupProblem`).
 */
export type WorkerWriteup = RatifiedWriteup & {
  /** Which of the tests this project's `tests.map` mapped the touched
   * files to the worker says it actually ran, in its own words, one per
   * line. Never checked against the mapped list (Client ruling: the
   * record is the worker's own report and is marked as such; the full
   * suite's own run is the independent check). Not rendered into the
   * pull request body at all - like `quiz`, it is asked of the worker
   * for the Client, who reads it on the delivery. */
  testsRun?: string;
};

/** The clarifying step's result, widened by the one field issue #176
 * added: the fixed shape a question now arrives in. Widened here rather
 * than in `contract/surface.ts` for the same reason
 * `src/inspector/types.ts` widens `Receipt`/`Delivery`/
 * `FabricaEventName` - the contract is a path `rule9-gate.yml` protects,
 * and what #176 asks for is that free-form questions be *rejected at
 * dispatch*, which is a rule Fabrica enforces at runtime
 * (`./ask-shape.ts`'s `askShapeProblem`), not a new promise about the
 * seam's own type. The ratified `questions` field is untouched and still
 * declared exactly once; sending it is simply a rejection now. Every
 * reader in `src/` imports `BrainAskResult` from here. */
export type BrainAskResult = ContractBrainAskResult & {
  /** The one question this pass asks, with the two to four options the
   * machine considers likely. Omitted means nothing needs asking. */
  question?: AskQuestion | null;
};

/** The brain socket, with `ask()` returning the widened result above.
 * `work()` and every other member are the contract's own, unchanged. */
export interface Brain extends Omit<ContractBrain, "ask"> {
  ask(brief: string): Promise<BrainAskResult>;
}
