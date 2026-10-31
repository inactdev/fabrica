// pin-freshness (issue #326): a weekly job that compares every pin this
// repository holds against upstream and, for each pin that is behind,
// opens one issue naming the exact bump and the exact lines to change -
// one issue per stale pin, updated in place rather than duplicated on a
// later run.
//
// There is no Fabrica code involved in a GitHub Actions trigger, so the
// workflow's own facts are proven the way
// src/foreman/inspector-stamp-workflow.test.ts,
// src/containment/docker-tests-workflow.test.ts and
// src/inspector/contract-sync-workflow.test.ts prove theirs: by reading
// the real file.
//
// The script is NOT only read, though. Its comparison and reporting
// logic is real logic, and the half of it most likely to be silently
// wrong is version ordering - 24.9.0 sorts after 24.18.0 as text, which
// for a pin watcher both hides a real bump and proposes going backwards.
// So this file also sources the script in a real bash, replaces its five
// I/O functions with fakes, and runs it end to end against this
// repository's own files: once with every pin fresh, once with every pin
// behind, once with an issue already open. What is left unproven is only
// the GitHub API orchestration itself, the same honest limitation
// src/inspector/contract-sync-workflow.test.ts documents for its own
// script.
//
// Needs nothing but bash and node - deliberately. An earlier draft of
// the script read JSON with jq, which is not installed everywhere this
// suite runs, and a test that skips proves nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const workflowPath = join(repoRoot, ".github", "workflows", "pin-freshness.yml");
const scriptPath = join(repoRoot, ".github", "scripts", "check-pin-freshness.sh");

const workflow = () => readFileSync(workflowPath, "utf8");
const script = () => readFileSync(scriptPath, "utf8");

/** Every pin this job is ratified to watch, by the key that identifies
 * its issue. A pin dropped from the script without a ruling fails here. */
const PIN_KEYS = ["node", "worker-cli", "node-image", "go-toolchain", "inspector-go"];

test("pin-freshness.yml runs weekly, off the hour, and can be run on demand", () => {
  const source = workflow();

  assert.match(source, /^name:\s*pin-freshness\s*$/m, "the workflow must be named pin-freshness");
  assert.match(source, /^\s*schedule:\s*$/m, "must run on a schedule - nobody watching upstream is the problem it exists for");
  assert.match(source, /^\s*workflow_dispatch:\s*$/m, "must also be runnable on demand rather than only once a week");

  const cron = /^\s*-\s*cron:\s*"([^"]+)"\s*$/m.exec(source);
  assert.ok(cron, "the schedule must carry a quoted 5-field cron expression");
  const [minute, , dayOfMonth, month, dayOfWeek] = cron[1].trim().split(/\s+/);
  assert.equal(cron[1].trim().split(/\s+/).length, 5, "cron takes exactly five fields");
  assert.notEqual(minute, "0", "GitHub's own docs warn that runs queued at the top of the hour are delayed and sometimes dropped");
  assert.equal(dayOfMonth, "*");
  assert.equal(month, "*");
  assert.notEqual(dayOfWeek, "*", "weekly, per issue #326 - not daily");

  // A job that opens issues must never run from a branch's own copy of
  // itself, which is what a pull request trigger would allow.
  assert.doesNotMatch(source, /^\s*pull_request(_target)?:/m, "must never be triggered by a pull request");
});

