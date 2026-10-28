import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkScript, inspectorConfigJson, protectedPathsFor } from "./scaffold.ts";
import { dependencyShapeFrom } from "./dockerfile.ts";
import { RECORDED_CHECK } from "./origin.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("protectedPathsFor always protects the gate, its definition and the box it runs in", () => {
  assert.deepEqual(protectedPathsFor([]), ["check.sh", ".inspector.json", "Dockerfile.inspector"]);
});

test("protectedPathsFor: --protected adds to those three rather than replacing them", () => {
  assert.deepEqual(protectedPathsFor(["*.test.ts", "contract/**"]), [
    "check.sh",
    ".inspector.json",
    "Dockerfile.inspector",
    "*.test.ts",
    "contract/**",
  ]);
});

test("protectedPathsFor: naming one of the defaults again does not duplicate it", () => {
  assert.deepEqual(protectedPathsFor([".inspector.json", "Dockerfile.inspector", "docs/**"]), [
    "check.sh",
    ".inspector.json",
    "Dockerfile.inspector",
    "docs/**",
  ]);
});

// Every path register always protects is one this repository's own
// config protects too - the only live evidence of what Inspector acts
// on. Dockerfile.inspector joined that list with inspector#47, since the
// check box is built from it (issue #303's clarification).
test("protectedPathsFor's defaults are all paths this repository's own .inspector.json protects", () => {
  const ours = JSON.parse(readFileSync(join(repoRoot, ".inspector.json"), "utf8")) as {
    protectedPaths?: string[];
  };
  for (const path of protectedPathsFor([])) {
    assert.ok(
      (ours.protectedPaths ?? []).includes(path),
      `${path} is protected by register but not by this repository's own .inspector.json`
    );
  }
});

// The schema here is this repository's own .inspector.json - a live
// config the real Inspector acts on. Only keys it actually shows are
// ever written, which is what inspector#47 broke for `image`/`network`
// and what this proves is fixed.
test("inspectorConfigJson writes only keys this repository's own .inspector.json uses", () => {
  const config = JSON.parse(inspectorConfigJson({ protectedPaths: ["check.sh"] }));
  assert.deepEqual(Object.keys(config).sort(), ["check", "protectedPaths"]);

  const ours = JSON.parse(readFileSync(join(repoRoot, ".inspector.json"), "utf8")) as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    assert.ok(
      Object.hasOwn(ours, key),
      `${key} is not a key this repository's own .inspector.json uses - the only evidence of the schema there is`
    );
  }
});

// inspector#47 retired both keys, with any value: the check box is built
// from Dockerfile.inspector and has no network, so there is nothing for
// either of them to say.
test("inspectorConfigJson writes no image and no network key, whatever it is asked for", () => {
  for (const config of [
    inspectorConfigJson(),
    inspectorConfigJson({ protectedPaths: [] }),
    inspectorConfigJson({ check: "npm test", protectedPaths: ["check.sh"], timeoutSeconds: 1200 }),
  ]) {
    const parsed = JSON.parse(config) as Record<string, unknown>;
    assert.equal(Object.hasOwn(parsed, "image"), false, config);
    assert.equal(Object.hasOwn(parsed, "network"), false, config);
  }
});

test("inspectorConfigJson: --timeout is written only when asked for", () => {
  const plain = JSON.parse(inspectorConfigJson({ protectedPaths: [] }));
  assert.equal(Object.hasOwn(plain, "timeoutSeconds"), false, "no --timeout leaves Inspector's own default");

  const full = JSON.parse(inspectorConfigJson({ protectedPaths: [], timeoutSeconds: 1200 }));
  assert.equal(full.timeoutSeconds, 1200);
});

// Same provenance rule as above, applied to the one key a flag writes:
// this repository's own config is the only evidence of it.
test("inspectorConfigJson: timeoutSeconds is a key this repository's own config uses", () => {
  const ours = JSON.parse(readFileSync(join(repoRoot, ".inspector.json"), "utf8")) as Record<string, unknown>;
  const full = JSON.parse(inspectorConfigJson({ protectedPaths: ["check.sh"], timeoutSeconds: 60 }));

  assert.deepEqual(Object.keys(full).sort(), ["check", "protectedPaths", "timeoutSeconds"]);
  for (const key of Object.keys(full)) {
    assert.ok(Object.hasOwn(ours, key), `${key} is not a key this repository's own .inspector.json uses`);
  }
  assert.equal(typeof ours.timeoutSeconds, typeof full.timeoutSeconds, "and the same type it uses it with");
});

test("inspectorConfigJson names ./check.sh as the check, whatever the command was", () => {
  const config = JSON.parse(inspectorConfigJson({ protectedPaths: [] }));
  assert.equal(config.check, RECORDED_CHECK);
});

test("inspectorConfigJson is pretty-printed with a trailing newline - a file a human edits later", () => {
  const text = inspectorConfigJson({ protectedPaths: ["check.sh"] });
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

// The other half of the Dockerfile's install step: the check box has no
// network, so a node_modules nothing links in is a node_modules that is
// never there. This repository's own check.sh is the reference shape.
test("checkScript links in what the check image baked, for a package-lock.json project", () => {
  const npm = dependencyShapeFrom({ packageLock: true, goSum: false });
  const script = checkScript("npm test", npm);

  assert.ok(script.includes(`cd "$(dirname "$0")"`), script);
  assert.ok(script.includes("[ -d /deps/node_modules ]"), script);
  assert.ok(script.includes("ln -s /deps/node_modules node_modules"), script);
  // ...and still runs for real anywhere else - a laptop, a worker's own
  // box, register's own proving run, all of which have a network and no
  // /deps.
  assert.ok(script.includes("npm ci"), script);
  assert.ok(script.endsWith("npm test\n"), script);
});

// A Go module's cache lives outside the checkout, so nothing has to be
// linked in and the script stays the bare command.
test("checkScript adds no preamble for a shape whose dependencies need no link", () => {
  const go = dependencyShapeFrom({ packageLock: false, goSum: true });
  assert.equal(checkScript("go test ./...", go), checkScript("go test ./..."));
});
