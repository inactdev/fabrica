// The loop, against a real local HTTP server speaking the endpoints
// GitHub documents - so the real client, the real status codes and the
// real 302-to-a-blob log download are all exercised without github.com.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pollPullRequestChecks, DEFAULT_CHECKS_APPEAR_MS, DEFAULT_CHECKS_WAIT_MS } from "./poll.ts";
import { MAX_LOG_TAIL_BYTES } from "./logs.ts";
import { checkRun, commitStatus, fakeClock, runningCheckRun, startFakeGithub } from "./helpers/fake-github.ts";
import type { FakeGithubPlan } from "./helpers/fake-github.ts";
import type { ChecksReport } from "./types.ts";

const REF = { owner: "o", repo: "r", number: 7 };
const PR_URL = "https://github.com/o/r/pull/7";

async function poll(plan: FakeGithubPlan, over: { waitMs?: number; appearMs?: number } = {}): Promise<{
  report: ChecksReport;
  requests: readonly { path: string; authorization: string | null }[];
}> {
  const github = await startFakeGithub(plan);
  try {
    const clock = fakeClock();
    const report = await pollPullRequestChecks(PR_URL, REF, {
      token: "t0ken",
      baseUrl: github.baseUrl,
      now: clock.now,
      sleep: clock.sleep,
      ...over,
    });
    return { report, requests: github.requests };
  } finally {
    await github.close();
  }
}

test("every check green reads as green, with the head sha the API reported", async () => {
  const { report } = await poll({
    sha: "feedface",
    checkRuns: [[checkRun("tests", "success"), checkRun("lint", "success")]],
    statuses: [[commitStatus("inspector", "success")]],
  });
  assert.equal(report.verdict, "green");
  assert.equal(report.sha, "feedface");
  assert.equal(report.summary, "3 green");
  assert.deepEqual(report.unresolved, []);
});

test("one red check makes the whole read red and names it", async () => {
  const { report } = await poll({
    checkRuns: [[checkRun("tests", "success", { id: 11 }), checkRun("rehearsal", "failure", { id: 12 })]],
  });
  assert.equal(report.verdict, "red");
  assert.equal(report.summary, "1 green, rehearsal red");
});

test("a red commit status is red too, not only a red check run", async () => {
  const { report } = await poll({ statuses: [[commitStatus("inspector", "failure", "https://ci.test/1")]] });
  assert.equal(report.verdict, "red");
  assert.equal(report.concluded[0].source, "commit-status");
  assert.equal(report.concluded[0].url, "https://ci.test/1");
});

test("skipped and neutral checks are not red - the repository's own decision stands", async () => {
  const { report } = await poll({
    checkRuns: [[checkRun("docker-tests", "skipped"), checkRun("advisory", "neutral")]],
  });
  assert.equal(report.verdict, "green");
});

test("it keeps polling until a running check concludes", async () => {
  const { report } = await poll({
    checkRuns: [
      [runningCheckRun("rehearsal", { id: 5 })],
      [runningCheckRun("rehearsal", { id: 5 })],
      [checkRun("rehearsal", "success", { id: 5 })],
    ],
  });
  assert.equal(report.verdict, "green");
  assert.equal(report.summary, "1 green");
});

test("a check that never concludes within the wait is unknown, never green", async () => {
  const { report } = await poll({ checkRuns: [[runningCheckRun("rehearsal", { id: 5, status: "queued" })]] }, { waitMs: 60_000 });
  assert.equal(report.verdict, "unknown");
  assert.deepEqual(report.unresolved, [
    { name: "rehearsal", source: "check-run", status: "queued", url: "https://github.com/o/r/runs/5" },
  ]);
  assert.equal(report.concluded.length, 0);
});

test("a red check plus one still running is red - a silence never cancels an answer", async () => {
  const { report } = await poll(
    { checkRuns: [[checkRun("gate", "failure", { id: 1 }), runningCheckRun("slow", { id: 2 })]] },
    { waitMs: 30_000 }
  );
  assert.equal(report.verdict, "red");
  assert.match(report.summary, /gate red/);
  assert.match(report.summary, /1 unknown \(slow\)/);
});

test("a repository GitHub reports no checks for is 'none', after the appear window and no longer", async () => {
  const { report, requests } = await poll({ checkRuns: [[]], statuses: [[]] }, { appearMs: 30_000 });
  assert.equal(report.verdict, "none");
  assert.equal(report.summary, "no checks reported");
  // It gave up after the appear window, not after the whole 20-minute
  // wait: a repository with no CI must not cost a task twenty minutes.
  const reads = requests.filter((request) => request.path.includes("/check-runs")).length;
  assert.ok(reads <= 3, `expected a short appear window, saw ${reads} reads`);
});

