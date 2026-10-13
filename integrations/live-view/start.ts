// `npm run live`'s entry point. A new top-level `fabrica live` command was
// considered and rejected: every existing command is a short-lived
// request/response call (or `do`'s own detached-background one) wired
// through src/cli/main.ts and individually classified in
// skill/claude-code/settings.json's Bash allow/deny list, with its own
// pair of tests enumerating every command by name. This is a long-lived
// foreground HTTP server - a different shape of thing than anything else
// `fabrica` runs - and forcing it through that machinery (a new args/help
// module, a new settings.json classification, two more tests to update)
// would be a bigger change than this read-only viewer itself. An npm
// script matches how this repo already starts its other tooling
// (`npm test`, `npm run typecheck`) and keeps issue #26 entirely inside
// this directory.

import { homedir } from "node:os";
import { join } from "node:path";
import { startLiveView } from "./server.ts";

const recordHome = process.env.FABRICA_HOME?.trim() || join(homedir(), ".fabrica");

const view = await startLiveView({ recordHome });
console.log(`fabrica live: watching ${recordHome} at http://127.0.0.1:${view.port} (read-only, loopback only)`);
