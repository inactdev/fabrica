#!/usr/bin/env node
// The executable `package.json`'s `bin` entry points at, so `fabrica`
// resolves and runs from any directory once installed (issue #47).
//
// Plain JavaScript, not TypeScript: this is the first thing that runs,
// before anything has taught Node how to load a .ts file, so it can't
// be one itself. `import "tsx/esm"` (a real import, resolved against
// *this file's own location* via normal ESM resolution) registers that
// support, then main.ts loads normally. Deliberately not `node
// --import tsx/esm`: that flag resolves the bare specifier "tsx/esm"
// relative to the *process's cwd*, not this file - verified against the
// real runtime, and it breaks the moment `fabrica` runs from any
// directory that isn't this package's own tree (which is every
// directory it's meant to run from once installed). See the module
// README's "Why bin.mjs isn't a shebang'd .ts file" for the failure
// this sidesteps.
//
// The "?" check below has to come before that import, for the same
// reason this whole file is plain JavaScript: main.ts (real TypeScript
// syntax) cannot even be loaded once this checkout's path contains a
// literal "?" - see README.md's "Why a checkout path can never contain
// a literal '?'" for the tsx bug this refuses instead of hitting.

import { fileURLToPath } from "node:url";

const selfPath = fileURLToPath(import.meta.url);
if (selfPath.includes("?")) {
  console.error(
    `fabrica: this checkout's path contains a "?" (${selfPath}), which the ` +
      `TypeScript loader fabrica runs on (tsx) cannot handle - it derives a ` +
      `broken internal path from any "?" and refuses real TypeScript syntax ` +
      `there. This is a bug in tsx, not fabrica (see README.md), and cannot ` +
      `be worked around here. Move or rename this checkout so its path has ` +
      `no "?" in it, then try again.`
  );
  process.exit(1);
}

await import("tsx/esm");
const { main } = await import(new URL("./main.ts", import.meta.url).href);

process.exitCode = await main(process.argv.slice(2));
