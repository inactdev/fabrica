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
  githubTokenStatus,
  inspectorBranchStatus,
  inspectorInstallArgs,
  inspectorInstallCommand,
  inspectorVersionCheck,
  INSPECTOR_MODULE_PATH,
  INSPECTOR_PACKAGE_PATH,
  INSPECTOR_REPO_URL,
} from "./doctor-checks.ts";
export type { InspectorBuild, InspectorVersionState } from "./doctor-checks.ts";
export { commitAncestry } from "./ancestry.ts";
export type { CommitAncestry } from "./ancestry.ts";
export { goInstallInspector, realInspectorVersionProbes } from "./version.ts";
export type { InspectorVersionProbes } from "./version.ts";
