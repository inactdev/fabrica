export { registerProject, commitMessageFor, pullRequestBodyFor, registerWarnings } from "./register.ts";
export type { DockerfileOutcome, RegisterRequest, RegisterResult, RegisterOptions } from "./register.ts";
export { RegisterError, RegisterProposalError } from "./errors.ts";
export type { RegisterErrorCode } from "./errors.ts";
export { deriveProposal, proposeInspectorConfig, readProposalSignals } from "./propose.ts";
export type {
  CheckField,
  CheckSource,
  DependencyField,
  ImageField,
  InspectorProposal,
  ProposalDerivation,
  ProposalSignals,
  ProtectedPathsField,
} from "./propose.ts";
export { resolveTermsFolder, writeTerms } from "./terms.ts";
export type { TermsFile, TermsFileOutcome, TermsResult } from "./terms.ts";
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
export {
  DEPS_DIR,
  DOCKERFILE_INSPECTOR,
  SERVICE_WAIT_SECONDS,
  dependencyInstallerIn,
  dependencyShapeFrom,
  dependencyShapeInTree,
  gemsIn,
  inspectorDockerfile,
  knownNonRootUser,
  rubyShape,
} from "./dockerfile.ts";
export type { BoxService, DependencyShape, ShapeStep } from "./dockerfile.ts";
export { appendProjectEntry, existingRegistration, isUsableProjectName } from "./registry-write.ts";
export { pullRequestUrlIn, realRegisterTools } from "./tools.ts";
export type { PrerequisiteResult, PullRequestResult, RegisterTools } from "./tools.ts";
