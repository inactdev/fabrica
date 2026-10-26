// docker-tests (issue #106) - a required-status-check job that runs
// Fabrica's own `npm test` on a standard GitHub-hosted runner, which has
// a real Docker daemon preinstalled, so every test gated on
// dockerAvailable() across src/containment, src/relay, src/line, and
// src/brain/adapters runs for real instead of skipping. There is no
// Fabrica code involved - like rule9-gate.yml's own jobs, the only way
// to prove this file's ratified facts is to read its source, the same
// approach rule9-gate.contract-paths.test.ts and
// inspector-stamp-workflow.test.ts take for their own workflow.
//
// The second test below covers the path gate: that suite now runs on a
// pull request only when the change touches something a real Docker
// daemon decides. The facts worth binding there are the ones whose loss
// is silent - that the job itself is never skipped (a skipped job's
// standing as a required status check is a known trap), that the gate
// never fails the job, that each watched path is still watched, and that
// everything expensive is behind the gate's own output rather than
// running unconditionally.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workflowPath = join(here, "..", "..", ".github", "workflows", "docker-tests.yml");

/** The file's steps, one string per step. Split on a step's own `- `
 * line at the fixed indent the file uses, so an assertion can ask what a
 * particular step says rather than whether a string appears anywhere in
 * the workflow. A comment line at that same indent lands in the previous
 * step's chunk, which is why every needle below is anchored to a real
 * YAML line and not to prose. */
function stepsOf(source: string): string[] {
  return source.split(/\n(?= {6}- )/).filter((chunk) => /^ {6}- /.test(chunk));
}

function stepContaining(source: string, needle: RegExp): string {
  const step = stepsOf(source).find((chunk) => needle.test(chunk));
  assert.ok(step, `no step in docker-tests.yml matches ${needle}`);
  return step;
}

/** Everything whose behaviour a real Docker daemon decides. A pattern
 * dropped from the workflow silently stops running the Docker-gated
 * tests for changes to that path, which is exactly the kind of loss
 * nothing else here would notice. */
const WATCHED_PATHS = [
  "src/containment/*",
  "src/relay/*",
  "src/line/*",
  "src/brain/adapters/*",
  "Dockerfile",
  "*/Dockerfile",
  "Dockerfile.*",
  "*/Dockerfile.*",
  ".dockerignore",
  "*/.dockerignore",
  "docker-compose*.yml",
  "*/docker-compose*.yml",
];

const GATED = /^ {8}if: steps\.gate\.outputs\.run_full == 'true'$/m;

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

test("docker-tests.yml runs that suite only for a Docker-dependent change, and the gate can never fail the job", () => {
  const source = readFileSync(workflowPath, "utf8");

  // The job must run on every pull request and report a real pass or
  // fail. A job-level `if` would report "skipped" instead, and whether
  // GitHub counts "skipped" as satisfying a *required* status check is a
  // known trap rather than a documented guarantee - the same reasoning
  // rule9-gate.yml's own jobs are built on. Job keys sit at four spaces;
  // a step's `if` sits at eight and is the whole point of this design.
  assert.doesNotMatch(source, /^ {4}if:/m, "the job must have no job-level if - a skipped job is not a passing required check");

  // The gate itself: one cheap step, before any checkout, whose output
  // every expensive step hangs off.
  const gate = stepContaining(source, /^ {8}id: gate$/m);

  // Nothing about deciding how much to run may fail the job. The gate
  // answers "how much", never "is this pull request allowed" - that is
  // rule9-gate.yml's business, in its own file and its own job.
  assert.doesNotMatch(gate, /exit 1/, "the gate step must never fail the job");

  // Pull requests are the only gated trigger: a push to master and a
  // manual dispatch always run everything.
  assert.match(source, /^ {2}workflow_dispatch:\s*$/m, "must offer workflow_dispatch, which always runs the full suite");
  assert.match(
    gate,
    /"\$EVENT_NAME" != "pull_request"/,
    "must run the full suite whenever the trigger is not a pull request",
  );

  // Every watched path, read from the workflow's own pattern list. One
  // pattern per line at a fixed indent, the same shape rule9-gate.yml's
  // protected-path lists use.
  for (const pattern of WATCHED_PATHS) {
    assert.ok(
      new RegExp(`^ {12}${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(gate),
      `the gate must still watch ${pattern}`,
    );
  }

  // The changed-file list comes from the API, including a rename's
  // previous name - a file renamed OUT of a watched directory is a
  // Docker-dependent change too, and the new name alone would hide it.
  assert.match(gate, /gh api "repos\/\$REPO\/pulls\/\$PR_NUMBER\/files/, "must read the changed-file list from the GitHub API");
  assert.match(gate, /previous_filename/, "must count a rename's previous name, or a rename out of a watched path hides");
  assert.match(source, /^ {6}pull-requests: read$/m, "the API listing needs pull-requests: read, and nothing wider");

  // The fast path's own log line, which is the only record of why the
  // suite did not run: both the watched set and what this pull request
  // actually changed.
  assert.match(gate, /Paths that would have triggered the full run:/, "the fast path must log the watched path set");
  assert.match(gate, /This pull request's changed files:/, "the fast path must log the pull request's own changed files");

  // Everything that costs real time hangs off the gate's output. An
  // ungated step here would quietly undo the whole change.
  const expensive: Array<[string, RegExp]> = [
    ["the checkout", /^ {6}- uses: actions\/checkout@/m],
    ["the Node setup", /^ {6}- uses: actions\/setup-node@/m],
    ["the Docker availability guard", /^ {6}- name: Confirm Docker is actually available$/m],
    ["npm ci", /^ {6}- run: npm ci$/m],
    ["npm test", /^ {6}- run: npm test$/m],
  ];
  for (const [label, needle] of expensive) {
    assert.match(stepContaining(source, needle), GATED, `${label} must run only when the gate asks for the full suite`);
  }
});