test("pin-freshness.yml may write only this repository's issues, and only one run at a time", () => {
  const source = workflow();

  assert.match(source, /^\s*permissions:\s*$/m, "must declare its permissions rather than inherit the default token scope");
  assert.match(source, /^\s*contents:\s*read\s*$/m, "contents stays read - this job proposes a bump, it never makes one");
  assert.match(source, /^\s*issues:\s*write\s*$/m, "the issue is the one thing it writes");
  assert.doesNotMatch(source, /^\s*contents:\s*write\s*$/m, "must never be able to move a pin itself");
  assert.doesNotMatch(source, /^\s*pull-requests:\s*write\s*$/m, "issue #326 scopes the write to an issue, nothing else");

  // The "updates the issue instead of opening another" property depends
  // on a run seeing what an earlier run opened; two overlapping runs
  // would both find nothing and both open one.
  assert.match(source, /^concurrency:\s*$/m, "must serialise its own runs");
  assert.match(source, /^\s*group:\s*pin-freshness\s*$/m);
  assert.match(source, /^\s*cancel-in-progress:\s*false\s*$/m, "a run already talking to the GitHub API must not be cut off half way");

  assert.match(source, /run:\s*\.github\/scripts\/check-pin-freshness\.sh/, "must run the pin-freshness script");
  assert.match(source, /uses:\s*actions\/checkout@/, "every pinned value is read out of the real file that holds it, so it needs the checkout");

  // node-version-file is resolved relative to GITHUB_WORKSPACE, so it
  // only works after the checkout - the same ordering docker-tests.yml
  // depends on.
  const checkoutAt = source.indexOf("actions/checkout@");
  const setupNodeAt = source.indexOf("actions/setup-node@");
  assert.ok(setupNodeAt > checkoutAt, "setup-node must come after the checkout for node-version-file to resolve");
  assert.match(source, /node-version-file:\s*\.node-version/, "the Node it runs on comes from the repository's own pin, never a number typed here");

  assert.match(source, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/, "the issue is on this repository, so this repository's own token is the right one");
});

