import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkScript, inspectorConfigJson, protectedPathsFor } from "./scaffold.ts";
import { RECORDED_CHECK } from "./origin.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("protectedPathsFor always protects the gate and the gate's own definition", () => {
  assert.deepEqual(protectedPathsFor([]), ["check.sh", ".inspector.json"]);
});

test("protectedPathsFor: --protected adds to those two rather than replacing them", () => {
  assert.deepEqual(protectedPathsFor(["*.test.ts", "contract/**"]), [
    "check.sh",
    ".inspector.json",
    "*.test.ts",
    "contract/**",
  ]);
});

test("protectedPathsFor: naming one of the two defaults again does not duplicate it", () => {
  assert.deepEqual(protectedPathsFor([".inspector.json", "docs/**"]), [
    "check.sh",
    ".inspector.json",
    "docs/**",
  ]);
});

// The schema here is this repository's own .inspector.json - a live
// config the real Inspector acts on - plus the minimal two-key form
// contract/helpers/fixture.ts proves valid. Only keys one of those two
// actually shows are ever written.
test("inspectorConfigJson writes only keys this repository's own .inspector.json uses", () => {
  const config = JSON.parse(inspectorConfigJson({ image: "node:24", protectedPaths: ["check.sh"] }));
  assert.deepEqual(Object.keys(config).sort(), ["check", "image", "protectedPaths"]);

  const ours = JSON.parse(readFileSync(join(repoRoot, ".inspector.json"), "utf8")) as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    assert.ok(
      Object.hasOwn(ours, key),
      `${key} is not a key this repository's own .inspector.json uses - the only evidence of the schema there is`
    );
  }
});

test("inspectorConfigJson names ./check.sh as the check, whatever the command was", () => {
  const config = JSON.parse(inspectorConfigJson({ image: "node:24", protectedPaths: [] }));
  assert.equal(config.check, RECORDED_CHECK);
  assert.equal(config.image, "node:24");
});

test("inspectorConfigJson is pretty-printed with a trailing newline - a file a human edits later", () => {
  const text = inspectorConfigJson({ image: "node:24", protectedPaths: ["check.sh"] });
  assert.ok(text.endsWith("\n"));
  assert.ok(text.includes("\n  "), "should be indented, not a single-line blob");
});

test("checkScript holds the command verbatim, under a shebang and set -e", () => {
  const script = checkScript("npm run lint && npm test");
  assert.ok(script.startsWith("#!/bin/sh\n"));
  assert.ok(script.includes("\nset -e\n"));
  assert.ok(script.endsWith("npm run lint && npm test\n"));
});

test("checkScript says where it came from, for whoever reads it next", () => {
  const script = checkScript("npm test");
  assert.ok(script.includes("fabrica register"));
  assert.ok(script.includes("Inspector runs this file"));
});
