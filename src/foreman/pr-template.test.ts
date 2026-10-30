import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  readPullRequestTemplate,
  renderIntoTemplate,
  PULL_REQUEST_TEMPLATE_PATH,
} from "./pr-template.ts";
import type { WorkerWriteup } from "../brain/index.ts";

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

function repoWithTemplate(template: string | null): string {
  const repo = mkdtempSync(join(tmpdir(), "fabrica-pr-template-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "hello\n");
  if (template !== null) {
    mkdirSync(join(repo, dirname(PULL_REQUEST_TEMPLATE_PATH)), { recursive: true });
    writeFileSync(join(repo, PULL_REQUEST_TEMPLATE_PATH), template);
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

test("renderIntoTemplate: the write-up's words go under the template's own matching sections", () => {
  const rendered = renderIntoTemplate(
    "## Why\n\n## What\n\n## How\n",
    WRITEUP
  );

  assert.equal(
    rendered,
    "## Why\n\n" +
      `${WRITEUP.why}\n\n` +
      "## What\n\n" +
      `${WRITEUP.what}\n\n` +
      "## How\n\n" +
      `${WRITEUP.how}\n\n` +
      "## Notes\n\n" +
      "### Changes outside the codebase\n\n" +
      "None.\n\n" +
      "### Additional information\n\n" +
      "- Confidence: 85/100\n" +
      "- Assumptions: Three retries is enough.\n" +
      "- Expected outcomes: No more dropped pushes.\n" +
      "- Deviations: None."
  );
});

test("renderIntoTemplate: the Client's own synonyms claim their sections - Motivation, Description, Changes", () => {
  const rendered = renderIntoTemplate("## Motivation\n\n## Description\n\n## Changes\n", WRITEUP);

  assert.match(rendered, new RegExp(`## Motivation\\n\\n${WRITEUP.why}`));
  assert.match(rendered, new RegExp(`## Description\\n\\n${WRITEUP.what.replace(/\./g, "\\.")}`));
  assert.match(rendered, new RegExp(`## Changes\\n\\n${WRITEUP.how.replace(/[.,]/g, "\\$&")}`));
});

test("renderIntoTemplate: a Testing section gets what the worker says it ran, and nothing when it says nothing", () => {
  const withTests = renderIntoTemplate("## Testing\n", { ...WRITEUP, testsRun: "npm test" });
  assert.match(withTests, /## Testing\n\nnpm test/);

  const withoutTests = renderIntoTemplate("## Testing\n", WRITEUP);
  assert.match(withoutTests, /## Testing\n\n## Notes/);
  // Never carried into the notes either: the tests a worker ran are the
  // Client's to read on the delivery, not a reviewer's on the body.
  assert.doesNotMatch(withoutTests, /npm test/);
});

test("renderIntoTemplate: nothing the template had is thrown away - a checklist under a claimed heading stays", () => {
  const rendered = renderIntoTemplate(
    "## Description\n\n<!-- Describe your change -->\n\n- [ ] I read CONTRIBUTING.md\n",
    WRITEUP
  );

  assert.match(rendered, /<!-- Describe your change -->/);
  assert.match(rendered, /- \[ \] I read CONTRIBUTING\.md/);
  assert.match(rendered, new RegExp(`- \\[ \\] I read CONTRIBUTING\\.md\\n\\n${WRITEUP.what.replace(/\./g, "\\.")}`));
});

test("renderIntoTemplate: a part with no matching section is appended under one Notes heading", () => {
  const rendered = renderIntoTemplate("## Description\n", WRITEUP);

  assert.equal(rendered.match(/^## Notes$/gm)?.length, 1);
  assert.match(rendered, new RegExp(`## Notes\\n\\n### Context \\(Why\\)\\n\\n${WRITEUP.why}`));
  assert.match(rendered, /### Changes in the codebase \(How\)/);
  // The one it did place is not repeated down there.
  assert.doesNotMatch(rendered, /### Description \(What\)/);
});

test("renderIntoTemplate: a template with no headings at all keeps its text and takes the whole write-up as notes", () => {
  const rendered = renderIntoTemplate("Thanks for contributing!\n", WRITEUP);

  assert.match(rendered, /^Thanks for contributing!\n\n## Notes\n/);
  for (const text of [WRITEUP.why, WRITEUP.what, WRITEUP.how]) assert.ok(rendered.includes(text));
});

test("renderIntoTemplate: one heading is claimed by one field, and the earliest keyword in it wins", () => {
  const rendered = renderIntoTemplate("## What changed, and why\n\n## How\n", WRITEUP);

  assert.match(rendered, new RegExp(`## What changed, and why\\n\\n${WRITEUP.what.replace(/\./g, "\\.")}`));
  // "why" matched that heading too, but "what" came first in it - so
  // the why is still looking for a section, and lands in the notes.
  assert.match(rendered, new RegExp(`### Context \\(Why\\)\\n\\n${WRITEUP.why}`));
});

test("renderIntoTemplate: a second heading matching an already-claimed field claims nothing", () => {
  const rendered = renderIntoTemplate("## Description\n\n## Summary\n", WRITEUP);

  assert.match(rendered, new RegExp(`## Description\\n\\n${WRITEUP.what.replace(/\./g, "\\.")}`));
  assert.match(rendered, /## Summary\n\n## Notes/);
});

test("renderIntoTemplate: a heading inside a fenced block is showing one, not emitting one", () => {
  const rendered = renderIntoTemplate("```\n## Description\n```\n\n## Why\n", WRITEUP);

  assert.match(rendered, /```\n## Description\n```/);
  assert.match(rendered, new RegExp(`## Why\\n\\n${WRITEUP.why}`));
  // The fenced heading claimed nothing, so the what is in the notes.
  assert.match(rendered, /### Description \(What\)/);
});

test("renderIntoTemplate: a worker that echoed one of Fabrica's own headings into a field does not emit it twice", () => {
  const rendered = renderIntoTemplate("## Description\n", {
    ...WRITEUP,
    what: "## Description (What)\n\nRetried the push.",
  });

  assert.match(rendered, /## Description\n\nRetried the push\./);
  assert.doesNotMatch(rendered, /## Description \(What\)/);
});

test("renderIntoTemplate: windows line endings in a template do not leave carriage returns in the body", () => {
  const rendered = renderIntoTemplate("## Description\r\n\r\n<!-- here -->\r\n", WRITEUP);
  assert.doesNotMatch(rendered, /\r/);
  assert.match(rendered, new RegExp(`<!-- here -->\\n\\n${WRITEUP.what.replace(/\./g, "\\.")}`));
});
