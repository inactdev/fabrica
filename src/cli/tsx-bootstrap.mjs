#!/usr/bin/env node
// What spawn-detached.ts actually runs as the detached child's command.
// A fresh `node` process has no TypeScript support and no memory of
// whatever registered it in the parent - it has to be taught again, in
// that new process, exactly the way bin.mjs teaches the one running
// `fabrica` itself: `import "tsx/esm"` resolved against *this file's
// own location*, never `node --import tsx/esm` (CWD-relative - see
// bin.mjs's comment for the real-runtime failure that rules it out).
// Generic on purpose: bin.mjs only ever loads main.ts, but the detached
// child loads whichever entry script the caller names (the real
// run-task-entry.ts, or a fixture entry in tests - see
// spawn-detached.ts).
//
// Usage: node tsx-bootstrap.mjs <entryScript> [...args]
// Loads <entryScript> with process.argv rewritten so it sees exactly
// [node, entryScript, ...args] - the same shape it would see running
// directly, so it never has to know a bootstrap sat in front of it.

import { pathToFileURL } from "node:url";

await import("tsx/esm");

const [, , entry, ...args] = process.argv;
process.argv = [process.argv[0], entry, ...args];
// entry is a raw filesystem path (spawn-detached.ts builds it with
// fileURLToPath, decoding it) - import() parses a bare specifier as a
// URL, so a checkout whose path contains a literal "#" or "?" would
// truncate there and every `fabrica do` would fail to start.
await import(pathToFileURL(entry).href);
