// A fake brain for src/-side tests (test-only fixture, not exported from
// the module barrel - contract/helpers/fake-brain.ts is the equivalent
// fixture for the contract suite and is off limits to edit). Unlike that
// simpler fixture, this one actually tracks sessions, so tests here can
// prove the warm-session guarantee from SPEC.md: a retry into the same
// session id continues that session's history rather than restarting it.

import type { Brain, BrainWorkResult } from "../types.ts";

export interface FakeBrainHandle extends Brain {
  readonly calls: number;
  /** Every brief passed to work(), grouped by the session id it landed
   * on - proof that same-session calls accumulate instead of restarting. */
  readonly historyBySession: ReadonlyMap<string, string[]>;
}

export function fakeBrain(
  opts: { onWork?: (brief: string, workdir: string) => void; gateChanges?: string } = {}
): FakeBrainHandle {
  let calls = 0;
  let nextSessionId = 0;
  const historyBySession = new Map<string, string[]>();

  return {
    name: "fake",
    model: "fake-1",
    get calls() {
      return calls;
    },
    get historyBySession() {
      return historyBySession;
    },
    async work(brief, workdir, workOpts) {
      calls += 1;
      opts.onWork?.(brief, workdir);

      const session = workOpts?.session ?? `fake-session-${++nextSessionId}`;
      const briefs = historyBySession.get(session) ?? [];
      briefs.push(brief);
      historyBySession.set(session, briefs);

      const result: BrainWorkResult = {
        transcript: `fake brain saw ${briefs.length} brief(s) on session ${session}: ${briefs.join(" | ")}`,
        session,
      };
      if (opts.gateChanges !== undefined) result.gateChanges = opts.gateChanges;
      return result;
    },
  };
}
