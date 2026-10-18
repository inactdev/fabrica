// @ts-check
// The two limits the relay enforces on a worker box's own traffic
// (issue #186, second half): how large one request may be, and how many
// calls one task may make. Both are refusals of a single request - never
// a reason to stop a task, which rule 10's spending cap alone decides
// (Client ruling, issue #186).
//
// Their defaults live here, in plain JavaScript importing nothing,
// because both sides need them: `server.mjs` (which the relay container
// runs with a stock `node`, nothing from node_modules - see
// container/bootstrap.mjs) and this module's TypeScript, which reports
// them to the Client and lets a project override them in projects.toml.

/** 10 MB. Large enough for any model call a Worker legitimately makes
 * (a long prompt with file contents in it) and far below what an
 * accidental upload of a build artifact or a whole repository would be.
 * Overridable per project: projects.toml's `maxRequestBytes`. */
export const DEFAULT_MAX_REQUEST_BYTES = 10 * 1024 * 1024;

/** 2000 calls per task, counting both shapes of traffic (one gateway
 * request, or one CONNECT tunnel, is one call). Overridable per
 * project: projects.toml's `maxCallsPerTask`. */
export const DEFAULT_MAX_CALLS_PER_TASK = 2000;

/** The value a `"network-refused"` event's `details.limit` carries, so a
 * reader can tell the two limits apart from each other and from an
 * ordinary refused host (which carries no `limit` at all).
 * @typedef {"request-size" | "calls-per-task"} RefusedLimit */
