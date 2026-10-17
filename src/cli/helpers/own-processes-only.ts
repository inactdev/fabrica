// The developer's own live view may already be running on the machine
// these tests run on, and findLiveViewProcess's command-line scan would
// find it. This hides every live view process that existed before the
// tests started, so only the ones a test spawns itself are visible.

import { LIVE_VIEW_COMMAND_MARKER, listProcesses } from "../live-view-process.ts";

const preexisting = new Set(
  listProcesses()
    .filter((p) => p.args.includes(LIVE_VIEW_COMMAND_MARKER))
    .map((p) => p.pid),
);

export const ownProcessesOnly = {
  listProcesses: () => listProcesses().filter((p) => !preexisting.has(p.pid)),
};