test("a check that registers late, inside the appear window, is still seen", async () => {
  const { report } = await poll({ checkRuns: [[], [], [checkRun("tests", "success")]] }, { appearMs: 60_000 });
  assert.equal(report.verdict, "green");
});

test("an API that refuses is unreadable, with the status in the problem - never green", async () => {
  const { report } = await poll({ failWith: 403 });
  assert.equal(report.verdict, "unreadable");
  assert.match(report.problem ?? "", /403/);
  assert.match(report.summary, /could not be read/);
});

test("a red Actions check gets the tail of its own job log attached", async () => {
  const { report } = await poll({
    checkRuns: [[checkRun("nixfmt", "failure", { id: 900 })]],
    workflowRuns: [{ id: 50 }],
    jobs: { 50: [{ id: 77, check_run_url: "https://api.github.com/repos/o/r/check-runs/900" }] },
    logs: { 77: "step one ok\nError: file.nix is not formatted\n" },
  });
  assert.equal(report.verdict, "red");
  assert.match(report.concluded[0].logTail ?? "", /Error: file\.nix is not formatted/);
});

test("a job log is downloaded without Fabrica's GitHub token ever reaching the blob host", async () => {
  const { requests } = await poll({
    checkRuns: [[checkRun("nixfmt", "failure", { id: 900 })]],
    workflowRuns: [{ id: 50 }],
    jobs: { 50: [{ id: 77, check_run_url: "https://api.github.com/repos/o/r/check-runs/900" }] },
    logs: { 77: "boom" },
  });
  const blob = requests.find((request) => request.path.startsWith("/blob/"));
  assert.ok(blob, "the redirect was never followed");
  assert.equal(blob.authorization, null, "the token was forwarded to the blob host");
  const api = requests.find((request) => request.path.includes("/check-runs"));
  assert.equal(api?.authorization, "Bearer t0ken", "the API call carried no token");
});

test("a huge job log is kept as a bounded tail that says what it dropped", async () => {
  const body = `${"x".repeat(MAX_LOG_TAIL_BYTES * 2)}\nfinal failure line\n`;
  const { report } = await poll({
    checkRuns: [[checkRun("tests", "failure", { id: 900 })]],
    workflowRuns: [{ id: 50 }],
    jobs: { 50: [{ id: 77, check_run_url: "https://api.github.com/repos/o/r/check-runs/900" }] },
    logs: { 77: body },
  });
  const tail = report.concluded[0].logTail ?? "";
  assert.ok(Buffer.byteLength(tail, "utf8") < body.length, "the whole log was stored");
  assert.match(tail, /^\[truncated, showing last \d+ of \d+ bytes\]/);
  assert.match(tail, /final failure line/);
});

test("a red check whose job cannot be matched simply gets no log, and the read still reports red", async () => {
  const { report } = await poll({
    checkRuns: [[checkRun("gate", "failure", { id: 900 })]],
    workflowRuns: [{ id: 50 }],
    jobs: { 50: [{ id: 77, check_run_url: "https://api.github.com/repos/o/r/check-runs/111" }] },
  });
  assert.equal(report.verdict, "red");
  assert.equal(report.concluded[0].logTail, undefined);
});

test("no log lookup happens at all when nothing is red", async () => {
  const { requests } = await poll({ checkRuns: [[checkRun("tests", "success")]] });
  assert.equal(
    requests.filter((request) => request.path.includes("/actions/")).length,
    0,
    "a green round paid for the Actions lookup"
  );
});

test("every concluded check is announced once, however many ticks it is seen on", async () => {
  const github = await startFakeGithub({
    checkRuns: [
      [checkRun("tests", "success", { id: 1 }), runningCheckRun("slow", { id: 2 })],
      [checkRun("tests", "success", { id: 1 }), runningCheckRun("slow", { id: 2 })],
      [checkRun("tests", "success", { id: 1 }), checkRun("slow", "success", { id: 2 })],
    ],
  });
  try {
    const clock = fakeClock();
    const announced: string[] = [];
    await pollPullRequestChecks(PR_URL, REF, {
      token: "t",
      baseUrl: github.baseUrl,
      now: clock.now,
      sleep: clock.sleep,
      onConcluded: (check) => announced.push(check.name),
    });
    assert.deepEqual(announced, ["tests", "slow"]);
  } finally {
    await github.close();
  }
});

test("the bounded wait and the appear window are deliberately different orders of magnitude", () => {
  assert.ok(
    DEFAULT_CHECKS_APPEAR_MS * 5 < DEFAULT_CHECKS_WAIT_MS,
    "the two windows answer different questions and must not be harmonized"
  );
});
