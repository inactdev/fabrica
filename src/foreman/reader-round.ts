// The code reader's place in the loop (inspector issue #34 and its
// amendment): after Inspector's green, the whole diff goes to the
// reader; its findings go back to the same machine as a fix round
// before the delivery; it never blocks and never approves.
//
// WHERE this sits, and why. Between `runAttempts` resolving and
// `recordRoundResult` writing the delivery - the one shared tail issue
// #182 established, which `do.ts`'s round and `verdict.ts`'s fix round
// both reach. That placement is what makes "once per task, on the first
// pass Inspector turns green" expressible at all: a task whose first
// round goes red turns green for the first time in a *fix* round, so
// the hook has to be somewhere both callers pass through.
//
// WHY NOT inside the attempt loop, where the green verdict is already
// in hand and a correction brief already exists for a red check - the
// obvious smaller change, rejected on two counts:
//
//   1. A pass run from inside that loop spends rule 3's counted attempt
//      budget. A fix round deliberately draws from no budget (issue
//      #65: "separate the two, unlimited but counted"), and the
//      reader's pass is a fix round, not an attempt at the task. A task
//      whose attempts were already used would silently never be read.
//   2. The judge runs per attempt, so the reader would read every green
//      attempt of every round. The ruling is once per task.
//
// THE FIVE RULINGS this file implements, in the Client's own terms:
//
//   - Once per task, on the first pass Inspector turns green. The
//     post-fix pass delivers straight after Inspector's green with no
//     second read, so at most one reader fix round ever exists.
//   - All findings go over as-is. No severity, no filtering, no
//     ranking; the machine may decline one with a written reason.
//   - No findings means no fix round: the delivery proceeds and the
//     record says `reader-clean`.
//   - A failed read never blocks the delivery and is never silent.
//   - The findings and the model used are on the record and in the
//     delivery.

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "../record/index.ts";
import { baseCommitOf, diffPatch } from "../delivery/index.ts";
import {
  parseDeclines,
  readDiff,
  readerCorrection,
  readerLabel,
  readerOnDelivery,
  READER_DECLINES_FILE,
} from "../reader/index.ts";
import type { ReaderOnDelivery, ReaderOutcome, ReaderReport, ResolvedReader } from "../reader/index.ts";
import type { RoundReader } from "./reader.ts";
import { skipIfUnchanged } from "./judge.ts";
import type { Judge } from "./judge.ts";
import type { AttemptLoopResult } from "./attempts.ts";
import type { CheckMode } from "./judge.ts";
import type { ProductionLine } from "../../contract/surface.ts";
import type { Receipt } from "../inspector/types.ts";

/** `"reader-clean"`/`"reader-flagged"` details. */
export interface ReaderReadDetails {
  model: string;
  findings: ReaderReport["findings"];
  diffBytes: number;
}

/** `"reader-failed"` details. */
export interface ReaderFailedDetails {
  model: string;
  error: string;
}

/** One more worker pass on this same line, which only the caller can
 * run: it owns the brief, the session, the spend limits, the network
 * policy and every callback `runAttempts` needs, and threading all of
 * that through here would be a second copy of two long call sites.
 *
 * `judge` is supplied by THIS module rather than the caller's own,
 * because the wrapping matters (see `readAndFlag`). `startAttempt` is
 * where the pass's own receipt numbering continues from.
 */
export type ReaderFixPass = (opts: {
  correction: string;
  judge: Judge;
  startAttempt: number;
  /** Runs immediately before the pass's commit: reads the worker's
   * declines file out of the worktree and deletes it, so it never
   * reaches the diff. The caller hands this to `runAttempts` as its
   * `beforeCommit`, which is the one hook that runs at that moment. */
  beforeCommit: () => Promise<undefined>;
}) => Promise<AttemptLoopResult>;

/** What the round's tail gets back: the attempt result whose judgement
 * it should honour, plus whatever the other pass contributed. */
export interface ReaderRoundResult {
  attempts: AttemptLoopResult;
  /** Chronologically earlier passes' receipts, for
   * `recordRoundResult`'s `roundReceipts`. */
  earlierReceipts: Receipt[];
  /** The same, for its `roundGateDeclarations`. */
  earlierGateDeclarations: string[];
  /** What the delivery should carry, when this task reached a read. */
  reader?: ReaderOnDelivery;
}

