#!/usr/bin/env node
// Runs as the "prepare" lifecycle script (package.json) - for a git
// dependency, npm runs `prepare` *before* packing, while `.git` still
// exists; packing then strips `.git` from what actually lands in
// node_modules (verified empirically: a real `npm install -g
// github:inactdev/fabrica` leaves no `.git` and no `gitHead` in the
// installed package.json at all - npm records neither for a global git
// install). This writes the one fact `fabrica doctor` needs after that
// strip happens: the exact commit this copy was built from. Plain JS,
// no dependencies: `prepare` must not fail an install over a file this
// unimportant, and nothing here needs TypeScript.
//
// Also runs on a bare `npm install` in this checkout itself (same npm
// behavior, no args) - harmless; build-info.json is gitignored, and
// doctor ignores it whenever a real `.git` is present (a dev checkout
// always has one), so it's only ever read for a true installed copy.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function commitOrNull() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

writeFileSync(join(root, "build-info.json"), JSON.stringify({ commit: commitOrNull() }) + "\n");
