// Fabrica's single public entry point (issue #45). contract/*.test.ts, and
// the CLI (src/cli/, issue #47), import the real implementation from here
// rather than reaching into src/foreman or any other internal module
// directly — so internal restructuring never touches the ratified
// contract tests' imports.

export { createForeman } from "./foreman/index.ts";
export type { ForemanOptions } from "./foreman/index.ts";
export type { Foreman } from "../contract/surface.ts";
export { ForemanError } from "./foreman/index.ts";
export type { ForemanErrorCode } from "./foreman/index.ts";
export { DEFAULT_ATTEMPTS } from "./foreman/index.ts";
export { DEFAULT_CHECK_COMMAND } from "./foreman/index.ts";
export { fixRoundOf } from "./foreman/index.ts";
export { DEFAULT_HEARTBEAT_INTERVAL_MS } from "./foreman/index.ts";
export { readTranscript, eventsByTask, stateOf } from "./foreman/index.ts";
export { followTask } from "./foreman/index.ts";
export type { TaskFollower, TaskProgress } from "./foreman/index.ts";
export type { TranscriptEntry } from "../contract/surface.ts";
export type { FabricaTask, FabricaEvent, FabricaEventName } from "../contract/surface.ts";
export { validateDelivery, diffFiles, DeliveryError } from "./delivery/index.ts";
export type { DeliveryErrorCode } from "./delivery/index.ts";

// The brain socket: a CLI never picks an adapter by name (CONTRACT rule
// 8) - it asks for whichever one v1 wires in by default.
export { defaultBrainAdapter } from "./brain/index.ts";
export type { Brain } from "../contract/surface.ts";

// Config: the record home's project registry and caps (SPEC.md
// "Config"), needed by the CLI to resolve `--project <path-or-name>`
// before it ever calls createForeman.
export { loadConfig, projectsTomlPath, requireProject } from "./config/index.ts";
export { ConfigError } from "./config/index.ts";
export type { ConfigErrorCode, Caps, ProjectConfig, FabricaConfig, CheckedProjectConfig } from "./config/index.ts";

// Off-the-books nets (issue #13), prevention half: recordBlockedEditAttempt
// is what a harness-specific hook script under skill/<harness>/hooks/
// imports from here, the same way the CLI imports everything else it
// needs — never straight from src/offbooks/. (Issue #13 also specified a
// detection half; it was built, tested, then cut by Client ruling — see
// AGENTS.md.)
export { recordBlockedEditAttempt } from "./offbooks/index.ts";
export type { BlockedEditAttempt } from "./offbooks/index.ts";

// The record's read side: `fabrica verify-hook` (src/cli/) reads back the
// events an attempt should have produced, to prove it rather than assume it.
// (`eventsByTask` above is grouped by task; this is the flat, whole-record
// list `readEvents(...).length`/`.slice(...)` needs - a different shape,
// not a duplicate. `FabricaEvent` itself is already exported above.)
export { readEvents } from "./record/index.ts";