/** Everything about this round that decides whether a read happens. */
export interface ReaderRoundContext {
  line: ProductionLine;
  baseCommit: string;
  mode: CheckMode;
  /** The reader settled at the start of the round, or the reason there
   * isn't one (`reader.ts`'s `readerForRound`). Undefined only where no
   * read can happen anyway - a self-tested round - so nothing here has
   * to decide that twice. */
  reader?: RoundReader;
  /** This task's own events, as the caller already read them. True when
   * any read has already landed - clean, flagged or failed. */
  alreadyRead: boolean;
  fixPass: ReaderFixPass;
  /** The round's own judge, unwrapped. */
  judge: Judge;
  /** Where the fix pass's receipt numbering continues from. */
  startAttempt: number;
  /** Replaced wholesale in tests, so nothing in the default `npm test`
   * run opens a socket or needs a credential. */
  read?: DiffReader;
}

/** The one call the reader stage makes, as a seam: a settled reader and
 * a diff in, a report out, throwing for every way a read can fail.
 * Threaded from `createForeman`'s own options the same way `inspector`
 * and `checkBox` are - a fake replaces the call, never the `[reader]`
 * configuration, so a test still has to configure a reader to reach
 * one. */
export type DiffReader = (reader: ResolvedReader, diff: string) => Promise<ReaderReport>;

/**
 * Reads this round's diff and, if anything was flagged, runs the one
 * reader fix pass - or does nothing at all and hands the round's own
 * result straight back, which is the common case.
 *
 * Never throws for a reader problem. Every way a read can fail becomes
 * a recorded `"reader-failed"` and an ordinary return, because the
 * reader is a flagger: one that cannot run must not become a gate by
 * failing (the Client's own ruling, which is the only place "it never
 * blocks" is allowed to win over "everything fails loudly" - and it
 * never wins over being *heard*, which is what that ruling protects).
 */
export async function readAndFlag(
  recordHome: string,
  taskId: string,
  ctx: ReaderRoundContext,
  attempts: AttemptLoopResult
): Promise<ReaderRoundResult> {
  const unchanged: ReaderRoundResult = { attempts, earlierReceipts: [], earlierGateDeclarations: [] };
  if (!shouldRead(ctx, attempts)) return unchanged;

  // No reader could be settled for this project. `fabrica do` refuses a
  // task for this before it ever starts, so a real task cannot get
  // here; what can is a library caller, or a `[reader]` the Client
  // removed between rounds. Recorded as a failed read with the
  // configuration problem as its reason - never skipped quietly, and
  // never allowed to throw away the green round that reached it.
  const settled = ctx.reader!;
  if (!("reader" in settled)) {
    // Deliberately NOT `settled.problem` verbatim: that message is
    // `fabrica do`'s, several paragraphs of exactly-what-to-paste, which
    // is right where the Client is being stopped and asked to fix it and
    // wrong as a line on a record, a status row and a delivery. Its
    // first line only, plus where the full version lives.
    const why = `${firstLine(settled.problem)} (\`fabrica do\` on this project prints the lines to add)`;
    return { ...unchanged, reader: readerOnDelivery(recordFailure(recordHome, taskId, NO_READER, why)) };
  }

  const outcome = await read(recordHome, taskId, ctx, settled.reader);
  if (outcome.kind !== "flagged") {
    return { ...unchanged, reader: readerOnDelivery(outcome) };
  }

  // The fix pass. Its judge is wrapped so a worker that changed nothing
  // - the honest outcome when it declined every finding - is never
  // handed back to Inspector: re-handing an already-reviewed commit
  // only draws a refusal. Left unwrapped that refusal would throw away
  // a green delivery; left wrapped without the handling below,
  // `recordRoundResult` would deliver "nothing-changed" and throw away
  // the same green. So the pass runs, its money is counted, and the
  // original green judgement stands.
  const priorHead = baseCommitOf(ctx.line.workdir);
  let declinesRaw: string | undefined;
  const fixResult = await ctx.fixPass({
    correction: readerCorrection(outcome.report.findings),
    judge: skipIfUnchanged(ctx.judge, ctx.line.workdir, priorHead),
    startAttempt: ctx.startAttempt,
    beforeCommit: async () => {
      declinesRaw = takeDeclinesFile(ctx.line.workdir);
      return undefined;
    },
  });

  const parsed = parseDeclines(declinesRaw, outcome.report.findings.length);
  const reported = readerOnDelivery({
    ...outcome,
    declines: parsed.declines,
    ...(parsed.problem === undefined ? {} : { declineProblem: parsed.problem }),
  });

  // Which pass's judgement the round reports.
  //
  // Ordinarily the fix pass's own: the worker changed something, so it
  // was judged on its merits, and a pass that went red delivers red for
  // the Client to rule on - the reader not blocking is about the reader
  // *stage*, never about a worker pass that then fails its own check.
  //
  // But a pass the worker genuinely changed nothing in - the honest
  // outcome when it declined every finding - was never judged at all, so
  // the round keeps its own green judgement and write-up: those describe
  // the commit that is actually on the branch. Either way the pass's
  // receipt is the last one and the round's own is the earlier, so the
  // record stays chronological and rule 10 still sees the money. A cap
  // or meter stop in that pass is a real stop and wins regardless.
  const keepsEarlierGreen =
    fixResult.lastJudgement.kind === "unchanged" && !fixResult.capStop && !fixResult.meterStop;
  return {
    attempts: keepsEarlierGreen
      ? {
          ...fixResult,
          lastGate: attempts.lastGate,
          lastJudgement: attempts.lastJudgement,
          finalMessage: attempts.finalMessage,
          writeup: attempts.writeup,
        }
      : fixResult,
    earlierReceipts: attempts.receipts,
    earlierGateDeclarations: declarationsOf(attempts),
    reader: reported,
  };
}

