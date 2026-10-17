// docker-tests (issue #106) - a required-status-check job that runs
// Fabrica's own `npm test` on a standard GitHub-hosted runner, which has
// a real Docker daemon preinstalled, so every test gated on
// dockerAvailable() across src/containment, src/relay, src/line, and
// src/brain/adapters runs for real instead of skipping. There is no
// Fabrica code involved - like rule9-gate.yml's own jobs, the only way
// to prove this file's ratified facts is to read its source, the same
// approach rule9-gate.contract-paths.test.ts and
// inspector-stamp-workflow.test.ts take for their own workflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(here, "..", "..", ".github", "workflows", "docker-tests.yml");

test("docker-tests.yml runs the real test suite with Docker, checks out PR content, and fails loudly if Docker is missing", () => {
  const source = readFileSync(workflowPath, "utf8");

  // Load-bearing for the repository's required-status-check settings -
  // whatever else changes in this file, this id must not.
  assert.match(source, /^ {2}docker-tests:\s*$/m, "the job id must be exactly 'docker-tests'");

  // Unlike rule9-gate.yml's jobs, this job's whole point is to execute
  // the pull request's own proposed code, and it touches no secrets - so
  // it must use the ordinary pull_request trigger, never
  // pull_request_target, and it must actually check out the branch.
  assert.match(source, /^on:\s*\n\s*pull_request:\s*$/m, "must trigger on the ordinary pull_request event");
  // Anchored to an actual YAML key, not substring-matched against the
  // file's own prose explaining why pull_request_target is the wrong
  // choice here - that explanation necessarily names the word too.
  assert.doesNotMatch(source, /^\s*pull_request_target:\s*$/m, "must never use pull_request_target");
  assert.match(source, /uses:\s*actions\/checkout@/, "must check out the pull request's own content");

  // Every push to the default branch too, same breadth as the existing
  // gate.
  assert.match(source, /push:\s*\n\s*branches:\s*\[\s*master\s*\]/, "must also trigger on push to master");

  // A green run here proves nothing about Docker if every Docker-gated
  // test quietly skipped - this guard is what turns a Docker-less runner
  // into a loud failure instead of a hollow pass.
  assert.match(source, /docker info/, "must verify Docker is actually available before trusting the test run");

  // The real second judge: the exact same command every contributor runs
  // locally, not a hand-picked subset of "the Docker tests" that could
  // silently miss a newly added one.
  assert.match(source, /^\s*-\s*run:\s*npm test\s*$/m, "must run the full npm test suite, not a curated subset");
});