test("check-pin-freshness.sh watches every ratified pin and reads each one out of the real file", () => {
  const source = script();

  for (const key of PIN_KEYS) {
    assert.match(source, new RegExp(`PIN_KEY="${key}"`), `the ${key} pin must still be watched`);
  }

  // Issue #326's four upstreams, each read live rather than from a
  // committed copy of what upstream said last time.
  assert.match(source, /https:\/\/nodejs\.org\/dist\/index\.json/, "Node's upstream is nodejs.org's own release index");
  assert.match(source, /npm view "\$pkg" version --json/, "the agent CLI's upstream is its published npm version");
  assert.match(source, /docker buildx imagetools inspect/, "a base image's upstream is its tag's current digest");
  assert.match(source, /https:\/\/go\.dev\/dl\/\?mode=json/, "Go's upstream is go.dev's release list");
  assert.match(source, /repos\/\$repo\/contents\/go\.mod/, "Inspector's Go comes from Inspector's own go.mod");

  // '{{.Manifest.Digest}}' is ignored by buildx (docker/buildx#1175) and
  // prints the whole human-readable block, which would then compare
  // unequal to a digest every single week.
  assert.match(source, /--format '\{\{json \.Manifest\}\}'/, "the digest must be read through the json form of the template");
  assert.doesNotMatch(source, /--format '\{\{\.Manifest/, "the plain sub-field template is a known buildx bug");

  // The pinned values are located in the files, never restated here.
  for (const file of [
    "\\.node-version",
    "src/brain/adapters/docker/Dockerfile",
    "src/relay/container/launch\\.ts",
    "Dockerfile\\.inspector",
    "README\\.md",
  ]) {
    assert.match(source, new RegExp(file), `${file} holds a pin this job watches`);
  }
});

test("check-pin-freshness.sh is read-only except for the one issue it reports", () => {
  const source = script();

  // Nothing here commits, pushes, branches or deletes. The pins this job
  // watches must only ever be moved by a reviewed change.
  for (const forbidden of [/git\s+push/, /git\s+commit/, /git\s+checkout/, /-X\s+DELETE/, /-X\s+PUT/]) {
    assert.doesNotMatch(source, forbidden, `a pin watcher must never ${forbidden.source}`);
  }

  // Writes exactly two shapes of request: open an issue, update an issue
  // (plus creating its label the first time).
  assert.match(source, /-X POST "repos\/\$REPO\/issues"/, "opens the issue");
  assert.match(source, /-X PATCH "repos\/\$REPO\/issues\/\$existing"/, "updates the one already open");

  // Never closes one: merging the bump does that, through the pull
  // request's own Closes line.
  assert.doesNotMatch(source, /state=closed|state": "closed|-f state=closed/, "closing an issue is the merge's job, not this job's");

  // Found again by a marker in the body, never by the title - the title
  // names the exact bump and therefore changes when upstream moves
  // again.
  assert.match(source, /fabrica-pin-freshness/, "an issue must carry the marker that identifies which pin it is about");
  assert.match(source, /select\(\.pull_request == null\)/, "GitHub treats every pull request as an issue; one quoting the marker must not be mistaken for this job's own");
});

//
// --- Executed, not just read -----------------------------------------
//

/** Runs a snippet of bash with the script sourced, so the pure helpers
 * can be called directly. Sourcing deliberately does not run the job:
 * the script's own guard only calls main() when it is executed. */
function inBash(snippet: string): string {
  return execFileSync("bash", ["-c", `set -euo pipefail\ncd ${JSON.stringify(repoRoot)}\nsource ${JSON.stringify(scriptPath)}\n${snippet}`], {
    encoding: "utf8",
  }).trim();
}

test("newer_version compares versions as numbers, not as text", () => {
  // The case that matters: as text, "24.9.0" sorts after "24.18.0", so a
  // text comparison would both miss the 24.18.0 -> 24.19.0 bump and
  // propose 24.18.0 -> 24.9.0 as one.
  const cases: Array<[string, string, string]> = [
    ["24.18.0", "24.19.0", "0"],
    ["24.9.0", "24.18.0", "0"],
    ["24.18.0", "24.9.0", "1"],
    ["24.18.0", "24.18.0", "1"],
    ["go1.26.8", "go1.27.0", "0"],
    ["v24.18.0", "24.18.1", "0"],
    ["1.22", "1.25.1", "0"],
    ["1.26", "1.26.0", "1"],
    // Anything that is not a dotted number fails loudly rather than
    // being quietly read as "not newer".
    ["1.27.0-rc1", "1.27.0", "2"],
    ["", "1.0.0", "2"],
  ];

  for (const [old, next, expected] of cases) {
    const got = inBash(`rc=0\nnewer_version ${JSON.stringify(old)} ${JSON.stringify(next)} || rc=$?\necho "$rc"`);
    assert.equal(got, expected, `newer_version "${old}" "${next}" should have returned ${expected}`);
  }
});

test("max_version picks the greatest version, not the last or the longest", () => {
  assert.equal(inBash(`printf 'v24.9.0\\nv24.18.0\\nv24.3.1\\n' | max_version`), "v24.18.0");
  assert.equal(inBash(`printf 'go1.26.8\\ngo1.9.1\\n' | max_version`), "go1.26.8");
  // No input at all is a failed upstream read, not "nothing to do".
  assert.equal(inBash(`rc=0\nprintf '' | max_version || rc=$?\necho "$rc"`), "1");
});

test("a title names the exact bump and a marker names the pin", () => {
  assert.equal(inBash(`pin_title "Node" 24.18.0 24.19.0`), "pin-freshness: Node 24.18.0 -> 24.19.0");
  assert.equal(inBash(`marker_for node-image`), "<!-- fabrica-pin-freshness: node-image -->");
  // A full digest makes an unreadable title; the body always carries the
  // whole thing.
  assert.equal(
    inBash(`short_digest sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd`),
    "sha256:a0b9bf06e4e6"
  );
});

/** The script with its five I/O functions replaced by fakes, run end to
 * end against this repository's real files. Everything upstream and
 * everything GitHub is faked; every pin is read, compared and reported
 * for real. Each GitHub call is appended to a log the caller reads back,
 * so "opened one issue per stale pin" is checked against the requests
 * that would really have been made. */
function runJob(env: Record<string, string> = {}): { stdout: string; calls: string[]; ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "fabrica-pin-freshness-"));
  const callLog = join(dir, "calls.log");
  const harness = join(dir, "harness.sh");

  writeFileSync(
    harness,
    `set -euo pipefail
cd ${JSON.stringify(repoRoot)}
source ${JSON.stringify(scriptPath)}

: > "$CALL_LOG"

fetch_url() {
  case "$1" in
    *nodejs.org*) printf '%s' "$NODE_FEED" ;;
    *go.dev*) printf '%s' "$GO_FEED" ;;
    *) echo "a fake was asked for an unexpected url: $1" >&2; return 1 ;;
  esac
}
latest_npm_version() { printf '%s' "$FAKE_CLI_LATEST"; }
tag_digest() { printf '%s' "$FAKE_IMAGE_DIGEST"; }
inspector_go_directive() { printf '%s' "$FAKE_INSPECTOR_GO"; }

# Stands in for one gh api call. Records the method, the endpoint and the
# request body, and answers the two reads the script makes. The issue
# search is answered by applying the script's own --jq filter's marker to
# the canned issue list, so the filter that keeps a pull request from
# being mistaken for an issue is the one really exercised.
gh_json() {
  local -a args=("$@")
  local i method="GET" filter="" endpoint="" has_input=0 payload=""
  for ((i = 0; i < \${#args[@]}; i++)); do
    case "\${args[i]}" in
      -X) method="\${args[i + 1]}" ;;
      --jq) filter="\${args[i + 1]}" ;;
      --input) has_input=1 ;;
      repos/*) endpoint="\${args[i]}" ;;
    esac
  done
  if [ "$has_input" -eq 1 ]; then payload=$(cat); fi
  printf '%s\\t%s\\t%s\\n' "$method" "$endpoint" "$payload" >> "$CALL_LOG"
  GH_OUT=""
  GH_ERR=""
  case "$method $endpoint" in
    "GET "*/labels/*) return "$FAKE_LABEL_PRESENT" ;;
    "GET "*/issues)
      GH_OUT=$(FILTER="$filter" node -e '
        const issues = JSON.parse(process.env.FAKE_ISSUES);
        const marker = (process.env.FILTER.match(/contains\\("(.*?)"\\)/) || [])[1];
        const hit = issues.find((i) => !i.pull_request && String(i.body || "").includes(marker));
        if (hit) process.stdout.write(String(hit.number));
      ') ;;
    "POST "*/issues) GH_OUT="https://example.invalid/issues/9" ;;
    "PATCH "*/issues/*) GH_OUT="{}" ;;
    "POST "*/labels) GH_OUT="{}" ;;
    *) echo "a fake was asked for an unexpected call: $method $endpoint" >&2; return 1 ;;
  esac
  return 0
}

main
`,
    "utf8"
  );

  const base: Record<string, string> = {
    CALL_LOG: callLog,
    GH_TOKEN: "a-fake-token",
    GITHUB_REPOSITORY: "inactdev/fabrica",
    GITHUB_RUN_ID: "1234",
    // Fresh by default: every fake answers with exactly what the
    // repository already pins, so a test only has to say what moved.
    NODE_FEED: JSON.stringify([{ version: "v25.1.0" }, { version: "v24.18.0" }, { version: "v24.9.0" }]),
    GO_FEED: JSON.stringify([{ version: "go1.26.8", stable: true }, { version: "go1.99.0", stable: false }]),
    FAKE_CLI_LATEST: "2.1.222",
    FAKE_IMAGE_DIGEST: "sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd",
    FAKE_INSPECTOR_GO: "1.22",
    FAKE_ISSUES: "[]",
    FAKE_LABEL_PRESENT: "0",
  };

  let stdout = "";
  let ok = true;
  let output = "";
  try {
    stdout = execFileSync("bash", [harness], { encoding: "utf8", env: { ...process.env, ...base, ...env } });
    output = stdout;
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    ok = false;
    stdout = e.stdout ?? "";
    output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }

  const calls = readFileSync(callLog, "utf8").split("\n").filter(Boolean);
  return { stdout, calls, ok, output };
}

