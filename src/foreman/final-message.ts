// What a worker's final message in a session must look like so Fabrica
// never has to fall back to the task's own words for a commit message or
// a pull request ("pull requests must read like a human wrote them"): a
// title line of at most FINAL_MESSAGE_TITLE_MAX_LENGTH characters, then
// four sections, each introduced by its own name and a colon on its own
// line - What, Why, How, and Deviations, in that order (Deviations last,
// since it's the one the Client reads to see what to double-check).
// Parsing, and naming what's missing, live here; pr-body.ts turns a
// parse into the actual commit message / pull request text, fallback
// included.

import type { TranscriptEntry } from "../brain/index.ts";

export const FINAL_MESSAGE_TITLE_MAX_LENGTH = 60;

export const FINAL_MESSAGE_SECTIONS = ["What", "Why", "How", "Deviations"] as const;
export type FinalMessageSection = (typeof FINAL_MESSAGE_SECTIONS)[number];

export interface ParsedFinalMessage {
  title: string;
  sections: Record<FinalMessageSection, string>;
}

export type FinalMessageResult = { ok: true; message: ParsedFinalMessage } | { ok: false; missing: string[] };

/** The worker's own last word in a session - a transcript holds the whole
 * conversation (reasoning, tool calls, tool results too), and only the
 * last "text" kind entry is the worker's own closing write-up (see
 * the reference CLI adapter's own docs for what each transcript kind
 * means). Read from the end rather than assuming it's the last entry of
 * any kind, since a brain may append synthetic trailing entries (e.g.
 * "usage") after the worker's own last word. */
export function lastFinalMessageText(transcript: TranscriptEntry[]): string | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].kind === "text") return transcript[i].text;
  }
  return undefined;
}

const SECTION_HEADER = /^(What|Why|How|Deviations):[ \t]*(.*)$/;

/** Parses a worker's final message. The title is the first non-blank
 * line; everything after it is scanned for the four section headers,
 * each collecting every line (inline first line included) until the next
 * header or the end of the message. Order in the source doesn't matter -
 * only presence does; Deviations is "last" in the rendered commit/PR
 * body (pr-body.ts), not in what this function requires. */
export function parseFinalMessage(raw: string | undefined): FinalMessageResult {
  const missing: string[] = [];
  const lines = (raw ?? "").split("\n");

  let i = 0;
  while (i < lines.length && lines[i].trim().length === 0) i++;
  const candidate = lines[i]?.trim();
  // A message that goes straight into "What:" with nothing before it has
  // no title at all - that first line belongs to a section, not to the
  // title, so it must stay available for the section scan below rather
  // than being consumed here.
  const candidateIsHeader = candidate !== undefined && SECTION_HEADER.test(candidate);
  let title = "";
  if (!candidate || candidateIsHeader) {
    missing.push("a title line");
  } else if (candidate.length > FINAL_MESSAGE_TITLE_MAX_LENGTH) {
    missing.push(
      `a title line of at most ${FINAL_MESSAGE_TITLE_MAX_LENGTH} characters (the given title is ${candidate.length})`
    );
  } else {
    title = candidate;
  }
  const restStart = !candidate || candidateIsHeader ? i : i + 1;

  const buffers: Partial<Record<FinalMessageSection, string[]>> = {};
  let current: FinalMessageSection | undefined;
  for (const line of lines.slice(restStart)) {
    const match = SECTION_HEADER.exec(line.trim());
    if (match) {
      current = match[1] as FinalMessageSection;
      const bucket = buffers[current] ?? (buffers[current] = []);
      if (match[2]) bucket.push(match[2]);
      continue;
    }
    if (current) buffers[current]!.push(line);
  }

  const sections = {} as Record<FinalMessageSection, string>;
  for (const name of FINAL_MESSAGE_SECTIONS) {
    const body = (buffers[name] ?? []).join("\n").trim();
    if (!body) missing.push(`a "${name}" section`);
    sections[name] = body;
  }

  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, message: { title, sections } };
}

/** One sentence naming every missing piece - what the Client sees in a
 * refused delivery's evidence, and what the next attempt's brief quotes
 * back at the worker verbatim. */
export function describeMissingFinalMessage(missing: string[]): string {
  return `the worker's final message is missing ${missing.join(", ")}`;
}

/** The four sections rendered in the fixed, ratified order - Deviations
 * last - for the commit body and the pull request body alike. */
export function renderFinalMessageBody(message: ParsedFinalMessage): string {
  return FINAL_MESSAGE_SECTIONS.map((name) => `${name}:\n${message.sections[name]}`).join("\n\n");
}
