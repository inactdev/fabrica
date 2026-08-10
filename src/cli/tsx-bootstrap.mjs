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

const [, , entry, ...args] = process.argv;

// entry is a raw filesystem path (spawn-detached.ts builds it with
// fileURLToPath, decoding it) - import() parses a bare specifier as a
// URL, so a checkout whose path contains a literal "#" or "?" would
// truncate there and every `fabrica do` would fail to start. pathToFileURL
// below fixes that for both characters - but tsx's own TypeScript
// transform has a separate bug that only "#" survives (see README.md's
// "Why a checkout path can never contain a literal '?'"), so a "?" is
// refused here with a clear message instead of hitting tsx's confusing
// one.
if (entry !== undefined && entry.includes("?")) {
  console.error(
    `fabrica: this checkout's path contains a "?" (${entry}), which the ` +
      `TypeScript loader fabrica runs on (tsx) cannot handle - it derives a ` +
      `broken internal path from any "?" and refuses real TypeScript syntax ` +
      `there. This is a bug in tsx, not fabrica (see README.md), and cannot ` +
      `be worked around here. Move or rename this checkout so its path has ` +
      `no "?" in it, then try again.`
  );
  process.exit(1);
}

await import("tsx/esm");

process.argv = [process.argv[0], entry, ...args];
await import(pathToFileURL(entry).href);
