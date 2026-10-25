// The shapes of a project's skip rules, the facts an evaluation answers
// them from, and the `would-close-by-rule` event's own details.
//
// None of these are in `contract/surface.ts`. Nothing here is a promise
// to the Client about a seam - in shadow mode nothing closes, nothing
// merges, and every task still reaches him exactly as before - so this is
// Fabrica's own bookkeeping, the same as a meter reading or an Inspector
// call. (The one name that does have to be widened, the event name
// itself, goes in `src/inspector/types.ts`, which is the documented
// single place that happens.)

/** The only mode built. `"live"` exists in the vocabulary so a rules file
 * can say it and be told, specifically, why it is refused - rather than
 * being told "unknown mode" and leaving the Client to guess that the
 * answer is CONTRACT rule 6. */
export type SkipRuleMode = "shadow" | "live";

/** Every condition key the vocabulary has. Fixed in code (issue #204: "the
 * vocabulary of questions is fixed in code; a line can only combine
 * them") - a rules file naming anything else is refused. */
export type ConditionKey =
  | "allowedFolders"
  | "maxFiles"
  | "maxLines"
  | "noTestFiles"
  | "noDependencyManifest"
  | "inspectorGreen"
  | "requiredGreenChecks"
  | "noQuestionsAsked"
  | "noCouldNotVerify";

/** One kind of change, as the rules file declares it. Every condition is
 * optional - a kind combines whichever of them it wants - but a kind
 * with no condition at all is refused by the loader: that would be a
 * line saying "close anything". */
export interface ChangeKind {
  name: string;
  /** The Client's own plain-English sentence for this kind, carried onto
   * the event so a report never has to paraphrase his words. */
  description: string;
  mode: SkipRuleMode;
  allowedFolders?: string[];
  maxFiles?: number;
  maxLines?: number;
  noTestFiles?: true;
  noDependencyManifest?: true;
  inspectorGreen?: true;
  requiredGreenChecks?: string[];
  noQuestionsAsked?: true;
  noCouldNotVerify?: true;
}

export interface SkipRules {
  /** The Client's own declared version number, from the file. */
  version: number;
  /** `<version>@<first 12 hex of the file's sha-256>` - what every
   * `would-close-by-rule` event records, so an answer can always be tied
   * back to the exact bytes that produced it and not merely to a number
   * someone forgot to bump. */
  rulesVersion: string;
  /** Repository-relative, as read: `.fabrica/skip-rules.toml`. */
  path: string;
  kinds: ChangeKind[];
}

/** Everything one evaluation has to answer from. Assembled once per
 * delivery (`facts.ts`) out of the task's own events plus two git reads;
 * nothing here is ever asked of a model. */
export interface ChangeFacts {
  /** The delivery's own `files` list - "what this branch touched", as
   * `src/delivery/diff-files.ts` already defines it once. */
  files: string[];
  /** `"done"`, `"inspection-red"`, ... - whatever the delivery reports.
   * Null when the task has no delivery on the record at all. */
  outcome: string | null;
  /** How many files and lines the change moved, from one `git diff
   * --shortstat`. Null when git could not be read, which answers every
   * count condition "unknown" rather than zero. */
  counts: ChangeCounts | null;
  /** Inspector's own verdict for this round, or null when Inspector was
   * never involved (a self-tested task) or reached nothing. */
  inspectorVerdict: "green" | "red" | "refused" | null;
  /** Every check the repository itself concluded on the pull request,
   * by name, and whether Fabrica read it as red. A check that never
   * concluded is deliberately absent rather than present-and-green. */
  concludedChecks: { name: string; red: boolean }[];
  /** Whether the task ever stopped to ask the Client a question. */
  questionsAsked: boolean;
  /** What the worker said it could not check from inside its own box -
   * empty when it reported nothing. */
  couldNotVerify: string;
}

export interface ChangeCounts {
  files: number;
  insertions: number;
  deletions: number;
}

/** One condition, the question it asks, and what the facts answered.
 * `"unknown"` is never safe: a question nothing could answer is the one
 * case where a rule must fail closed. */
export interface ConditionAnswer {
  condition: ConditionKey | "deliveryDone";
  question: string;
  answer: "safe" | "unsafe" | "unknown";
  /** What the facts actually were, in the Client's own reading order -
   * "3 files changed, limit 5", "touched: src/foo.test.ts". */
  detail: string;
  /** True for `deliveryDone`, the one question that is not from the
   * rules file at all: a code-fixed floor in front of every kind, so no
   * line can be written that would close a task whose delivery is not
   * even done. Marked on the record so a reader can tell the Client's
   * own conditions from Fabrica's. */
  fixed?: true;
}

export interface KindEvaluation {
  kind: string;
  description: string;
  mode: SkipRuleMode;
  /** True exactly when every answer below is `"safe"`. In shadow mode
   * this means "this line would have closed the task" and nothing more:
   * nothing closes, nothing merges. */
  safe: boolean;
  answers: ConditionAnswer[];
}

/** `"would-close-by-rule"`'s own details. Appended once per delivery for
 * a project that has a rules file, and never for one that does not. */
export interface WouldCloseByRuleDetails {
  /** Resolved project path, so a report can group by project without
   * re-reading the delivery. */
  project: string;
  /** Repository-relative path of the rules file that was read. */
  rulesPath: string;
  /** See `SkipRules.rulesVersion`. Null when nothing could be read. */
  rulesVersion: string | null;
  /** `git patch-id --stable` of the change, or null when it could not be
   * computed - the amendment's "the change's patch-id fingerprint", so a
   * later reader can tell whether two evaluations were about the same
   * change. */
  fingerprint: string | null;
  /** Always "shadow" today. Recorded rather than assumed so a record
   * written now still reads correctly once live mode exists. */
  mode: "shadow";
  /** True when at least one kind answered every condition safe. Never
   * acted on: see `shadow.ts`. */
  wouldClose: boolean;
  /** The first kind that would have closed it, for a report that wants
   * one name rather than a list. Null when none would. */
  closedByKind: string | null;
  kinds: KindEvaluation[];
  /** Set when nothing could be evaluated, carrying the refusal's own
   * message - a `mode = "live"` naming CONTRACT rule 6, a malformed
   * file, an unreadable git. Present instead of `kinds` having anything
   * in it, so a problem is never a silent empty evaluation. */
  problem?: string;
}
