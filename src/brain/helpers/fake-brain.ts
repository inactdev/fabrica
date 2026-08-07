// A fake brain for src/-side tests (test-only fixture, not exported from
// the module barrel - contract/helpers/fake-brain.ts is the equivalent
// fixture for the contract suite and is off limits to edit). Unlike that
// simpler fixture, this one actually tracks sessions, so tests here can
// prove the warm-session guarantee from SPEC.md: a retry into the same
// session id continues that session's history rather than restarting it.

import type { Brain, BrainAskResult, BrainWorkResult, TranscriptEntry } from "../types.ts";

export interface FakeBrainHandle extends Brain {
  readonly calls: number;
  /** Every brief passed to work(), grouped by the session id it landed
   * on - proof that same-session calls accumulate instead of
   * restarting. */
  readonly historyBySession: ReadonlyMap<string, string[]>;
  /** The reasoningEffort value requested on each call, in call order
   * (undefined where none was passed) - proof that a value is recorded
   * as requested even when this fake, like any adapter, does not
   * recognize it and ignores it rather than failing. */
  readonly reasoningEffortsRequested: readonly (string | undefined)[];
  /** Every brief passed to ask(), in call order. */
  readonly askCalls: readonly string[];
}

export function fakeBrain(
  opts: {
    onWork?: (brief: string, workdir: string, reasoningEffort?: string) => void;
    gateChanges?: string;
    /** ask() returns these questions every time it's called. Omitted
     * (the default) means the task always looks clear enough to
     * proceed - matching a brain that has nothing to ask. */
    askQuestions?: string[];
  } = {}
): FakeBrainHandle {
  let calls = 0;
  let nextSessionId = 0;
  const historyBySession = new Map<string, string[]>();
  const reasoningEffortsRequested: (string | undefined)[] = [];
  const askCalls: string[] = [];

  return {
    name: "fake",
    model: "fake-1",
    get calls() {
      return calls;
    },
    get historyBySession() {
      return historyBySession;
    },
    get reasoningEffortsRequested() {
      return reasoningEffortsRequested;
    },
    get askCalls() {
      return askCalls;
    },
    async ask(brief: string): Promise<BrainAskResult> {
      askCalls.push(brief);
      return opts.askQuestions ? { questions: opts.askQuestions } : {};
    },
    async work(brief, workdir, workOpts) {
      calls += 1;
      reasoningEffortsRequested.push(workOpts?.reasoningEffort);
      opts.onWork?.(brief, workdir, workOpts?.reasoningEffort);

      const session = workOpts?.session ?? `fake-session-${++nextSessionId}`;
      const history = historyBySession.get(session) ?? [];
      history.push(brief);
      historyBySession.set(session, history);

      const entry: TranscriptEntry = {
        occurredAt: new Date().toISOString(),
        kind: "text",
        text: `fake brain saw ${history.length} brief(s) on session ${session}: ${history.join(" | ")}`,
      };
      const result: BrainWorkResult = {
        transcript: [entry],
        session,
      };
      if (opts.gateChanges !== undefined) result.gateChanges = opts.gateChanges;
      return result;
    },
  };
}