/** The fresh-today values of the three fakes that have to move together
 * for every pin to look behind at once. */
const EVERYTHING_MOVED = {
  NODE_FEED: JSON.stringify([{ version: "v24.19.0", security: true }, { version: "v24.18.0" }]),
  GO_FEED: JSON.stringify([{ version: "go1.27.0", stable: true }]),
  FAKE_CLI_LATEST: "2.1.230",
  FAKE_IMAGE_DIGEST: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  FAKE_INSPECTOR_GO: "1.25.1",
};

test("every pin current: every pin is still compared, and nothing is written", () => {
  const { stdout, calls, ok, output } = runJob();

  assert.ok(ok, `the job should have succeeded:\n${output}`);
  for (const key of PIN_KEYS) {
    assert.match(stdout, new RegExp(`^${key}: .* is current at `, "m"), `${key} was not compared`);
  }
  assert.deepEqual(calls, [], `a run with nothing to report must not touch the GitHub API at all, but made: ${calls.join(" | ")}`);
});

test("every pin behind: one issue per stale pin, each titled with its own bump", () => {
  const { calls, ok, output } = runJob(EVERYTHING_MOVED);

  assert.ok(ok, `the job should have succeeded:\n${output}`);

  const opened = calls
    .filter((line) => line.startsWith("POST\t") && line.includes("/issues\t"))
    .map((line) => JSON.parse(line.split("\t")[2]) as { title: string; body: string; labels: string[] });

  assert.equal(opened.length, PIN_KEYS.length, `expected one issue per stale pin, got ${opened.length}: ${opened.map((i) => i.title).join(" | ")}`);
  assert.deepEqual(
    opened.map((issue) => issue.title),
    [
      "pin-freshness: Node 24.18.0 -> 24.19.0",
      "pin-freshness: worker CLI 2.1.222 -> 2.1.230",
      "pin-freshness: node base image digest sha256:a0b9bf06e4e6 -> sha256:111111111111",
      "pin-freshness: worker Go toolchain go1.26.8 -> go1.27.0",
      "pin-freshness: Inspector's minimum Go 1.22 -> 1.25.1",
    ],
    "each title must name the exact bump"
  );

  for (const issue of opened) {
    assert.deepEqual(issue.labels, ["pin-freshness"], "every issue carries the label it is found again by");
    assert.match(issue.body, /<!-- fabrica-pin-freshness: [a-z-]+ -->/, "every issue carries its pin's marker");
    assert.match(issue.body, /### The exact lines to change/, "issue #326 asks for the exact lines");
  }

  // "the exact lines to change" means real file:line:content read out of
  // this checkout, not a description of where to look.
  const node = opened.find((issue) => issue.title.includes("Node 24"))!;
  assert.match(node.body, /^\.node-version:1:24\.18\.0$/m);
  assert.match(node.body, /^package\.json:\d+: *"node": "24\.18\.0"$/m);
  assert.match(node.body, /^Dockerfile\.inspector:\d+:FROM cimg\/node:24\.18\.0$/m);
  assert.match(node.body, /^src\/brain\/adapters\/docker\/Dockerfile:\d+:.*24\.18\.0/m);

  // The digest pin lives in two files on purpose, and both have to move.
  const digest = opened.find((issue) => issue.title.includes("base image digest"))!;
  assert.match(digest.body, /^src\/brain\/adapters\/docker\/Dockerfile:\d+:FROM node@sha256:a0b9bf06/m);
  assert.match(digest.body, /^src\/relay\/container\/launch\.ts:\d+:.*sha256:a0b9bf06/m);

  assert.ok(
    calls.some((line) => line.startsWith("GET\t") && line.includes("/labels/pin-freshness")),
    "the label has to exist before an issue can be found by it again"
  );
});

test("a pin still behind on a later run updates its own issue instead of opening a second one", () => {
  const { stdout, calls, ok, output } = runJob({
    ...EVERYTHING_MOVED,
    FAKE_ISSUES: JSON.stringify([
      { number: 77, body: "what last week's run said <!-- fabrica-pin-freshness: node -->" },
      { number: 78, body: "and the week before <!-- fabrica-pin-freshness: go-toolchain -->" },
    ]),
  });

  assert.ok(ok, `the job should have succeeded:\n${output}`);
  assert.match(stdout, /^Updated #77: pin-freshness: Node 24\.18\.0 -> 24\.19\.0$/m);
  assert.match(stdout, /^Updated #78: pin-freshness: worker Go toolchain go1\.26\.8 -> go1\.27\.0$/m);

  const patched = calls.filter((line) => line.startsWith("PATCH\t")).map((line) => line.split("\t")[1]);
  assert.deepEqual(patched, ["repos/inactdev/fabrica/issues/77", "repos/inactdev/fabrica/issues/78"]);

  // The three pins with no issue open still get one; the two that had
  // one do not get a second.
  const opened = calls.filter((line) => line.startsWith("POST\t") && line.includes("/issues\t"));
  assert.equal(opened.length, 3, `expected three new issues and two updates, got ${opened.length} new`);
});

test("a pull request quoting the marker is never mistaken for the job's own issue", () => {
  const { calls, ok, output } = runJob({
    ...EVERYTHING_MOVED,
    FAKE_ISSUES: JSON.stringify([
      { number: 5, pull_request: { url: "..." }, body: "the pull request taking the bump <!-- fabrica-pin-freshness: node -->" },
    ]),
  });

  assert.ok(ok, `the job should have succeeded:\n${output}`);
  assert.equal(calls.filter((line) => line.startsWith("PATCH\t")).length, 0, "a pull request must never be rewritten by this job");
  assert.equal(calls.filter((line) => line.startsWith("POST\t") && line.includes("/issues\t")).length, PIN_KEYS.length);
});

test("an upstream answer this job cannot read fails the job loudly", () => {
  // An empty release index is a failed read, not an up-to-date pin. The
  // standing ruling in this project is that everything fails loudly and
  // a silent skip is a bug - reporting a pin as fresh because upstream
  // said nothing is exactly that bug.
  const { ok, output, calls } = runJob({ NODE_FEED: "[]" });
  assert.equal(ok, false, "an unreadable upstream answer must fail the job");
  // The reason has to survive, too: every read here hands its answer
  // back on stdout and is therefore called inside a command
  // substitution, which swallows anything written to stdout in it.
  assert.match(output, /::error::/, "must fail with a GitHub error annotation naming the cause");
  assert.match(output, /lists no release at all in the 24\.x line/);
  assert.deepEqual(calls, [], "and must write nothing on the way out");

  // A prerelease, or any other spelling that is not a dotted number, is
  // refused rather than quietly read as "not newer".
  const prerelease = runJob({ GO_FEED: JSON.stringify([{ version: "go1.27rc1", stable: true }]) });
  assert.equal(prerelease.ok, false, "a version this job cannot compare must fail the job");
  assert.match(prerelease.output, /The go-toolchain pin could not be compared/);
  assert.match(prerelease.output, /not a dotted numeric version/);
});

test("a pin whose value has moved out of the file fails the job rather than going unwatched", () => {
  // The whole design reads every pinned value out of the real file that
  // holds it, so there is no committed list of pins to drift. The other
  // half of that bargain is this: a pin the script can no longer locate
  // has to be loud, because a watcher that silently watches nothing is
  // worse than no watcher.
  let failed = "";
  try {
    // consider_pin itself, handed a pin whose value appears in no file -
    // which is what a reworded Dockerfile line or a renamed declaration
    // looks like from here.
    inBash(`
PIN_KEY="node"
PIN_LABEL="Node"
PIN_CURRENT="24.18.0"
PIN_LATEST="24.19.0"
PIN_MODE="version"
PIN_UPSTREAM="a test"
PIN_NOTE="a test"
PIN_NEEDLES=("a-version-no-file-of-this-repository-mentions")
PIN_FILES=(".node-version")
consider_pin`);
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    failed = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }

  assert.match(failed, /::error::This job watches the node pin/);
  assert.match(failed, /watching nothing/);
});
