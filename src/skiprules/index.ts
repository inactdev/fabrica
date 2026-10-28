// Skip rules (issue #204), shadow mode only. Everything outside this
// module reaches it through src/index.ts, never a file path in here -
// same rule as every other module.

export { SkipRuleError } from "./errors.ts";
export type { SkipRuleErrorCode } from "./errors.ts";
export { isDependencyManifest, isTestFile, isUnderFolder, CONDITION_KEYS } from "./conditions.ts";
export { loadSkipRules, parseSkipRules, SKIP_RULES_PATH } from "./load.ts";
export { changeCounts, changeFingerprint } from "./git.ts";
export { factsFromRecord } from "./facts.ts";
export { closingKind, evaluateKind, evaluateRules } from "./evaluate.ts";
export { evaluateInShadow } from "./shadow.ts";
export type { ShadowEvaluationRequest } from "./shadow.ts";
export { formatShadowReport, shadowCountsLine, shadowReport } from "./report.ts";
export type { EventsByTask, ShadowReport, ShadowRow } from "./report.ts";
export type {
  ChangeCounts,
  ChangeFacts,
  ChangeKind,
  ConditionAnswer,
  ConditionKey,
  KindEvaluation,
  SkipRuleMode,
  SkipRules,
  WouldCloseByRuleDetails,
} from "./types.ts";
