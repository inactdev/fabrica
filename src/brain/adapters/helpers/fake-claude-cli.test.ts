// Proves fake-claude-cli.mjs hasn't drifted from the real `claude`
// binary's stream-json shape (issue #46). This is deliberately NOT the
// same proof as claude-code.test.ts's capability spike: that test drives
// the real binary live (skipped when Docker/auth aren't available, and
// now loud about it when it is - see that file); this test runs the fake
// directly as a subprocess, no Docker needed, so it always runs and
// always compares against a fixture recorded once from the real thing.
//
// "Shape parity" here means: every key claude-code.ts's parseLines()/
// toTranscript() actually reads (see stream-json-shape.ts's allowlist),
// present in the recorded real sample, must also be present in the fake's
// output with the same JS type. A field neither the fixture nor the
// adapter cares about can change freely on either side without failing
// this test - the line is drawn at "what the adapter depends on", not
// "byte-for-byte equality" (see fixtures/README.md for where that line
// was drawn and why).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { coverageGaps, extractShape, shapeDiff, UNPROVABLE_BY_RECORDING } from "./stream-json-shape.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(HERE, "fake-claude-cli.mjs");
const FIXTURE_PATH = join(HERE, "fixtures", "real-claude-cli-sample.jsonl");

function loadFixtureShape() {
  const lines = readFileSync(FIXTURE_PATH, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return extractShape(lines);
}

function runFakeCli(brief: string) {
  const stdout = execFileSync("node", [FAKE_CLI, "-p", brief, "--output-format", "stream-json", "--verbose"], {
    encoding: "utf8",
  });
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return extractShape(lines);
}

// The parity test below can only ever check what its reference actually
// demonstrates, so a fixture that lost a block type - a re-recording
// where the model answered without calling a tool, say - would keep it
// green while checking strictly less. That narrowing has to fail here
// too, not just in the hand-run re-record script, or it arrives by
// commit and nobody hears it.
test("the committed fixture still demonstrates every shape the allowlist covers", () => {
  const gaps = coverageGaps(loadFixtureShape());

  assert.deepEqual(
    gaps,
    [],
    "the recorded real sample no longer exercises every field the adapter reads, so the shape-parity " +
      "test below silently stopped checking these:\n" +
      gaps.join("\n") +
      "\nRe-record the fixture (helpers/record-real-cli-fixture.mjs) rather than deleting the check. " +
      "The only keys exempt from this are the ones stream-json-shape.ts's UNPROVABLE_BY_RECORDING " +
      `explains: ${Object.keys(UNPROVABLE_BY_RECORDING).join(", ")}.`
  );
});

test("fake-claude-cli.mjs's SUCCESS_WITH_TOOLS output matches the shape of a recorded real sample", () => {
  const real = loadFixtureShape();
  const fake = runFakeCli("SUCCESS_WITH_TOOLS");

  const diff = shapeDiff(real, fake);
  assert.deepEqual(
    diff,
    [],
    "the fake CLI's output no longer matches the real CLI's shape for a field the adapter reads - " +
      "re-record the fixture (helpers/record-real-cli-fixture.mjs) if this is a genuine real-CLI change, " +
      "or update fake-claude-cli.mjs if the fake has simply gone stale:\n" +
      diff.join("\n")
  );
});
