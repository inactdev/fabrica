export { registerProject, commitMessageFor, pullRequestBodyFor } from "./register.ts";
export type { RegisterRequest, RegisterResult, RegisterOptions } from "./register.ts";
export { RegisterError, RegisterProposalError } from "./errors.ts";
export type { RegisterErrorCode } from "./errors.ts";
export { proposeInspectorConfig, readProposalSignals } from "./propose.ts";
export type { InspectorProposal, ProposalSignals } from "./propose.ts";
export {
  CHECK_SCRIPT,
  INSPECTOR_CONFIG,
  RECORDED_CHECK,
  REGISTER_BRANCH,
  hostFromOriginUrl,
  inspectorConfiguredOnOrigin,
  notSetUpMessage,
  originSetup,
  originUrl,
  ownerRepoFromOriginUrl,
  repoNameFromOriginUrl,
} from "./origin.ts";
export type { OriginSetup } from "./origin.ts";
export { checkScript, inspectorConfigJson, protectedPathsFor } from "./scaffold.ts";
export { appendProjectEntry, existingRegistration, isUsableProjectName } from "./registry-write.ts";
export { pullRequestUrlIn, realRegisterTools } from "./tools.ts";
export type { PrerequisiteResult, PullRequestResult, RegisterTools } from "./tools.ts";
