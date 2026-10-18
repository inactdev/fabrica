#!/usr/bin/env node
// What ../openai-compatible.ts runs inside the worker's box: the box's
// own stock `node`, pointed at this file. Everything it loads
// (main.mjs, loop.mjs, tools.mjs, client.mjs) is plain JavaScript
// importing only `node:` built-ins and its siblings, so nothing from
// node_modules is needed - no tsx, and no dependence on whether the
// mounted copy has node_modules at all. runtime-imports.test.ts holds
// that line, the same way src/relay/container/ holds it for the relay.

await import("./main.mjs");
