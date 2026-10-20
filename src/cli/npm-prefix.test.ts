// npm's global layout, derived both ways (issue #171 / "make the
// installed copy updatable from wherever it lives"). Every case here is
// a pure path derivation - the paths are npm's documented ones, checked
// against real installs when this was written, and nothing in this file
// touches a filesystem.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GLOBAL_PACKAGE_NAME,
  globalPackagePath,
  installCommandArgs,
  normalizedPrefix,
  prefixOfGlobalBin,
  prefixOfGlobalInstall,
} from "./npm-prefix.ts";

test("GLOBAL_PACKAGE_NAME is this package's own name - every path built here is wrong otherwise", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { name } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string };
  assert.equal(GLOBAL_PACKAGE_NAME, name);
});

test("prefixOfGlobalInstall: a global install names the prefix it was installed under", () => {
  assert.equal(prefixOfGlobalInstall("/usr/local/lib/node_modules/fabrica"), "/usr/local");
  assert.equal(prefixOfGlobalInstall("/home/me/.npm-global/lib/node_modules/fabrica"), "/home/me/.npm-global");
  // A Nix-managed host's own read-only default, the case this exists for.
  assert.equal(
    prefixOfGlobalInstall("/nix/store/abc123-nodejs-24.18.0/lib/node_modules/fabrica"),
    "/nix/store/abc123-nodejs-24.18.0"
  );
  // Trailing separators and redundant segments normalize away rather
  // than failing the match.
  assert.equal(prefixOfGlobalInstall("/usr/local/lib/node_modules/fabrica/"), "/usr/local");
  assert.equal(prefixOfGlobalInstall("/usr/local/lib/node_modules/./fabrica"), "/usr/local");
});

test("prefixOfGlobalInstall: anything that is not a global install is null, never a guess", () => {
  // npx extracts into its own cache - no `lib` level, so no prefix to
  // reinstall into. This is the case `fabrica update` refuses.
  assert.equal(prefixOfGlobalInstall("/home/me/.npm/_npx/0a1b2c3d/node_modules/fabrica"), null);
  assert.equal(prefixOfGlobalInstall("/home/me/project/node_modules/fabrica"), null);
  assert.equal(prefixOfGlobalInstall("/home/me/src/fabrica"), null);
  assert.equal(prefixOfGlobalInstall("lib/node_modules/fabrica"), null);
  assert.equal(prefixOfGlobalInstall(""), null);
  assert.equal(prefixOfGlobalInstall(undefined), null);
});

test("prefixOfGlobalBin: the executable npm puts on PATH names the prefix it came from", () => {
  assert.equal(prefixOfGlobalBin("/usr/local/bin/fabrica"), "/usr/local");
  assert.equal(prefixOfGlobalBin("/home/me/.npm-global/bin/fabrica"), "/home/me/.npm-global");
});

test("prefixOfGlobalBin: a path that is not <prefix>/bin/<exe> is null", () => {
  // Run straight out of a checkout (no npm prefix in sight), or under a
  // test runner.
  assert.equal(prefixOfGlobalBin("/home/me/src/fabrica/src/cli/bin.mjs"), null);
  assert.equal(prefixOfGlobalBin("/usr/local/lib/node_modules/fabrica/src/cli/bin.mjs"), null);
  assert.equal(prefixOfGlobalBin(undefined), null);
});

test("globalPackagePath: npm's documented global package location, and the exact reverse of prefixOfGlobalInstall", () => {
  assert.equal(globalPackagePath("/usr/local"), "/usr/local/lib/node_modules/fabrica");
  for (const prefix of ["/usr/local", "/home/me/.npm-global", "/opt/npm"]) {
    assert.equal(prefixOfGlobalInstall(globalPackagePath(prefix)), prefix);
  }
});

test("installCommandArgs: carries --prefix when the prefix is known, and is README.md's own command when it isn't", () => {
  assert.deepEqual(installCommandArgs("/home/me/.npm-global"), [
    "install",
    "-g",
    "--prefix",
    "/home/me/.npm-global",
    "github:inactdev/fabrica",
  ]);
  assert.deepEqual(installCommandArgs(null), ["install", "-g", "github:inactdev/fabrica"]);

  // The documented install command, verbatim - the one thing a Client
  // is told to type (README.md's "Installing the command").
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.ok(
    readme.includes(`npm ${installCommandArgs(null).join(" ")}`),
    "README.md must name the same install command this builds"
  );
});

test("normalizedPrefix: an absolute path with no trailing separator, or null for anything unusable", () => {
  assert.equal(normalizedPrefix("/usr/local/"), "/usr/local");
  assert.equal(normalizedPrefix("  /usr/local  "), "/usr/local");
  assert.equal(normalizedPrefix("/usr/local/lib/.."), "/usr/local");
  assert.equal(normalizedPrefix("/"), "/");
  assert.equal(normalizedPrefix("usr/local"), null);
  assert.equal(normalizedPrefix(""), null);
  assert.equal(normalizedPrefix(null), null);
  assert.equal(normalizedPrefix(undefined), null);
});
