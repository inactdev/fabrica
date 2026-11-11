import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  findPullRequestTemplate,
  placeableFields,
  readPullRequestTemplate,
  renderIntoTemplate,
  PULL_REQUEST_TEMPLATE_PATHS,
} from "./pr-template.ts";
import type { WorkerWriteup } from "../brain/index.ts";

const PULL_REQUEST_TEMPLATE_PATH = PULL_REQUEST_TEMPLATE_PATHS[0];
const LOWERCASE_TEMPLATE_PATH = PULL_REQUEST_TEMPLATE_PATHS[1];

const WRITEUP: WorkerWriteup = {
  title: "Add retries",
  why: "The push kept dropping.",
  what: "Retried the push three times.",
  how: "A loop in push.ts, plus a test.",
  outsideChanges: "None.",
  confidence: 85,
  assumptions: "Three retries is enough.",
  expectedOutcomes: "No more dropped pushes.",
  deviations: "None.",
  quiz: [
    { question: "What changed?", answer: "The push retries." },
    { question: "Why?", answer: "It kept dropping." },
    { question: "What should the owner watch?", answer: "The retry count." },
  ],
};

function repoWithTemplate(template: string | null, at: string = PULL_REQUEST_TEMPLATE_PATH): string {
  const repo = mkdtempSync(join(tmpdir(), "fabrica-pr-template-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "hello\n");
  if (template !== null) {
    mkdirSync(join(repo, dirname(at)), { recursive: true });
    writeFileSync(join(repo, at), template);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: repo });
  return repo;
}

function head(repo: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

test("readPullRequestTemplate: reads the repository's own template from the working tree", () => {
  const repo = repoWithTemplate("## Description\n\n<!-- what -->\n");
  assert.equal(readPullRequestTemplate(repo), "## Description\n\n<!-- what -->\n");
});

test("readPullRequestTemplate: reads it at a revision, so a Worker's own edit cannot reshape its pull request", () => {
  const repo = repoWithTemplate("## Description\n");
  const base = head(repo);
  writeFileSync(join(repo, PULL_REQUEST_TEMPLATE_PATH), "## Rewritten by the worker\n");

  assert.equal(readPullRequestTemplate(repo, base), "## Description\n");
  assert.equal(readPullRequestTemplate(repo), "## Rewritten by the worker\n");
});

test("readPullRequestTemplate: a repository with no template answers undefined, not an empty one", () => {
  const repo = repoWithTemplate(null);
  assert.equal(readPullRequestTemplate(repo), undefined);
  assert.equal(readPullRequestTemplate(repo, head(repo)), undefined);
});

test("readPullRequestTemplate: a template holding nothing but whitespace is no template to render into", () => {
  assert.equal(readPullRequestTemplate(repoWithTemplate("\n   \n")), undefined);
});

// Issue #349: GitHub's own documentation spells this file lowercase in
// every example and says nothing about the name being case-insensitive,
// so both spellings are looked for - a repository using the lowercase
// one used to fall back to Fabrica's own body silently.
test("readPullRequestTemplate: the lowercase spelling of the path is read too", () => {
  const repo = repoWithTemplate("## Description\n\n<!-- lowercase -->\n", LOWERCASE_TEMPLATE_PATH);

  assert.equal(readPullRequestTemplate(repo), "## Description\n\n<!-- lowercase -->\n");
  assert.equal(readPullRequestTemplate(repo, head(repo)), "## Description\n\n<!-- lowercase -->\n");
});

test("findPullRequestTemplate: says which spelling it read, for the doctor line that names the file", () => {
  const repo = repoWithTemplate("## Description\n");
  assert.deepEqual(findPullRequestTemplate(repo), { path: PULL_REQUEST_TEMPLATE_PATH, text: "## Description\n" });
  assert.equal(findPullRequestTemplate(repoWithTemplate(null)), undefined);
});

test("renderIntoTemplate: the write-up's words go under the template's own matching sections, and nothing else", () => {
  const rendered = renderIntoTemplate(
    "## Why\n\n## What\n\n## How\n",
    WRITEUP
  );

  // Issue #349: the template's three sections, filled - no fourth
  // heading of Fabrica's own, and none of the confidence, assumptions,
  // expected outcomes or deviations the Client reads on the delivery.
  assert.equal(
    rendered,
    "## Why\n\n" +
      `${WRITEUP.why}\n\n` +
      "## What\n\n" +
      `${WRITEUP.what}\n\n` +
      "## How\n\n" +
      `${WRITEUP.how}`
  );
});

test("renderIntoTemplate: Fabrica's own write-up is for the delivery, never the body", () => {
  const rendered = renderIntoTemplate("## Why\n\n## What\n\n## How\n", { ...WRITEUP, couldNotVerify: "the push itself" })!;

  for (const word of ["Notes", "Confidence", "85", "Three retries is enough", "No more dropped pushes", "the push itself"]) {
    assert.ok(!rendered.includes(word), `the body carried ${word}`);
  }
  // Nor the write-up's one section no template has a heading for.
  assert.ok(!rendered.includes("outside the codebase"));
});

test("renderIntoTemplate: the Client's own synonyms claim their sections - Motivation, Description, Changes", () => {
  const rendered = renderIntoTemplate("## Motivation\n\n## Description\n\n## Changes\n", WRITEUP)!;

  assert.match(rendered, new RegExp(`## Motivation\\n\\n${WRITEUP.why}`));
  assert.match(rendered, new RegExp(`## Description\\n\\n${WRITEUP.what.replace(/\./g, "\\.")}`));
  assert.match(rendered, new RegExp(`## Changes\\n\\n${WRITEUP.how.replace(/[.,]/g, "\\$&")}`));
});

test("renderIntoTemplate: a Testing section gets what the worker says it ran, and nothing when it says nothing", () => {
  const withTests = renderIntoTemplate("## Testing\n\n## Description\n", { ...WRITEUP, testsRun: "npm test" })!;
  assert.match(withTests, /## Testing\n\nnpm test/);

  // A worker that reported no tests leaves the heading as the template
  // wrote it, and nothing is added anywhere else: the tests a worker ran
  // are the Client's to read on the delivery, not a reviewer's here.
  const withoutTests = renderIntoTemplate("## Testing\n\n## Description\n", WRITEUP)!;
  assert.match(withoutTests, /## Testing\n\n## Description\n/);
  assert.doesNotMatch(withoutTests, /npm test/);
});

test("renderIntoTemplate: nothing the template had is thrown away - a checklist under a claimed heading stays", () => {
  const rendered = renderIntoTemplate(
    "## Description\n\n<!-- Describe your change -->\n\n- [ ] I read CONTRIBUTING.md\n",
    WRITEUP
  )!;

  assert.match(rendered, /<!-- Describe your change -->/);
  assert.match(rendered, /- \[ \] I read CONTRIBUTING\.md/);
  assert.match(rendered, new RegExp(`- \\[ \\] I read CONTRIBUTING\\.md\\n\\n${WRITEUP.what.replace(/\./g, "\\.")}`));
});

// Issue #349: a section the template does not have is never added, so a
// field that claimed no heading is simply not in the body. The reviewer
// of the task still reads all of it - the commit message and the review
// page carry the four-section rendering on every project.
test("renderIntoTemplate: a part with no matching section is left out of the body entirely", () => {
  const rendered = renderIntoTemplate("## Description\n", WRITEUP)!;

  assert.equal(rendered, `## Description\n\n${WRITEUP.what}`);
  for (const text of [WRITEUP.why, WRITEUP.how]) assert.ok(!rendered.includes(text));
});

// A template whose headings claim nothing cannot be both followed and
// made to describe the change: no section would hold a word of the
// write-up. Answering undefined is what makes `judge.ts` publish
// Fabrica's own body instead.
test("renderIntoTemplate: a template nothing can be placed into renders nothing at all", () => {
  assert.equal(renderIntoTemplate("Thanks for contributing!\n", WRITEUP), undefined);
  assert.equal(renderIntoTemplate("## Checklist\n\n- [ ] I read CONTRIBUTING.md\n", WRITEUP), undefined);
  // The only matching heading is one the worker had nothing for.
  assert.equal(renderIntoTemplate("## Testing\n", WRITEUP), undefined);
});

test("placeableFields: which fields a template has a section for, without a write-up to ask", () => {
  assert.deepEqual(placeableFields("## Why\n\n## What\n\n## How\n"), ["why", "what", "how"]);
  // The template's own order, not the match list's.
  assert.deepEqual(placeableFields("## Testing\n\n## Motivation\n"), ["testsRun", "why"]);
  // A second heading for an already-claimed field adds nothing.
  assert.deepEqual(placeableFields("## Description\n\n## Summary\n"), ["what"]);
});

test("placeableFields: empty for exactly the templates renderIntoTemplate cannot render into", () => {
  for (const template of ["Thanks for contributing!\n", "## Checklist\n\n- [ ] I read CONTRIBUTING.md\n", "```\n## Description\n```\n"]) {
    assert.deepEqual(placeableFields(template), [], template);
    assert.equal(renderIntoTemplate(template, WRITEUP), undefined, template);
  }
  // Structural only: this heading can be filled, by a write-up that
  // reported tests. The one in WRITEUP did not, so that round still
  // falls back - which is not knowable from the template alone.
  assert.deepEqual(placeableFields("## Testing\n"), ["testsRun"]);
  assert.equal(renderIntoTemplate("## Testing\n", WRITEUP), undefined);
});

test("renderIntoTemplate: one heading is claimed by one field, and the earliest keyword in it wins", () => {
  const rendered = renderIntoTemplate("## What changed, and why\n\n## How\n", WRITEUP)!;

  assert.match(rendered, new RegExp(`## What changed, and why\\n\\n${WRITEUP.what.replace(/\./g, "\\.")}`));
  // "why" matched that heading too, but "what" came first in it - so the
  // why found no section of its own, and is not in the body.
  assert.ok(!rendered.includes(WRITEUP.why));
});

test("renderIntoTemplate: a second heading matching an already-claimed field claims nothing", () => {
  const rendered = renderIntoTemplate("## Description\n\n## Summary\n", WRITEUP)!;

  assert.match(rendered, new RegExp(`## Description\\n\\n${WRITEUP.what.replace(/\./g, "\\.")}`));
  assert.ok(rendered.trimEnd().endsWith("## Summary"), `the second heading did not stay empty: ${rendered}`);
});

test("renderIntoTemplate: a heading inside a fenced block is showing one, not emitting one", () => {
  const rendered = renderIntoTemplate("```\n## Description\n```\n\n## Why\n", WRITEUP)!;

  assert.match(rendered, /```\n## Description\n```/);
  assert.match(rendered, new RegExp(`## Why\\n\\n${WRITEUP.why}`));
  // The fenced heading claimed nothing, so the what has no section.
  assert.ok(!rendered.includes(WRITEUP.what));
});

test("renderIntoTemplate: a worker that echoed one of Fabrica's own headings into a field does not emit it twice", () => {
  const rendered = renderIntoTemplate("## Description\n", {
    ...WRITEUP,
    what: "## Description (What)\n\nRetried the push.",
  })!;

  assert.match(rendered, /## Description\n\nRetried the push\./);
  assert.doesNotMatch(rendered, /## Description \(What\)/);
});

test("renderIntoTemplate: windows line endings in a template do not leave carriage returns in the body", () => {
  const rendered = renderIntoTemplate("## Description\r\n\r\n<!-- here -->\r\n", WRITEUP)!;
  assert.doesNotMatch(rendered, /\r/);
  assert.match(rendered, new RegExp(`<!-- here -->\\n\\n${WRITEUP.what.replace(/\./g, "\\.")}`));
});
