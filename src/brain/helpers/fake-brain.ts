// A fake brain for src/-side tests (test-only fixture, not exported from
// the module barrel - contract/helpers/fake-brain.ts is the equivalent
// fixture for the contract suite and is off limits to edit). Unlike that
// simpler fixture, this one actually tracks sessions, so tests here can
// prove the warm-session guarantee from SPEC.md: a retry into the same
// session id continues that session's history rather than restarting it.

import type { Brain, BrainWorkResult } from "../types.ts";

export interface FakeBrainHandle extends Brain {
  readonly calls: number;
  /** Every set of instructions passed to work(), grouped by the session
   * id it landed on - proof that same-session calls accumulate instead
   * of restarting. */
  readonly historyBySession: ReadonlyMap<string, string[]>;
  /** The effort value requested on each call, in call order (undefined
   * where none was passed) - proof that a value is recorded as
   * requested even when this fake, like any adapter, does not
   * recognize it and ignores it rather than failing. */
  readonly effortsRequested: readonly (string | undefined)[];
}

export function fakeBrain(
  opts: {
    onWork?: (instructions: string, workdir: string, effort?: string) => void;
    gateChanges?: string;
  } = {}
): FakeBrainHandle {
  let calls = 0;
  let nextSessionId = 0;
  const historyBySession = new Map<string, string[]>();
  const effortsRequested: (string | undefined)[] = [];

  return {
    name: "fake",
    model: "fake-1",
    get calls() {
      return calls;
    },
    get historyBySession() {
      return historyBySession;
    },
    get effortsRequested() {
      return effortsRequested;
    },
    async work(instructions, workdir, workOpts) {
      calls += 1;
      effortsRequested.push(workOpts?.effort);
      opts.onWork?.(instructions, workdir, workOpts?.effort);

      const session = workOpts?.session ?? `fake-session-${++nextSessionId}`;
      const history = historyBySession.get(session) ?? [];
      history.push(instructions);
      historyBySession.set(session, history);

      const result: BrainWorkResult = {
        transcript: `fake brain saw ${history.length} instruction(s) on session ${session}: ${history.join(" | ")}`,
        session,
      };
      if (opts.gateChanges !== undefined) result.gateChanges = opts.gateChanges;
      return result;
    },
  };
}
