// Why a rules file could not be used. Every message is written to be
// shown to the Client verbatim: he is the one who edits the file, and a
// refusal he cannot act on is the same as no refusal at all.

export type SkipRuleErrorCode =
  /** The file is not valid TOML, or says something the fixed vocabulary
   * has no question for (an unknown condition, a missing version, a
   * number where a list belongs). */
  | "malformed"
  /** `mode = "live"` - the only mode built is "shadow" (issue #204's
   * 2026-10-25 amendment). Named separately from "malformed" because it
   * is not a mistake: it is a thing the Client may well mean, that
   * CONTRACT rule 6 does not yet permit. */
  | "live-not-allowed";

export class SkipRuleError extends Error {
  readonly code: SkipRuleErrorCode;

  constructor(code: SkipRuleErrorCode, message: string) {
    super(message);
    this.name = "SkipRuleError";
    this.code = code;
  }
}
