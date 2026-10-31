// A pull request body in the shape of the repository's own template
// (issue #316, work mode).
//
// At work a repository has a `.github/PULL_REQUEST_TEMPLATE.md` its
// reviewers expect every pull request to follow, and Fabrica's own
// four-section body (`pr-body.ts`) is not it. For a project that says
// `pullRequestTemplate = true`, the body handed to Inspector is that
// template with the write-up's own words placed under the template's
// matching sections, and everything that found no section appended at
// the end under one "## Notes" heading. The commit message is untouched
// - it stays the four-section rendering on every project, because a
// company template is about how a pull request reads, not about what a
// commit says.
//
// Two rules this follows throughout:
//
//   - **Rendered from the write-up, never parsed back out of a body.**
//     A worker's write-up is structured data (the deleted
//     `final-message.ts` parser is the standing ruling), so this takes a
//     `WorkerWriteup` and the template's text, and nothing else.
//   - **Nothing in the template is ever thrown away.** A matched
//     section keeps whatever the template had under it - a checklist, an
//     instruction, an HTML comment - and the write-up's words are placed
//     after it. A reviewer who wrote that checklist still gets it.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADDITIONAL_HEADING, CONTENT_SECTIONS, additionalInformationBullets, writeupSection } from "./pr-body.ts";
import type { WorkerWriteup } from "../brain/index.ts";

/** The one path this reads, exactly as the issue names it. GitHub itself
 * accepts several (a lowercase spelling, the repository root, `docs/`);
 * only this one is looked for, so a repository using another spelling
 * renders the ordinary body rather than half of one. */
export const PULL_REQUEST_TEMPLATE_PATH = ".github/PULL_REQUEST_TEMPLATE.md";

/**
 * The repository's own pull request template, or undefined when it has
 * none (or holds nothing but whitespace, which is no template to render
 * into).
 *
 * Read at `revision` when one is given - the commit the task was cut
 * from - for the same reason `.inspector.json` is: the question is about
 * the tree the task started from, never about a file a Worker has
 * already had its hands on. A Worker that edited the template would
 * otherwise be rewriting the shape of its own pull request.
 */
export function readPullRequestTemplate(workdir: string, revision?: string): string | undefined {
  let text: string;
  try {
    text =
      revision === undefined
        ? readFileSync(join(workdir, PULL_REQUEST_TEMPLATE_PATH), "utf8")
        : git(workdir, ["show", `${revision}:${PULL_REQUEST_TEMPLATE_PATH}`]);
  } catch {
    return undefined;
  }
  return text.trim().length === 0 ? undefined : text;
}

/** Which write-up field a template heading claims, and the words that
 * claim it. The Client's own ruling on how to match (issue #316's
 * clarification): "keyword match plus common synonyms (Description,
 * Motivation, Changes, Testing)". Matched as whole words, case
 * insensitively, so "Description of the change" claims `what` while
 * "Undescribed" claims nothing.
 *
 * `testsRun` is here only because the Client's own list names Testing.
 * It is the one field Fabrica's own body deliberately does not render
 * (`src/brain/writeup.ts`), so it is placed when a template asks for it
 * by name and never otherwise - it is not carried into "## Notes" below.
 */
const MATCHABLE_FIELDS = [
  { field: "why", label: "Context (Why)", keywords: ["why", "motivation", "context", "background", "rationale"] },
  { field: "what", label: "Description (What)", keywords: ["what", "description", "summary", "overview"] },
  { field: "how", label: "Changes in the codebase (How)", keywords: ["how", "changes", "change", "implementation"] },
  { field: "testsRun", label: "Tests", keywords: ["testing", "tests", "test plan", "verification"] },
] as const satisfies readonly { field: keyof WorkerWriteup; label: string; keywords: readonly string[] }[];

/** The heading every unplaced part of the write-up ends up under -
 * exactly one, per the issue. */
const NOTES_HEADING = "## Notes";

/** The write-up's parts that are never matched to a template section and
 * so always land under "## Notes", with the Client's own heading for
 * each (read off `pr-body.ts`'s own list, never spelled a second time
 * here). Only `outsideChanges` today: a template section for "changes
 * outside the codebase" is not a thing templates have, and the three
 * matchable fields above are what the issue says to place. */
const NOTES_ONLY_SECTIONS = CONTENT_SECTIONS.filter(({ field }) => field === "outsideChanges");

