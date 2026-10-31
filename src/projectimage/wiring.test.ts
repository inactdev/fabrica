// Every place that builds a real worker, or a real self-test box, has to
// resolve the image that worker's project asks for (issue #322).
//
// Why this is a test and not a comment: the image is a parameter the
// caller passes, deliberately (so `fabrica doctor` reports the image a
// round will actually start, rather than a second resolution inside the
// adapter that could disagree with the line the Client was shown). The
// cost of that choice is that a new call site can be added without it,
// and the symptom would be silent - a machine working in the shared
// image, with no toolchain, exactly as before this issue. This fails
// loudly instead, naming the file.
//
// Read from the source, the same way
// src/foreman/no-host-check.test.ts and
// src/foreman/inspector-stamp-workflow.test.ts prove their own
// whole-directory facts: what is being asserted is a property of every
// file under src/, not of one function's return value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The two factories that build the real worker and the real worker's
 * box. Matched as calls - a barrel re-exporting the name has no
 * parenthesis after it, and the directory that defines them is skipped
 * below. */
const FACTORY_CALLS = ["defaultBrainAdapter(", "defaultCheckBox("];

/** Whichever resolver a call site uses to answer "which image" - the
 * project's path, or the task's own record. */
const RESOLVERS = ["machineImageForProject(", "machineImageForTask("];

/**
 * Call sites that deliberately use the shared image, with the reason.
 *
 * `quiz-recheck-entry.ts`: a quiz re-check reads a scratch checkout and
 * runs no project check, and one run covers several tasks that may be on
 * several different projects - so there is no single project image for it
 * to use, and the toolchain it would carry is not needed.
 */
const SHARED_IMAGE_ON_PURPOSE = ["src/cli/quiz-recheck-entry.ts"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      // Where the two factories are defined, and where the image is the
      // adapter's own default.
      return name === "adapters" || name === "helpers" ? [] : sourceFiles(path);
    }
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

test("every real worker and self-test box is built with its project's own image", () => {
  const missing: string[] = [];
  for (const path of sourceFiles(join(ROOT, "src"))) {
    const text = readFileSync(path, "utf8");
    if (!FACTORY_CALLS.some((call) => text.includes(call))) continue;
    const name = relative(ROOT, path);
    if (SHARED_IMAGE_ON_PURPOSE.includes(name)) continue;
    if (!RESOLVERS.some((resolver) => text.includes(resolver))) missing.push(name);
  }

  assert.deepEqual(
    missing,
    [],
    `these build a worker without resolving its project's machine image: ${missing.join(", ")} - ` +
      `pass \`image\` (src/projectimage/), or add the file to SHARED_IMAGE_ON_PURPOSE with the reason`
  );
});

test("the call sites this covers are really there, so the scan cannot pass vacuously", () => {
  // A scan that finds nothing passes. These are the files that exist to
  // be found today: if a rename empties the list, that is a failure here
  // rather than a test that quietly stopped testing anything.
  const found = sourceFiles(join(ROOT, "src"))
    .filter((path) => FACTORY_CALLS.some((call) => readFileSync(path, "utf8").includes(call)))
    .map((path) => relative(ROOT, path))
    .sort();

  assert.deepEqual(found, [
    "src/cli/answer-entry.ts",
    "src/cli/quiz-recheck-entry.ts",
    "src/cli/run-task-entry.ts",
    "src/cli/verdict-fix-entry.ts",
    "src/foreman/foreman.ts",
    "src/foreman/judge.ts",
  ]);
});
