// What a worker, and then the Client, actually read about the test map.

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeTestMapNote, describeTestMapReport, testMapBriefNotice, STATUS_FILES_NAMED } from "./describe.ts";
import type { TestMapReport } from "./types.ts";

const EMPTY: TestMapReport = { mapped: [], tests: [], unmapped: [], broken: [] };

test("the brief's notice always states the lookup rule and both halves of the run", () => {
  const notice = testMapBriefNotice();

  assert.match(notice, /tests\.map/);
  // Mapped first, then the whole suite - the Client's own ordering, and
  // the reason this notice replaces the only-touched-tests one rather
  // than joining it.
  assert.match(notice, /union of every pattern/);
  assert.match(notice, /stop and fix a failure there before/);
  assert.match(notice, /whole suite/);
  assert.match(notice, /testsRun/);
  assert.match(notice, /unmapped/);
  // Issue #305: the worker is told what is not counted, so the brief,
  // the delivery and the status row agree about it.
  assert.match(notice, /documentation needs no test and is never reported/);
  assert.match(notice, /counts as covering itself/);
});

test("a first round's notice names no tests, since it has touched nothing yet", () => {
  // Naming a list derived from a diff that does not exist would be the
  // silent guess rule 4 forbids.
  const notice = testMapBriefNotice(EMPTY);
  assert.ok(!notice.includes("run these first"));
  assert.ok(!notice.includes("mapped to nothing"));
});

test("a fix round's notice names the concrete tests and the concrete unmapped files", () => {
  const notice = testMapBriefNotice({
    mapped: [{ file: "src/cli/main.ts", tests: ["src/cli/main.test.ts"] }],
    tests: ["src/cli/main.test.ts"],
    unmapped: ["src/cli/help.ts"],
    broken: [],
  });

  assert.match(notice, /run these first:\n {2}- src\/cli\/main\.test\.ts/);
  assert.match(notice, /mapped to nothing[^]*- src\/cli\/help\.ts/);
});

test("the delivery's block marks the worker's list as the worker's own, and says so when there is none", () => {
  const mapped: TestMapReport = {
    mapped: [{ file: "src/cli/main.ts", tests: ["src/cli/main.test.ts"] }],
    tests: ["src/cli/main.test.ts"],
    unmapped: [],
    broken: [],
  };

  const silent = describeTestMapReport(mapped);
  assert.match(silent, /mapped tests for this round's touched files: src\/cli\/main\.test\.ts/);
  assert.match(silent, /the worker reported no mapped tests as run/);

  const reported = describeTestMapReport({ ...mapped, reportedByWorker: "src/cli/main.test.ts - green" });
  assert.match(reported, /the worker's own report of which it ran \(not checked against the list above\)/);
  assert.match(reported, /src\/cli\/main\.test\.ts - green/);
});

test("the delivery's block names every unmapped file and every broken mapping", () => {
  const block = describeTestMapReport({
    ...EMPTY,
    unmapped: ["src/foreman/judge.ts", "src/cli/stray.ts"],
    broken: [{ pattern: "src/cli/help.ts", test: "src/cli/help.test.ts", line: 7 }],
  });

  assert.match(block, /- src\/foreman\/judge\.ts/);
  assert.match(block, /- src\/cli\/stray\.ts/);
  // Issue #305: the list is code files, and the line says so - so it is
  // not read as "the whole diff, documentation and all".
  assert.match(block, /touched code files tests\.map maps to nothing/);
  assert.match(block, /documentation is never counted here/);
  assert.match(block, /line 7, "src\/cli\/help\.ts" -> src\/cli\/help\.test\.ts/);
  // The limit is stated rather than papered over: a mapping naming a
  // command is never checked, so this list cannot be read as complete.
  assert.match(block, /naming a command is never checked/);
});

test("a project with no map, and a round the map covered, say nothing at all", () => {
  assert.equal(describeTestMapReport(undefined), "");
  assert.equal(describeTestMapNote(undefined), null);
  assert.equal(describeTestMapNote(EMPTY), null);
  assert.equal(
    describeTestMapNote({
      mapped: [{ file: "src/cli/main.ts", tests: ["src/cli/main.test.ts"] }],
      tests: ["src/cli/main.test.ts"],
      unmapped: [],
      broken: [],
    }),
    null
  );
});

test("the status note counts and names what is missing, capped so a row stays one line", () => {
  assert.equal(
    describeTestMapNote({ ...EMPTY, unmapped: ["a.ts"] }),
    "tests.map: 1 touched code file unmapped (a.ts)"
  );
  assert.equal(
    describeTestMapNote({ ...EMPTY, unmapped: ["a.ts", "b.ts"] }),
    "tests.map: 2 touched code files unmapped (a.ts, b.ts)"
  );

  // Issue #305: five are named outright, and only a sixth starts the
  // "and N more" tail.
  assert.equal(STATUS_FILES_NAMED, 5);
  const five = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
  assert.equal(
    describeTestMapNote({ ...EMPTY, unmapped: five }),
    "tests.map: 5 touched code files unmapped (a.ts, b.ts, c.ts, d.ts, e.ts)"
  );
  assert.equal(
    describeTestMapNote({ ...EMPTY, unmapped: [...five, "f.ts", "g.ts"] }),
    "tests.map: 7 touched code files unmapped (a.ts, b.ts, c.ts, d.ts, e.ts, and 2 more)"
  );

  assert.equal(
    describeTestMapNote({
      ...EMPTY,
      unmapped: ["a.ts"],
      broken: [{ pattern: "x", test: "x.test.ts", line: 1 }],
    }),
    "tests.map: 1 touched code file unmapped (a.ts), 1 broken mapping (x.test.ts)"
  );
});
