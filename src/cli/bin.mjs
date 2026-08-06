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

await import("tsx/esm");
const { main } = await import(new URL("./main.ts", import.meta.url).href);

process.exitCode = await main(process.argv.slice(2));
