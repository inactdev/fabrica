// "inspector stamp" - a required-status-check gate that relays
// Inspector's own commit status (posted by Inspector's own repository,
// under the context name "inspector") onto the pull request itself, so a
// merge Inspector never ran against at all is as visible in branch
// protection as one it marked red. Lives in the same workflow file as
// rule9-gate.yml's block-protected-path-change job, not a new file, so
// both jobs ride the same pull_request_target trigger and the same
// "never check out PR content" safety property. There is no Fabrica code
// involved - Inspector posts the status from its own repository, and
// this job only relays it - so reading the workflow's own source is the
// only way to prove this, the same approach rule9-gate.contract-paths
// .test.ts takes for its own job in this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(here, "..", "..", ".github", "workflows", "rule9-gate.yml");

test("rule9-gate.yml carries an 'inspector stamp' job that relays Inspector's commit status with no checkout", () => {
  const source = readFileSync(workflowPath, "utf8");

  assert.match(source, /^\s*name:\s*inspector stamp\s*$/m, "the job must be named 'inspector stamp'");

  // No checkout anywhere in this file, in either job - this gate's whole
  // point is to need nothing from the PR branch but what the API
  // supplies.
  assert.doesNotMatch(source, /uses:\s*actions\/checkout/, "must never check out PR content");

  // The existing rule 9 job must still be present and untouched in name.
  assert.match(source, /block-protected-path-change/, "rule 9's own job must still be present");

  // Absent must fail with exactly this message - the task's own ratified
  // wording, not a paraphrase.
  assert.match(source, /no inspector stamp/, "an absent stamp must fail with this exact message");

  // Reads the commit status API for the PR's own head commit, not a
  // merge ref, a checked-out ref, or the base branch.
  assert.match(
    source,
    /github\.event\.pull_request\.head\.sha/,
    "must read the PR's own head commit, never a checked-out one"
  );

  // Keys on the commit status literally named "inspector" - not any
  // status, and not a differently-spelled context.
  assert.match(source, /context\s*==\s*"inspector"/, 'must key on the commit status literally named "inspector"');

  // Trigger is declared once for the whole file - both jobs must share
  // it, since a job whose own definition isn't pinned to the base branch
  // could be edited by the very pull request it's meant to judge.
  assert.match(source, /^on:\s*\n\s*pull_request_target:/m, "the file must trigger on pull_request_target");
});
