import { test } from "node:test";
import assert from "node:assert/strict";
import { formatShadowReport, shadowCountsLine, shadowReport } from "./report.ts";
import type { EventsByTask } from "./report.ts";
import type { FabricaEvent } from "../record/index.ts";
import type { WouldCloseByRuleDetails } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

function evaluation(over: Partial<WouldCloseByRuleDetails> = {}): WouldCloseByRuleDetails {
  return {
    project: "/p/alpha",
    rulesPath: ".fabrica/skip-rules.toml",
    rulesVersion: "1@abcdef012345",
    fingerprint: "a".repeat(40),
    mode: "shadow",
    wouldClose: true,
    closedByKind: "docs-only",
    kinds: [
      {
        kind: "docs-only",
        description: "A documentation-only change",
        mode: "shadow",
        safe: true,
        answers: [],
      },
    ],
    ...over,
  };
}

function task(
  events: { name: FabricaEvent["name"]; details?: unknown; atMs?: number }[],
  id = "task-1"
): [string, FabricaEvent[]] {
  return [
    id,
    events.map((event) => ({
      occurredAt: new Date(event.atMs ?? NOW).toISOString(),
      taskId: id,
      name: event.name,
      ...(event.details === undefined ? {} : { details: event.details }),
    })),
  ];
}

function byTask(...entries: [string, FabricaEvent[]][]): EventsByTask {
  return new Map(entries);
}

test("a would-close the Client accepted counts as agreement", () => {
  const report = shadowReport(
    byTask(
      task([
        { name: "would-close-by-rule", details: evaluation(), atMs: NOW - 3 * DAY_MS },
        { name: "verdict-recorded", details: { ruling: "accept" } },
      ])
    ),
    NOW
  );
  assert.equal(report.rows.length, 1);
  const [row] = report.rows;
  assert.equal(row.project, "/p/alpha");
  assert.equal(row.kind, "docs-only");
  assert.equal(row.description, "A documentation-only change");
  assert.equal(row.wouldClose, 1);
  assert.equal(row.accepted, 1);
  assert.equal(row.disagreed, 0);
  assert.equal(row.pending, 0);
  assert.equal(row.daysRunning, 3);
  assert.deepEqual(report.totals, { wouldClose: 1, accepted: 1, disagreed: 0, pending: 0 });
});

test("a fix and a wrong both count as the Client disagreeing - the number that says a kind is not ready", () => {
  for (const ruling of ["fix", "wrong"]) {
    const report = shadowReport(
      byTask(task([{ name: "would-close-by-rule", details: evaluation() }, { name: "verdict-recorded", details: { ruling } }])),
      NOW
    );
    assert.equal(report.rows[0].disagreed, 1, ruling);
    assert.equal(report.rows[0].accepted, 0, ruling);
  }
});

test("a would-close still waiting on him is pending, not silently dropped", () => {
  const report = shadowReport(byTask(task([{ name: "would-close-by-rule", details: evaluation() }])), NOW);
  assert.equal(report.rows[0].wouldClose, 1);
  assert.equal(report.rows[0].pending, 1);
  assert.equal(report.rows[0].accepted + report.rows[0].disagreed + report.rows[0].pending, report.rows[0].wouldClose);
});

test("an unsafe kind is never counted as a would-close", () => {
  const unsafe = evaluation({
    wouldClose: false,
    closedByKind: null,
    kinds: [{ kind: "docs-only", description: "d", mode: "shadow", safe: false, answers: [] }],
  });
  const report = shadowReport(byTask(task([{ name: "would-close-by-rule", details: unsafe }])), NOW);
  assert.deepEqual(report.rows, []);
  assert.equal(report.totals.wouldClose, 0);
});

test("only a task's LATEST evaluation counts, so a fix round never reports one task twice", () => {
  const report = shadowReport(
    byTask(
      task([
        { name: "would-close-by-rule", details: evaluation(), atMs: NOW - 2 * DAY_MS },
        { name: "verdict-recorded", details: { ruling: "fix" } },
        { name: "would-close-by-rule", details: evaluation(), atMs: NOW - DAY_MS },
        { name: "verdict-recorded", details: { ruling: "accept" } },
      ])
    ),
    NOW
  );
  assert.equal(report.rows[0].wouldClose, 1);
  assert.equal(report.rows[0].accepted, 1);
  assert.equal(report.rows[0].disagreed, 0);
  // Days running comes from the latest evaluation's own time, since that
  // is the only one counted.
  assert.equal(report.rows[0].daysRunning, 1);
});

