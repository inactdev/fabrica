// A completely fake brain for contract tests (rule 8's proof that nothing
// outside the adapter socket knows who's thinking). It counts how many
// times it is asked to work, and can be told to misbehave on purpose —
// e.g. touching protected paths (rule 9) or doing nothing at all.

import type { Brain, BrainAskResult, BrainWorkOptions } from "../surface.ts";
import type { TranscriptEntry } from "../surface.ts";

export interface FakeBrainHandle extends Brain {
  readonly calls: number;
  /** The options each work() call received, in call order. */
  readonly workOptions: readonly (BrainWorkOptions | undefined)[];
  /** Every brief work() received, in call order. */
  readonly briefs: readonly string[];
}

export function fakeBrain(
  opts: {
    onWork?: (workdir: string) => void;
    gateChanges?: string;
    /** ask() returns these questions every time it's called. Omitted
     * means the task always looks clear enough to proceed. */
    askQuestions?: string[];
    /** Rule 10: each work() call reports this cost on a "usage"
     * transcript entry (contract/surface.ts's TranscriptEntry). Null
     * reports a cost the brain cannot say; omitted, no usage entry is
     * emitted at all. */
    costUsd?: number | null;
  } = {}
): FakeBrainHandle {
  let calls = 0;
  const workOptions: (BrainWorkOptions | undefined)[] = [];
  const briefs: string[] = [];
  return {
    name: "fake",
    model: "fake-1",
    get calls() {
      return calls;
    },
    get workOptions() {
      return workOptions;
    },
    get briefs() {
      return briefs;
    },
    async ask(_brief: string): Promise<BrainAskResult> {
      return opts.askQuestions ? { questions: opts.askQuestions } : {};
    },
    async work(brief: string, workdir: string, workOpts?: BrainWorkOptions) {
      calls += 1;
      workOptions.push(workOpts);
      briefs.push(brief);
      opts.onWork?.(workdir);
      const transcript: TranscriptEntry[] = [
        { occurredAt: new Date().toISOString(), kind: "text", text: `fake brain saw: ${brief}` },
      ];
      if (opts.costUsd !== undefined) {
        transcript.push({
          occurredAt: new Date().toISOString(),
          kind: "usage",
          text: JSON.stringify({ totalCostUsd: opts.costUsd }),
        });
      }
      return {
        transcript,
        session: "fake-session",
        ...(opts.gateChanges ? { gateChanges: opts.gateChanges } : {}),
      };
    },
  };
}
