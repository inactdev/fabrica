export {
  commandIsInstalled,
  declaresTestPaths,
  defaultInspector,
  inspectorAdapter,
  inspectorConfigMatches,
  inspectorIsConfigured,
  resolveCommandPath,
  INSPECTOR_CONFIG,
  MAX_INSPECTION_REPORT_BYTES,
  reportForRecord,
} from "./run.ts";
export type { InspectorAdapterOptions } from "./run.ts";
export type { Inspection, Inspector } from "./types.ts";
// `fabrica doctor`'s Inspector lines, plus the installed-versus-main
// classifier `fabrica update`'s Inspector step branches on too, so the
// line that reports a stale binary and the command that replaces it can
// never disagree about what "behind" means.
export {
  inspectorBranchStatus,
  inspectorInstallArgs,
  inspectorInstallCommand,
  inspectorVersionCheck,
  INSPECTOR_MODULE_PATH,
  INSPECTOR_PACKAGE_PATH,
  INSPECTOR_REPO_URL,
} from "./doctor-checks.ts";
export type { InspectorBuild, InspectorVersionState } from "./doctor-checks.ts";
// Issue #306: a project's `.inspector.json` and committed
// `Dockerfile.inspector` measured against what the installed Inspector
// refuses, so a round is never spent on a configuration already known to
// be turned away. One answer, two readers - the round's own gate
// (src/foreman/inspector-config.ts) and `fabrica doctor`'s per-project
// line.
export {
  inspectorConfigProblem,
  inspectorConfigProblemIn,
  readInspectorConfigFacts,
  INSPECTOR_DOCKERFILE,
} from "./config-check.ts";
export type { DockerfileState, InspectorConfigFacts, InspectorConfigProblem, InspectorConfigRefusal } from "./config-check.ts";
export { commitAncestry } from "./ancestry.ts";
export type { CommitAncestry } from "./ancestry.ts";
export { goInstallInspector, realInspectorVersionProbes } from "./version.ts";
export type { InspectorVersionProbes } from "./version.ts";
