// A completely fake brain for contract tests (rule 8's proof that nothing
// outside the adapter socket knows who's thinking). It counts how many
// times it is asked to work, and can be told to misbehave on purpose —
// e.g. touching protected paths (rule 9) or doing nothing at all.

import type { Brain } from "../surface.ts";

export interface FakeBrainHandle extends Brain {
  readonly calls: number;
}

export function fakeBrain(
  opts: { onWork?: (workdir: string) => void; gateChanges?: string } = {}
): FakeBrainHandle {
  let calls = 0;
  return {
    name: "fake",
    model: "fake-1",
    get calls() {
      return calls;
    },
    async work(brief: string, workdir: string) {
      calls += 1;
      opts.onWork?.(workdir);
      return {
        transcript: `fake brain saw: ${brief}`,
        session: "fake-session",
        ...(opts.gateChanges ? { gateChanges: opts.gateChanges } : {}),
      };
    },
  };
}
