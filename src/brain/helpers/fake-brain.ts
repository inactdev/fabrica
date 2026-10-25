// A fake brain for src/-side tests (test-only fixture, not exported from
// the module barrel - contract/helpers/fake-brain.ts is the equivalent
// fixture for the contract suite, changed only under a Client ruling). Unlike that
// simpler fixture, this one actually tracks sessions, so tests here can
// prove the warm-session guarantee from SPEC.md: a retry into the same
// session id continues that session's history rather than restarting it.

import type { Brain, BrainAskResult, BrainWorkOptions, BrainWorkResult, TranscriptEntry, WorkerWriteup } from "../types.ts";
import type { AskQuestion } from "../ask-shape.ts";
import type { MeterReading } from "../meters.ts";
import { MODEL_TRANSCRIPT_KIND } from "../model.ts";

/** The quiz the default write-up carries (issue #98): exactly three
 * questions with one-line answers, so an ordinary test still produces a
 * *valid* write-up. A test about a bad quiz passes its own `writeup`. */
const FAKE_QUIZ = [
  { question: "What changed?", answer: "The fake brain's own stand-in change." },
  { question: "Why?", answer: "So a test has a valid write-up to work with." },
  { question: "What should the owner watch?", answer: "Nothing - this is a test fixture." },
];

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
    /** Rule 9's declaration each work() call returns. A string is the same
     * declaration every call; a function picks it per call (1-based), the
     * way `costUsd` below does - which is what a test about declarations
     * across several rounds needs. */
    gateChanges?: string | ((call: number) => string | undefined);
    /** ask() returns this question every time it's called, in issue
     * #176's fixed shape - one question, two to four options, "other"
     * left out because Fabrica appends it. Omitted (the default) means
     * the task always looks clear enough to proceed - matching a brain
     * that has nothing to ask. A function picks per call (1-based),
     * which is what a test about the re-ask loop needs: return a
     * badly-shaped question first and a good one second. */
    askQuestion?: AskQuestion | BrainAskResult | ((call: number) => AskQuestion | BrainAskResult | undefined);
    /** ask() throws this instead of returning, every time it's called -
     * stands in for a brain that is genuinely unreachable (the reference
     * adapter's documented credential gap is today's live example),
     * distinct from askQuestion (a brain that answered, just with a
     * question). Ignored if askQuestion is also set. */
    askError?: Error;
    /** Issue #199: work() throws this instead of returning, standing in
     * for a model call that was dropped in transit (or refused). A
     * function picks per call (1-based, counting every call this fake
     * receives - a transport retry is a second call and so a second
     * number), and returning undefined for a call lets that one
     * through: `(call) => (call === 1 ? dropped : undefined)` is a brain
     * that drops the first call and answers the retry. An Error alone
     * throws on every call. */
    workError?: Error | ((call: number) => Error | undefined);
    /** Rule 10: what each work() call reports spending, on a "usage"
     * transcript entry (contract/surface.ts's TranscriptEntry). A number
     * is the same cost every call; a function picks it per call (1-based).
     * Null reports a cost the brain cannot say; omitted, no usage entry
     * is emitted at all - an unmeasured call, exactly like the null case
     * to whatever reads it. */
    costUsd?: number | null | ((call: number) => number | null);
    /** Issue #188: the basis each work() call's usage entry reports -
     * omitted (the default) matches a metered adapter; "subscription-
     * estimate" stands in for a flat-rate subscription's own notional
     * figure, which the caps never bind on. Ignored when `costUsd` is
     * omitted (no usage entry at all, so no basis to report either). */
    costBasis?: "metered" | "subscription-estimate";
    /** Rule 10: what each ask() call reports spending. A fake spends
     * nothing, so 0 unless told otherwise; null reports a cost it cannot
     * say. */
    askCostUsd?: number | null;
    /** The write-up work() returns (BrainWorkResult.writeup). Defaults to
     * a valid one so ordinary tests still see a "done" delivery without
     * constructing it themselves; null returns none at all. */
    writeup?: WorkerWriteup | null;
    /** Issue #184: this fake's own `Brain.model` label - what a receipt
     * falls back to when the brain reported no model for the call
     * itself. Defaults to "fake-1". */
    model?: string;
    /** Issue #184: the model each work() call reports actually having
     * run, on the reserved "model" transcript entry (../model.ts) - what
     * a streaming adapter reads off its session-init line, and what a
     * receipt prefers over the label above. Omitted, no entry is
     * emitted, standing in for a brain that cannot report one. */
    reportedModel?: string;
    /** Issue #189: the subscription-meter reading each work() call
     * reports, on a "meters" transcript entry (../meters.ts). Omitted,
     * no entry is emitted at all - a brain that cannot report them,
     * which every receipt then records as `meters: null`. */
    meters?: MeterReading;
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
    model: opts.model ?? "fake-1",
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
      const costUsd = opts.askCostUsd === undefined ? 0 : opts.askCostUsd;
      const asked = typeof opts.askQuestion === "function" ? opts.askQuestion(askCalls.length) : opts.askQuestion;
      if (asked === undefined) return { costUsd };
      // A whole BrainAskResult passes straight through - that is how a
      // test hands Fabrica a deliberately badly-shaped ask (free-form
      // `questions`, an unasked question) instead of a valid one. A bare
      // question is the common case and is wrapped.
      return isQuestion(asked) ? { question: asked, costUsd } : { ...asked, costUsd };
    },
    async work(brief, workdir, workOpts) {
      calls += 1;
      workOptions.push(workOpts);
      reasoningEffortsRequested.push(workOpts?.reasoningEffort);
      // Issue #199: thrown before anything is recorded on this fake, the
      // way a call that never came back leaves no transcript, no session
      // and no write-up behind it.
      const workError = typeof opts.workError === "function" ? opts.workError(calls) : opts.workError;
      if (workError) throw workError;
      opts.onWork?.(brief, workdir, workOpts?.reasoningEffort);

      const session = workOpts?.session ?? `fake-session-${++nextSessionId}`;
      const history = historyBySession.get(session) ?? [];
      history.push(brief);
      historyBySession.set(session, history);

      const saw = `fake brain saw ${history.length} brief(s) on session ${session}: ${history.join(" | ")}`;
      const writeup =
        opts.writeup === undefined
          ? {
              title: "Fake brain update",
              why: "Testing.",
              what: saw,
              how: "Directly.",
              outsideChanges: "None.",
              confidence: 90,
              assumptions: "None.",
              expectedOutcomes: "The fake's work lands as described.",
              deviations: "None.",
              quiz: FAKE_QUIZ,
            }
          : opts.writeup;
      const entry: TranscriptEntry = {
        occurredAt: new Date().toISOString(),
        kind: "text",
        text: saw,
      };
      const transcript: TranscriptEntry[] = [entry];
      if (opts.reportedModel !== undefined) {
        transcript.push({
          occurredAt: new Date().toISOString(),
          kind: MODEL_TRANSCRIPT_KIND,
          text: opts.reportedModel,
        });
      }
      if (opts.costUsd !== undefined) {
        const costUsd = typeof opts.costUsd === "function" ? opts.costUsd(calls) : opts.costUsd;
        transcript.push({
          occurredAt: new Date().toISOString(),
          kind: "usage",
          text: JSON.stringify({ totalCostUsd: costUsd, ...(opts.costBasis ? { costBasis: opts.costBasis } : {}) }),
        });
      }
      if (opts.meters !== undefined) {
        transcript.push({
          occurredAt: new Date().toISOString(),
          kind: "meters",
          text: JSON.stringify(opts.meters),
        });
      }
      const result: BrainWorkResult = {
        transcript,
        session,
        ...(writeup === null ? {} : { writeup }),
      };
      const gateChanges = typeof opts.gateChanges === "function" ? opts.gateChanges(calls) : opts.gateChanges;
      if (gateChanges !== undefined) result.gateChanges = gateChanges;
      return result;
    },
  };
}

/** Whether the fixture was given a bare question or a whole ask result -
 * `options` is the one key only a question has. */
function isQuestion(asked: AskQuestion | BrainAskResult): asked is AskQuestion {
  return "options" in asked;
}
