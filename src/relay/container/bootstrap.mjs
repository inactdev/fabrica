#!/usr/bin/env node
// What launch.ts actually runs as the relay container's command. A
// fresh `node` process (the relay's own small container, not this
// project's worker image) has no TypeScript support - it needs the same
// teaching src/cli/bin.mjs and src/cli/tsx-bootstrap.mjs already give
// the `fabrica` CLI itself: `import "tsx/esm"` resolved against *this
// file's own location* via normal ESM resolution, never `node --import
// tsx/esm` (which resolves that bare specifier against the process's
// *cwd* instead - verified against the real runtime by bin.mjs's own
// comment, and would break the instant this container's cwd isn't set
// to exactly the right place).
//
// No "?"-in-path guard here unlike those two files: by the time this
// runs, the `fabrica` process that launched the relay container has
// already started successfully from this exact checkout, which means
// bin.mjs's own identical guard already passed for this same path.

await import("tsx/esm");
await import(new URL("./entrypoint.ts", import.meta.url).href);