interface TemplateSection {
  heading: string;
  /** The template's own lines under that heading, as written. */
  lines: string[];
  /** The write-up field this heading claimed, if any. */
  field?: keyof WorkerWriteup;
}

/**
 * `template` with the write-up placed into it.
 *
 * Each of the write-up's matchable fields claims at most one heading,
 * and each heading is claimed by at most one field. Walked in the
 * template's own order so the document decides, not this list: for one
 * heading that matches several fields (a "What changed and why"), the
 * field whose keyword appears earliest in the heading wins, and a tie
 * goes to the earlier entry in `MATCHABLE_FIELDS`.
 */
export function renderIntoTemplate(template: string, writeup: WorkerWriteup): string {
  const { preamble, sections } = splitSections(template);
  const claimed = new Set<keyof WorkerWriteup>();

  for (const section of sections) {
    const field = claimFor(section.heading, claimed);
    if (field === undefined) continue;
    // A field the worker left out claims nothing: the heading keeps
    // whatever the template put under it, rather than gaining a blank.
    if (writeupSection(writeup, field).length === 0) continue;
    claimed.add(field);
    section.field = field;
  }

  const rendered = [...preamble];
  for (const section of sections) {
    rendered.push(section.heading, ...section.lines);
    if (section.field === undefined) continue;
    if (rendered[rendered.length - 1]?.trim().length !== 0) rendered.push("");
    rendered.push(writeupSection(writeup, section.field), "");
  }

  return [block(rendered), notes(writeup, claimed)].join("\n\n");
}

/** Everything the template had no section for, under one heading. Always
 * present: the confidence, assumptions, expected outcomes and deviations
 * a reviewer reads last have no section in anybody's template, and
 * dropping them would be the one thing this must not do. */
function notes(writeup: WorkerWriteup, claimed: Set<keyof WorkerWriteup>): string {
  const parts: string[] = [NOTES_HEADING];
  for (const { field, label } of MATCHABLE_FIELDS) {
    if (claimed.has(field) || field === "testsRun") continue;
    const text = writeupSection(writeup, field);
    if (text.length > 0) parts.push(`### ${label}`, text);
  }
  for (const { heading, field } of NOTES_ONLY_SECTIONS) {
    const text = writeupSection(writeup, field);
    if (text.length > 0) parts.push(`### ${heading3(heading)}`, text);
  }
  parts.push(`### ${heading3(ADDITIONAL_HEADING)}`, additionalInformationBullets(writeup));
  return parts.join("\n\n");
}

/** `## Heading` as the words alone, for re-emitting one level deeper
 * under "## Notes" - so the labels a reviewer sees are the same words
 * Fabrica's own body uses, never a second vocabulary. */
function heading3(heading: string): string {
  return heading.replace(/^#+\s*/, "");
}

const FENCE = /^\s{0,3}(?:```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s+\S/;

/** The template's lines before its first heading, then one entry per
 * heading. A heading inside a fenced code block is not a heading - a
 * template that documents markdown in a fence is showing one, not
 * emitting one, which is the same line `pr-body.ts`'s own
 * `withoutTemplateHeadings` draws. */
function splitSections(template: string): { preamble: string[]; sections: TemplateSection[] } {
  const preamble: string[] = [];
  const sections: TemplateSection[] = [];
  let inFence = false;
  for (const line of template.replace(/\r\n/g, "\n").split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && HEADING.test(line)) {
      sections.push({ heading: line, lines: [] });
      continue;
    }
    (sections[sections.length - 1]?.lines ?? preamble).push(line);
  }
  return { preamble, sections };
}

/** The field this heading claims, or undefined when it matches none that
 * is still unclaimed. */
function claimFor(heading: string, claimed: Set<keyof WorkerWriteup>): keyof WorkerWriteup | undefined {
  const text = heading3(heading).toLowerCase();
  let best: { field: keyof WorkerWriteup; at: number } | undefined;
  for (const { field, keywords } of MATCHABLE_FIELDS) {
    if (claimed.has(field)) continue;
    for (const keyword of keywords) {
      const at = text.search(new RegExp(`\\b${keyword}\\b`));
      if (at === -1) continue;
      if (best === undefined || at < best.at) best = { field, at };
    }
  }
  return best?.field;
}

/** Lines as one block, with runs of blank lines closed up and the ends
 * trimmed - the same tidying a rendered body gets, so an insertion never
 * leaves a three-line gap where the template had one. */
function block(lines: string[]): string {
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
