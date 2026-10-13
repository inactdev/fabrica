// Turns a worker's own final message (final-message.ts) into the commit
// message Fabrica writes onto the branch, and the pull request title/body
// Inspector is asked to open - the human write-up a reviewer reads, never
// the raw task text ("pull requests must read like a human wrote them").
// A worker whose final message doesn't parse still gets a commit - the
// round's own outcome is what says the write-up was missing (attempts.ts
// forces the gate red so there's a further attempt or an honest
// failure-report), so this always returns something to commit, falling
// back to a label naming what's missing rather than ever reaching for the
// task's own words.

import { describeMissingFinalMessage, lastFinalMessageText, parseFinalMessage, renderFinalMessageBody } from "./final-message.ts";
import type { TranscriptEntry } from "../brain/index.ts";

export interface FinalMessageForCommit {
  title: string;
  body: string;
  /** false when the worker's final message didn't parse - title/body are
   * then Fabrica's own fallback wording, naming what was missing. */
  ok: boolean;
  missing?: string[];
}

export function finalMessageFor(transcript: TranscriptEntry[], fallbackTitle: string): FinalMessageForCommit {
  const result = parseFinalMessage(lastFinalMessageText(transcript));
  if (result.ok) {
    return { title: result.message.title, body: renderFinalMessageBody(result.message), ok: true };
  }
  return {
    title: fallbackTitle,
    body: `${describeMissingFinalMessage(result.missing)}.`,
    ok: false,
    missing: result.missing,
  };
}

export function renderCommitMessage(message: FinalMessageForCommit): string {
  return `${message.title}\n\n${message.body}`;
}
