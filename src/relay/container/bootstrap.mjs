#!/usr/bin/env node
// What launch.ts actually runs as the relay container's command: a
// stock Node image's `node`, with the Fabrica checkout bind-mounted
// read-only. Everything this loads (entrypoint.mjs, ../server.mjs,
// ../allowlist.mjs, ../errors.mjs) is plain JavaScript importing only
// `node:` built-ins, so nothing from node_modules is needed - no tsx,
// and no dependence on whether the mounted checkout even has
// node_modules installed. runtime-imports.test.ts holds that line.

await import("./entrypoint.mjs");