/** What the model is called in the record when there was no model: the
 * read never reached one, so naming a vendor would be a fiction. */
const NO_READER = "none configured";

/** The three conditions, all of them necessary. A reader that could not
 * be settled is deliberately NOT one of them - that is a read that was
 * due and failed, which has to be said, not a read that never applied.
 *
 * 1. Inspector mode. "After Inspector's green" is the trigger, and a
 *    self-tested task (no `.inspector.json` at its base commit, or no
 *    Inspector installed) never has one.
 * 2. Inspector actually called this pass green - and the gate agrees,
 *    which is how a green inspection whose pull request then went red
 *    (issue #267) correctly waits for the round that clears it.
 * 3. This task has not been read yet. Once per task.
 */
function shouldRead(ctx: ReaderRoundContext, attempts: AttemptLoopResult): boolean {
  if (ctx.mode.mode !== "inspector" || ctx.reader === undefined) return false;
  if (ctx.alreadyRead) return false;
  const judgement = attempts.lastJudgement;
  return judgement.kind === "verdict" && judgement.gate.green && judgement.inspection?.verdict === "green";
}

/** The read itself, with every failure turned into a recorded one. */
async function read(
  recordHome: string,
  taskId: string,
  ctx: ReaderRoundContext,
  reader: ResolvedReader
): Promise<ReaderOutcome> {
  const readDiffFn = ctx.read ?? readDiff;
  let report: ReaderReport;
  try {
    report = await readDiffFn(reader, diffPatch(ctx.line.project, ctx.line.branch, ctx.baseCommit));
  } catch (err) {
    return recordFailure(recordHome, taskId, readerLabel(reader), err instanceof Error ? err.message : String(err));
  }

  const details: ReaderReadDetails = {
    model: report.model,
    findings: report.findings,
    diffBytes: report.diffBytes,
  };
  appendEvent(recordHome, {
    taskId,
    name: report.findings.length === 0 ? "reader-clean" : "reader-flagged",
    details,
  });
  return report.findings.length === 0 ? { kind: "clean", report } : { kind: "flagged", report, declines: [] };
}

/** The one place a failed read is written down, whatever failed: the
 * configuration, the call, or the answer. One writer, so a read that
 * did not happen can never be on the delivery without being on the
 * record, or counted in one place and not the other. */
function recordFailure(recordHome: string, taskId: string, model: string, error: string): ReaderOutcome {
  // Folded to one line, whatever it was. This string becomes a
  // `fabrica status` row, a `fabrica log` entry and a `delivery.md`
  // field, and a provider's multi-line error body would otherwise break
  // every one of them into fragments that read as separate facts.
  const failure: ReaderFailedDetails = { model, error: oneLine(error) };
  appendEvent(recordHome, { taskId, name: "reader-failed", details: failure });
  return { kind: "failed", failure };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function firstLine(text: string): string {
  return text.split("\n")[0].trim();
}

/** The worker's declines file, read and removed in one go. Removed
 * whether or not it parsed, and whether or not it was there: this runs
 * immediately before the commit, and a file left behind would be
 * committed as part of the change. */
function takeDeclinesFile(workdir: string): string | undefined {
  const path = join(workdir, READER_DECLINES_FILE);
  let raw: string | undefined;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Not there is the ordinary case: the worker acted on every
    // finding. Unreadable for any other reason is the same answer -
    // there is nothing to report from it either way, and the round is
    // not the place to explain a filesystem.
    return undefined;
  }
  try {
    rmSync(path, { force: true });
  } catch {
    // Left behind, so it will land in the commit. Nothing here can do
    // better, and failing the round over a stray file would be worse
    // than the stray file: the Client sees it in the diff.
  }
  return raw;
}

/** A round's own gate declaration as a list, for carrying into the
 * next pass's merge. */
function declarationsOf(attempts: AttemptLoopResult): string[] {
  const declared = attempts.declaredGateChanges;
  return typeof declared === "string" && declared.trim().length > 0 ? [declared] : [];
}
