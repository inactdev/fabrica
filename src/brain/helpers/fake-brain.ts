// A fake brain for src/-side tests (test-only fixture, not exported from
// the module barrel - contract/helpers/fake-brain.ts is the equivalent
// fixture for the contract suite, changed only under a Client ruling). Unlike that
// simpler fixture, this one actually tracks sessions, so tests here can
// prove the warm-session guarantee from SPEC.md: a retry into the same
// session id continues that session's history rather than restarting it.

import type { Brain, BrainAskResult, BrainWorkOptions, BrainWorkResult, TranscriptEntry } from "../types.ts";

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
  /** The options each work() call received, in call order. */
  readonly workOptions: readonly (BrainWorkOptions | undefined)[];
}

export function fakeBrain(
  opts: {
    onWork?: (brief: string, workdir: string, reasoningEffort?: string) => void;
    gateChanges?: string;
    /** ask() returns these questions every time it's called. Omitted
     * (the default) means the task always looks clear enough to
     * proceed - matching a brain that has nothing to ask. */
    askQuestions?: string[];
    /** ask() throws this instead of returning, every time it's called -
     * stands in for a brain that is genuinely unreachable (the reference
     * adapter's documented credential gap is today's live example),
     * distinct from askQuestions (a brain that answered, just with
     * questions). Ignored if askQuestions is also set. */
    askError?: Error;
    /** Rule 10: what each work() call reports spending, on a "usage"
     * transcript entry (contract/surface.ts's TranscriptEntry). A number
     * is the same cost every call; a function picks it per call (1-based).
     * Null reports a cost the brain cannot say; omitted, no usage entry
     * is emitted at all - an unmeasured call, exactly like the null case
     * to whatever reads it. */
    costUsd?: number | null | ((call: number) => number | null);
  } = {}
): FakeBrainHandle {
  let calls = 0;
  let nextSessionId = 0;
  const historyBySession = new Map<string, string[]>();
  const reasoningEffortsRequested: (string | undefined)[] = [];
  const askCalls: string[] = [];
  const workOptions: (BrainWorkOptions | undefined)[] = [];

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
    get workOptions() {
      return workOptions;
    },
    async ask(brief: string): Promise<BrainAskResult> {
      askCalls.push(brief);
      if (opts.askError) throw opts.askError;
      return opts.askQuestions ? { questions: opts.askQuestions } : {};
    },
    async work(brief, workdir, workOpts) {
      calls += 1;
      workOptions.push(workOpts);
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
      const transcript: TranscriptEntry[] = [entry];
      if (opts.costUsd !== undefined) {
        const costUsd = typeof opts.costUsd === "function" ? opts.costUsd(calls) : opts.costUsd;
        transcript.push({
          occurredAt: new Date().toISOString(),
          kind: "usage",
          text: JSON.stringify({ totalCostUsd: costUsd }),
        });
      }
      const result: BrainWorkResult = {
        transcript,
        session,
      };
      if (opts.gateChanges !== undefined) result.gateChanges = opts.gateChanges;
      return result;
    },
  };
}
