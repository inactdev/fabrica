// `tests.map`'s own format: one line per entry, and every line Fabrica
// cannot read refused by name rather than skipped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTestMap, renderTestMap, TEST_MAP_FILENAME } from "./parse.ts";
import { TestMapError } from "./errors.ts";

test("parseTestMap reads one entry per line, keeping file order and line numbers", () => {
  const entries = parseTestMap(
    [
      "# which tests cover which files",
      "",
      "src/foreman/do.ts: src/foreman/do.test.ts",
      "   src/cli/*.ts   :   src/cli/main.test.ts ,  npm test -- src/cli  ",
      "   # an indented comment",
      "",
    ].join("\n")
  );

  assert.deepEqual(entries, [
    { pattern: "src/foreman/do.ts", tests: ["src/foreman/do.test.ts"], line: 3 },
    { pattern: "src/cli/*.ts", tests: ["src/cli/main.test.ts", "npm test -- src/cli"], line: 4 },
  ]);
});

test("parseTestMap keeps a command's own colons and commas out of the entry's shape", () => {
  // Only the FIRST colon separates a pattern from its tests, so a
  // command carrying one of its own survives.
  const [entry] = parseTestMap("src/relay/*.ts: npm test -- --reporter=spec:verbose");
  assert.equal(entry.pattern, "src/relay/*.ts");
  assert.deepEqual(entry.tests, ["npm test -- --reporter=spec:verbose"]);
});

test("parseTestMap keeps two lines naming the same pattern separate", () => {
  // Not merged here on purpose: a touched file takes the union of every
  // entry it matches anyway, and keeping the lines apart keeps each
  // one's own number for a broken-mapping report.
  const entries = parseTestMap(["src/cli/*.ts: a.test.ts", "src/cli/*.ts: b.test.ts"].join("\n"));
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => entry.line),
    [1, 2]
  );
});

test("parseTestMap refuses a line that is not a mapping, naming the line and the fix", () => {
  const thrown = (text: string): TestMapError => {
    try {
      parseTestMap(text);
    } catch (err) {
      assert.ok(err instanceof TestMapError, `not a TestMapError: ${err}`);
      assert.equal(err.code, "malformed-test-map");
      return err;
    }
    throw new Error(`parseTestMap accepted ${JSON.stringify(text)}`);
  };

  // No colon at all - the message has to say which line and what a line
  // looks like, since that is the whole of the fix.
  const noColon = thrown("src/foreman/do.ts src/foreman/do.test.ts");
  assert.match(noColon.message, new RegExp(`^${TEST_MAP_FILENAME} line 1 is not a mapping`));
  assert.match(noColon.message, /glob pattern, a colon/);

  assert.match(thrown("\n\n: src/cli/main.test.ts").message, /line 3 has no pattern before its colon/);
  // An entry mapping to nothing is refused rather than read as "covered
  // by nothing", which would be indistinguishable from unmapped while
  // looking deliberate.
  assert.match(thrown("src/cli/*.ts:").message, /line 1 names no tests for "src\/cli\/\*\.ts"/);
  assert.match(thrown("src/cli/*.ts:  ,  , ").message, /names no tests/);
});

test("renderTestMap writes what parseTestMap reads back", () => {
  const text = "src/cli/*.ts: a.test.ts, npm test -- src/cli\nsrc/line/cut.ts: src/line/cut.test.ts\n";
  assert.equal(renderTestMap(parseTestMap(text)), text);
});
