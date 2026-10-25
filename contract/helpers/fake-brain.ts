// A completely fake brain for contract tests (rule 8's proof that nothing
// outside the adapter socket knows who's thinking). It counts how many
// times it is asked to work, and can be told to misbehave on purpose —
// e.g. touching protected paths (rule 9) or doing nothing at all.

import type { BrainWorkOptions } from "../surface.ts";
import type { TranscriptEntry, WorkerWriteup } from "../surface.ts";
// Issues #176/#175: the clarifying step's fixed question shape, which
// src/brain/types.ts widens `BrainAskResult` by - imported from the
// implementation for the same reason fake-inspector.ts and
// fake-check-box.ts import their own seams from there.
import type { AskQuestion, Brain, BrainAskResult } from "../../src/index.ts";

/** The quiz the default write-up carries (issue #98): exactly three
 * questions with one-line answers, so an ordinary test still produces a
 * *valid* write-up without spelling this out. A test about a bad quiz
 * passes its own `writeup` instead. */
const FAKE_QUIZ = [
  { question: "What changed?", answer: "The fake brain's own stand-in change." },
  { question: "Why?", answer: "So a test has a valid write-up to work with." },
  { question: "What should the owner watch?", answer: "Nothing - this is a test fixture." },
];

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
    /** ask() returns this question every time it's called, in issue
     * #176's fixed shape - one question with two to four options, no
     * "other" of its own (Fabrica appends that). Omitted means the task
     * always looks clear enough to proceed. */
    askQuestion?: AskQuestion;
    /** Rule 10: each work() call reports this cost on a "usage"
     * transcript entry (contract/surface.ts's TranscriptEntry). Null
     * reports a cost the brain cannot say; omitted, no usage entry is
     * emitted at all. */
    costUsd?: number | null;
    /** Issue #188: the basis each work() call's usage entry reports -
     * omitted (the default) matches a metered adapter; "subscription-
     * estimate" stands in for a flat-rate subscription's own notional
     * figure, which the caps never bind on. Ignored when `costUsd` is
     * omitted (no usage entry at all, so no basis to report either). */
    costBasis?: "metered" | "subscription-estimate";
    /** Rule 10: what each ask() call reports spending (BrainAskResult's
     * costUsd). A fake spends nothing, so it reports 0 unless told
     * otherwise; null reports a cost it cannot say. */
    askCostUsd?: number | null;
    /** The write-up work() returns (BrainWorkResult.writeup). Defaults to
     * a valid one so ordinary tests still see a "done" delivery without
     * constructing it themselves; null returns none at all. */
    writeup?: WorkerWriteup | null;
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
      const costUsd = opts.askCostUsd === undefined ? 0 : opts.askCostUsd;
      return opts.askQuestion ? { question: opts.askQuestion, costUsd } : { costUsd };
    },
    async work(brief: string, workdir: string, workOpts?: BrainWorkOptions) {
      calls += 1;
      workOptions.push(workOpts);
      briefs.push(brief);
      opts.onWork?.(workdir);
      const writeup =
        opts.writeup === undefined
          ? {
              title: "Fake brain update",
              why: "Testing.",
              what: `fake brain saw: ${brief}`,
              how: "Directly.",
              outsideChanges: "None.",
              confidence: 90,
              assumptions: "None.",
              expectedOutcomes: "The fake's work lands as described.",
              deviations: "None.",
              quiz: FAKE_QUIZ,
            }
          : opts.writeup;
      const transcript: TranscriptEntry[] = [
        { occurredAt: new Date().toISOString(), kind: "text", text: `fake brain saw: ${brief}` },
      ];
      if (opts.costUsd !== undefined) {
        transcript.push({
          occurredAt: new Date().toISOString(),
          kind: "usage",
          text: JSON.stringify({ totalCostUsd: opts.costUsd, ...(opts.costBasis ? { costBasis: opts.costBasis } : {}) }),
        });
      }
      return {
        transcript,
        session: "fake-session",
        ...(writeup === null ? {} : { writeup }),
        ...(opts.gateChanges ? { gateChanges: opts.gateChanges } : {}),
      };
    },
  };
}
