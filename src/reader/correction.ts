// What the worker is told about the reader's findings, and how it
// answers back.
//
// Every finding goes over as-is (the Client's own ruling: "All findings
// are handed over as-is; the machine may decline a finding with a
// written reason, recorded in the delivery beside the finding"). So
// there is no filtering, no ranking and no severity here either - the
// brief hands the list over, numbered, and says plainly that declining
// is a real option as long as a reason comes with it.
//
// Why a file in the worker's own workdir rather than a field on the
// write-up: `BrainWorkResult` has no free-form structured channel -
// `writeup` is a fixed schema for pull request bodies - and widening a
// ratified contract shape for one round's bookkeeping would be the
// wrong trade when a writable workdir is a channel every worker already
// has. src/quiz/recheck.ts made the same call for the same reason. The
// difference here is that this worktree *is* committed, so the file must
// not survive into the diff: the caller reads and deletes it in
// attempts.ts's `beforeCommit` hook, which runs immediately before the
// commit (see src/foreman/reader-round.ts).

import type { ReaderDecline, ReaderFinding } from "./types.ts";

/** The file the worker writes its declines to, in the root of its own
 * workdir. Dot-prefixed so that, in the one case where something goes
 * wrong and it is not deleted in time, it is at least obviously not
 * part of the change. */
export const READER_DECLINES_FILE = ".fabrica-reader-declines.json";

/**
 * The correction a reader's findings become. Appended to the round's
 * own brief by the caller, the same way a Client's `fix` note is - this
 * is the round's own words only; `workerBrief` puts the standing prefix
 * in front of the whole thing at the call site.
 */
export function readerCorrection(findings: ReaderFinding[]): string {
  const numbered = findings
    .map((finding, index) => `${index + 1}. ${finding.file}: ${finding.finding}`)
    .join("\n");
  return (
    `An independent check has already passed this change, and a code reader has since read the whole diff ` +
    `and flagged the following for the reviewer. The reader is not a gate - it did not block this change ` +
    `and it cannot approve it - so these are things to look at, not orders.\n\n` +
    `${numbered}\n\n` +
    `Work through all ${findings.length === 1 ? "of it" : `${findings.length} of them`}. Fix what is ` +
    `genuinely wrong, and keep everything that was already right - the change passed its check as it ` +
    `stands, so do not rewrite what these findings do not touch.\n\n` +
    `You may decline a finding you disagree with, but never silently: write a reason for every one you ` +
    `decline into \`${READER_DECLINES_FILE}\` in the root of your working directory, as JSON in exactly ` +
    `this shape, using the numbers above:\n\n` +
    `  {"declines": [{"finding": 1, "reason": "<why this one needs no change>"}]}\n\n` +
    `Write that file only if you are declining something; leave it out entirely if you acted on all of ` +
    `them. Your reasons are shown to the reviewer beside the findings they answer, so write them for ` +
    `someone who has not read the diff. Do not mention the file itself anywhere in your write-up.`
  );
}

/** What one worker's answer amounted to: the declines it gave, plus a
 * sentence about anything in its file that could not be read. The
 * problem rides onto the record and the delivery rather than failing
 * the round - a worker that fumbled the format has still done the work,
 * and the reader stage never blocks a delivery. */
export interface ParsedDeclines {
  declines: ReaderDecline[];
  problem?: string;
}

/**
 * Reads a worker's declines file. `raw` is its contents, or undefined
 * when the worker wrote none - which is the ordinary case and means it
 * acted on every finding.
 *
 * `findingCount` bounds the numbers: a decline naming a finding that
 * does not exist is dropped and reported, never shown to the Client
 * beside a finding it was not about.
 */
export function parseDeclines(raw: string | undefined, findingCount: number): ParsedDeclines {
  if (raw === undefined || raw.trim().length === 0) return { declines: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      declines: [],
      problem: `the worker's declines file was not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  const entries = (parsed as Record<string, unknown> | null)?.declines;
  if (!Array.isArray(entries)) {
    return { declines: [], problem: `the worker's declines file held no "declines" array` };
  }

  const declines: ReaderDecline[] = [];
  const dropped: string[] = [];
  for (const entry of entries) {
    const record = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const finding = record.finding;
    const reason = typeof record.reason === "string" ? record.reason.trim() : "";
    const numbered =
      typeof finding === "number" && Number.isInteger(finding) && finding >= 1 && finding <= findingCount;
    if (!numbered || reason.length === 0) {
      dropped.push(JSON.stringify(entry));
      continue;
    }
    declines.push({ finding, reason });
  }

  return {
    declines,
    ...(dropped.length === 0
      ? {}
      : {
          problem:
            `${dropped.length} of the worker's declines named no finding in range 1-${findingCount} or gave ` +
            `no reason, and were dropped: ${dropped.join(", ")}`,
        }),
  };
}