test("rows are grouped per project and kind, and sorted so a reader can scan them", () => {
  const twoKinds = evaluation({
    kinds: [
      { kind: "docs-only", description: "Docs", mode: "shadow", safe: true, answers: [] },
      { kind: "tiny-fix", description: "Tiny", mode: "shadow", safe: true, answers: [] },
    ],
  });
  const report = shadowReport(
    byTask(
      task([{ name: "would-close-by-rule", details: twoKinds }], "task-1"),
      task([{ name: "would-close-by-rule", details: { ...twoKinds, project: "/p/beta" } }], "task-2"),
      task([{ name: "would-close-by-rule", details: twoKinds }], "task-3")
    ),
    NOW
  );
  assert.deepEqual(
    report.rows.map((row) => [row.project, row.kind, row.wouldClose]),
    [
      ["/p/alpha", "docs-only", 2],
      ["/p/alpha", "tiny-fix", 2],
      ["/p/beta", "docs-only", 1],
      ["/p/beta", "tiny-fix", 1],
    ]
  );
  assert.equal(report.totals.wouldClose, 6);
});

test("a rules file that could not be used is reported separately, with its own reason and count", () => {
  const broken = evaluation({ wouldClose: false, closedByKind: null, kinds: [], problem: 'mode = "live": CONTRACT rule 6' });
  const report = shadowReport(
    byTask(
      task([{ name: "would-close-by-rule", details: broken }], "task-1"),
      task([{ name: "would-close-by-rule", details: broken }], "task-2")
    ),
    NOW
  );
  assert.deepEqual(report.rows, []);
  assert.equal(report.problems.length, 1);
  assert.equal(report.problems[0].tasks, 2);
  assert.match(report.problems[0].problem, /CONTRACT rule 6/);
});

test("the count line is null when no project has skip rules at all", () => {
  assert.equal(shadowCountsLine(byTask(task([{ name: "delivered" }])), NOW), null);
  assert.equal(shadowCountsLine(byTask(), NOW), null);
});

test("the count line says plainly that nothing closes, and names the three numbers", () => {
  const line = shadowCountsLine(
    byTask(
      task([{ name: "would-close-by-rule", details: evaluation() }, { name: "verdict-recorded", details: { ruling: "accept" } }], "a"),
      task([{ name: "would-close-by-rule", details: evaluation() }, { name: "verdict-recorded", details: { ruling: "wrong" } }], "b"),
      task([{ name: "would-close-by-rule", details: evaluation() }], "c")
    ),
    NOW
  );
  assert.ok(line !== null);
  assert.match(line, /shadow, nothing closes/);
  assert.match(line, /3 would have closed/);
  assert.match(line, /1 you accepted/);
  assert.match(line, /1 you did not/);
  assert.match(line, /1 still waiting on you/);
});

test("the count line still appears, and says so, when only a broken rules file exists", () => {
  const line = shadowCountsLine(
    byTask(task([{ name: "would-close-by-rule", details: evaluation({ kinds: [], problem: "bad file" }) }])),
    NOW
  );
  assert.ok(line !== null, "a broken rules file left the surfaces silent");
  assert.match(line, /1 rules file could not be read/);
  assert.match(line, /fabrica shadow-report/);
});

test("the printed report opens by saying nothing closes, and lists each kind's four numbers", () => {
  const report = shadowReport(
    byTask(
      task(
        [{ name: "would-close-by-rule", details: evaluation(), atMs: NOW - 31 * DAY_MS }, { name: "verdict-recorded", details: { ruling: "accept" } }],
        "a"
      )
    ),
    NOW
  );
  const lines = formatShadowReport(report);
  assert.match(lines[0], /nothing closes by rule/);
  assert.match(lines.join("\n"), /\/p\/alpha/);
  assert.match(lines.join("\n"), /docs-only - A documentation-only change/);
  assert.match(lines.join("\n"), /would-close 1, accepted 1, disagreed 0, running 31 days/);
});

test("the printed report says so plainly when nothing has been evaluated yet", () => {
  assert.match(formatShadowReport(shadowReport(byTask(), NOW)).join("\n"), /No task has been evaluated/);
});
