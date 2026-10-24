#!/usr/bin/env node
// Runs as the "prepare" lifecycle script (package.json) and writes the
// one fact `fabrica doctor` needs about an installed copy: the exact
// commit it was built from. npm's own packing strips `.git` out of what
// lands in `node_modules`, and records no `gitHead` anywhere either
// (verified empirically against a real global install), so this file is
// the only record there is.
//
// Two sources, in this order, because neither one covers every way a
// copy gets built:
//
//   1. `.git` at the package root - the ordinary case: a developer
//      checkout running `npm install`, and the clone `fabrica update`
//      packs from. `git rev-parse HEAD`, exactly as before.
//   2. What npm itself tells the prepare step. npm packs a *hosted*
//      GitHub spec (`github:inactdev/fabrica`, and every `git+https`
//      spelling of it - npm resolves them all to the same codeload
//      tarball) from GitHub's tarball of the tree, which carries no
//      `.git` at all, so step 1 finds nothing there. When npm hands the
//      step a field naming the commit it resolved - a codeload URL
//      ending in the sha, a git URL with the sha as its fragment - that
//      is read instead.
//
// Neither works: a named failure goes into the file and onto stderr,
// never a silent `null`. The commit is written as the empty string,
// which `fabrica doctor` reports as "commit unknown" with the install
// that does record a commit as its fix (`doctor-command.ts`'s
// `checkoutCheck`). Recording the wrong commit would be worse than
// recording none, which is why nothing here falls back to asking the
// remote what master's tip is: the tree being packed may be older than
// that tip, or not on master at all.
//
// Plain JS, no dependencies: `prepare` must not fail an install over
// this file, and nothing here needs TypeScript. `src/cli/write-build-info.test.ts`
// drives this script itself, in scratch directories, for each source.

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A git object name: 40 hex digits (SHA-1) or 64 (SHA-256). */
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The commit a real checkout is on. `.git`'s presence decides whether
 * to ask at all - the same ground truth `detectCopy` uses to tell a
 * checkout from a packed copy - so a packed copy extracted *underneath*
 * some unrelated repository can never have that repository's HEAD
 * recorded as its own. */
function commitFromGit() {
  if (!existsSync(join(root, ".git"))) return null;
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return COMMIT.test(head) ? { commit: head, source: "git rev-parse HEAD" } : null;
  } catch {
    return null;
  }
}

/** The `npm_package_*` variables npm sets for a prepare step, most
 * likely to carry a resolved commit first and the rest after - sorted,
 * so which one answered is never down to environment ordering. */
function npmFieldNames(env) {
  const first = ["npm_package_resolved", "npm_package_gitHead", "npm_package_from"];
  const rest = Object.keys(env)
    .filter((name) => name.startsWith("npm_package_") && !first.includes(name))
    .sort();
  return [...first, ...rest];
}

/** A commit read out of what npm set, with the field it came from.
 * Matched as a whole hex run bounded by non-hex characters, so the sha
 * at the end of `https://codeload.github.com/<owner>/<repo>/tar.gz/<sha>`
 * and the fragment of `git+https://github.com/<owner>/<repo>.git#<sha>`
 * are both found, and a longer hex run is not mistaken for one. */
function commitFromNpmFields(env) {
  for (const name of npmFieldNames(env)) {
    const value = env[name];
    if (typeof value !== "string" || value === "") continue;
    const found = value.split(/[^0-9a-f]+/).find((part) => COMMIT.test(part));
    if (found !== undefined) return { commit: found, source: name };
  }
  return null;
}

const found = commitFromGit() ?? commitFromNpmFields(process.env);

// The recorded failure stays one sentence naming both sources, because
// `fabrica doctor` prints it inside its own line; what to do about it is
// doctor's to say, and goes only to stderr here.
const info = found ?? {
  commit: "",
  source: "none",
  error:
    `the commit could not be recorded when this copy was built: there is no .git at ${root}, ` +
    `and no field npm set for the prepare step named one`,
};

if (info.error) {
  console.error(
    `fabrica: ${info.error}. This copy will not know which commit it is - \`fabrica doctor\` reports it as ` +
      `"commit unknown" and names the install that does record one.`
  );
}

writeFileSync(join(root, "build-info.json"), JSON.stringify(info) + "\n");
