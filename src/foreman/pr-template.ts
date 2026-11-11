// A pull request body in the shape of the repository's own template
// (issue #316, work mode; narrowed to the template alone by issue #349).
//
// At work a repository has a pull request template its reviewers expect
// every pull request to follow, and Fabrica's own four-section body
// (`pr-body.ts`) is not it. For a project that says
// `pullRequestTemplate = true`, the body handed to Inspector is that
// template with the write-up's own words placed under the template's
// matching sections, and nothing else at all. The commit message is
// untouched - it stays the four-section rendering on every project,
// because a company template is about how a pull request reads, not
// about what a commit says.
//
// Three rules this follows throughout:
//
//   - **Rendered from the write-up, never parsed back out of a body.**
//     A worker's write-up is structured data (the deleted
//     `final-message.ts` parser is the standing ruling), so this takes a
//     `WorkerWriteup` and the template's text, and nothing else.
//   - **Nothing in the template is ever thrown away.** A matched
//     section keeps whatever the template had under it - a checklist, an
//     instruction, an HTML comment - and the write-up's words are placed
//     after it. A reviewer who wrote that checklist still gets it.
//   - **No section the template does not have is ever added** (issue
//     #349). What found no section is simply not in the body: the
//     write-up's confidence, assumptions and what it could not verify
//     are for the Client, who reads them on the delivery and the review
//     page, not for the team's reviewers, who read this. There used to
//     be one "## Notes" heading collecting all of it - most of the body
//     on a one-file change - and it must not come back.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeupSection } from "./pr-body.ts";
import type { WorkerWriteup } from "../brain/index.ts";

/** The paths this reads, in the order it tries them. GitHub's own
 * documentation ("Creating a pull request template for your
 * repository") spells the file lowercase throughout and says nothing
 * about the name being case-insensitive, so both spellings occur in the
 * wild and both are looked for (issue #349) - uppercase first, which is
 * what Fabrica read before, so a repository holding both renders
 * exactly as it used to.
 *
 * That same documentation names two more locations for a single
 * template - `pull_request_template.md` in the repository root and
 * `docs/pull_request_template.md` - which are deliberately NOT looked
 * for: a repository using one of those renders the ordinary body, and
 * `fabrica doctor`'s project line is where the Client sees that. */
export const PULL_REQUEST_TEMPLATE_PATHS = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
] as const satisfies readonly string[];

/** A template that was found, and which of `PULL_REQUEST_TEMPLATE_PATHS`
 * it was found at - so `fabrica doctor` can name the real file rather
 * than whichever spelling happens to be listed first. */
export interface FoundPullRequestTemplate {
  path: string;
  text: string;
}

/**
 * The repository's own pull request template and where it was read from,
 * or undefined when it has none at either spelling (or the one it has
 * holds nothing but whitespace, which is no template to render into).
 *
 * Read at `revision` when one is given - the commit the task was cut
 * from - for the same reason `.inspector.json` is: the question is about
 * the tree the task started from, never about a file a Worker has
 * already had its hands on. A Worker that edited the template would
 * otherwise be rewriting the shape of its own pull request.
 */
export function findPullRequestTemplate(workdir: string, revision?: string): FoundPullRequestTemplate | undefined {
  for (const path of PULL_REQUEST_TEMPLATE_PATHS) {
    let text: string;
    try {
      text =
        revision === undefined
          ? readFileSync(join(workdir, path), "utf8")
          : git(workdir, ["show", `${revision}:${path}`]);
    } catch {
      continue;
    }
    if (text.trim().length > 0) return { path, text };
  }
  return undefined;
}

/** The repository's own pull request template's text alone - the one
 * thing a round needs, `findPullRequestTemplate`'s path being only for
 * what `fabrica doctor` prints. */
export function readPullRequestTemplate(workdir: string, revision?: string): string | undefined {
  return findPullRequestTemplate(workdir, revision)?.text;
}

/** Which write-up field a template heading claims, and the words that
 * claim it. The Client's own ruling on how to match (issue #316's
 * clarification): "keyword match plus common synonyms (Description,
 * Motivation, Changes, Testing)". Matched as whole words, case
 * insensitively, so "Description of the change" claims `what` while
 * "Undescribed" claims nothing.
 *
 * This list is also, since issue #349, the whole of what a body can
 * carry: a field that claims no heading is not in the body at all, so
 * `outsideChanges` - which no template has a section for - and the
 * confidence/assumptions/expected-outcomes/deviations bullets are never
 * rendered here. They are in the commit message and on the review page,
 * which is where the Client reads them.
 *
 * `testsRun` is here only because the Client's own list names Testing.
 * It is the one field Fabrica's own body deliberately does not render
 * (`src/brain/writeup.ts`), so it is placed when a template asks for it
 * by name and never otherwise.
 */
const MATCHABLE_FIELDS = [
  { field: "why", keywords: ["why", "motivation", "context", "background", "rationale"] },
  { field: "what", keywords: ["what", "description", "summary", "overview"] },
  { field: "how", keywords: ["how", "changes", "change", "implementation"] },
  { field: "testsRun", keywords: ["testing", "tests", "test plan", "verification"] },
] as const satisfies readonly { field: keyof WorkerWriteup; keywords: readonly string[] }[];

interface TemplateSection {
  heading: string;
  /** The template's own lines under that heading, as written. */
  lines: string[];
  /** The write-up field this heading claimed, if any. */
  field?: keyof WorkerWriteup;
}

/**
 * `template` with the write-up placed into it - or undefined when not one
 * word of the write-up could be placed, which is a template there is no
 * way to follow and describe the change at the same time (see below).
 *
 * Each of the write-up's matchable fields claims at most one heading,
 * and each heading is claimed by at most one field. Walked in the
 * template's own order so the document decides, not this list: for one
 * heading that matches several fields (a "What changed and why"), the
 * field whose keyword appears earliest in the heading wins, and a tie
 * goes to the earlier entry in `MATCHABLE_FIELDS`. A field that claims
 * no heading is simply not in the body (issue #349) - nothing is
 * appended under a heading of Fabrica's own making.
 *
 * Which leaves one case this has to answer: a template whose headings
 * claim nothing at all - none of them matching, or a template with no
 * headings at all ("Thanks for contributing!", a bare checklist). Its
 * body would then describe the change nowhere, so this answers undefined
 * and the caller publishes Fabrica's own four-section body instead
 * (`judge.ts`'s `pullRequestBody`) - the same outcome as a project that
 * asks for a template and has none. The cost is that such a template's
 * own checklist is not in the body: a body that describes nothing was
 * judged the worse of the two.
 */
export function renderIntoTemplate(template: string, writeup: WorkerWriteup): string | undefined {
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
  if (claimed.size === 0) return undefined;

  const rendered = [...preamble];
  for (const section of sections) {
    rendered.push(section.heading, ...section.lines);
    if (section.field === undefined) continue;
    if (rendered[rendered.length - 1]?.trim().length !== 0) rendered.push("");
    rendered.push(writeupSection(writeup, section.field), "");
  }

  return block(rendered);
}

/** `## Heading` as the words alone, for matching a field against it. */
function headingText(heading: string): string {
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
  const text = headingText(heading).toLowerCase();
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
