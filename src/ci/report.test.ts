// The wording, which is what the Client actually reads. Issue #267 asks
// for "CI: 5 green, rehearsal red" on a task line specifically, so that
// exact shape is asserted rather than paraphrased.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checksCorrection, checksOutputForWorker, isRedReport, summarizeChecks } from "./report.ts";
import type { ChecksReport, ConcludedCheck } from "./types.ts";

function concluded(name: string, conclusion: string, red: boolean, logTail?: string): ConcludedCheck {
  return { name, source: "check-run", conclusion, red, url: `https://github.com/o/r/runs/${name}`, ...(logTail ? { logTail } : {}) };
}

function report(over: Partial<ChecksReport> = {}): ChecksReport {
  return {
    prUrl: "https://github.com/o/r/pull/7",
    sha: "abc123",
    verdict: "green",
    concluded: [],
    unresolved: [],
    summary: "",
    ...over,
  };
}

test("summarizeChecks produces issue #267's own example phrasing", () => {
  const five = ["a", "b", "c", "d", "e"].map((name) => concluded(name, "success", false));
  assert.equal(
    summarizeChecks(report({ verdict: "red", concluded: [...five, concluded("rehearsal", "failure", true)] })),
    "5 green, rehearsal red"
  );
});

test("summarizeChecks names the unknown checks and never calls them green", () => {
  const summary = summarizeChecks(
    report({
      verdict: "unknown",
      concluded: [concluded("a", "success", false)],
      unresolved: [{ name: "rehearsal", source: "check-run", status: "in_progress", url: null }],
    })
  );
  assert.equal(summary, "1 green, 1 unknown (rehearsal)");
  assert.doesNotMatch(summary, /2 green/);
});

test("summarizeChecks caps a long red list but says how many there were", () => {
  const red = ["a", "b", "c", "d", "e"].map((name) => concluded(name, "failure", true));
  assert.equal(summarizeChecks(report({ verdict: "red", concluded: red })), "a, b, c and 2 more red");
});

test("summarizeChecks says plainly when there were none, and when it could not be read", () => {
  assert.equal(summarizeChecks(report({ verdict: "none" })), "no checks reported");
  assert.equal(
    summarizeChecks(report({ verdict: "unreadable", problem: "GitHub answered 403 for GET /x\nsecond line" })),
    "could not be read: GitHub answered 403 for GET /x"
  );
});

test("summarizeChecks never hides a capped listing or a log it did not fetch", () => {
  const summary = summarizeChecks(report({ verdict: "red", concluded: [concluded("a", "failure", true)] }), {
    truncated: true,
    logsSkippedForCap: 2,
  });
  assert.match(summary, /not all read/);
  assert.match(summary, /2 red log\(s\) not fetched/);
});

test("checksOutputForWorker names every red check, its link and its log tail", () => {
  const output = checksOutputForWorker(
    report({
      verdict: "red",
      concluded: [concluded("nixfmt", "failure", true, "Error: file.nix is not formatted"), concluded("tests", "success", false)],
      unresolved: [{ name: "rehearsal", source: "check-run", status: "queued", url: null }],
    })
  );
  assert.match(output, /1 red, 1 green, 1 still running/);
  assert.match(output, /--- nixfmt \(check-run\): failure - https:\/\/github\.com\/o\/r\/runs\/nixfmt/);
  assert.match(output, /Error: file\.nix is not formatted/);
  // A green check is counted, never listed.
  assert.doesNotMatch(output, /--- tests/);
  assert.match(output, /Still running when this was read[\s\S]*rehearsal \(queued\)/);
});

test("checksOutputForWorker says so when no log was served, rather than leaving a bare name", () => {
  const output = checksOutputForWorker(report({ verdict: "red", concluded: [concluded("gate", "failure", true)] }));
  assert.match(output, /no job log was served for this one/);
});

test("checksCorrection tells the worker these ran after Inspector's own green", () => {
  const correction = checksCorrection("the output");
  assert.match(correction, /^the output/);
  assert.match(correction, /after Inspector had already called this branch green/);
});

test("only a concluded red turns a round red", () => {
  assert.equal(isRedReport(report({ verdict: "red" })), true);
  for (const verdict of ["green", "unknown", "none", "unreadable"] as const) {
    assert.equal(isRedReport(report({ verdict })), false, verdict);
  }
});
