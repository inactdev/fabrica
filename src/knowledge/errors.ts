// KnowledgeError: every refusal this module produces carries a `code`
// for callers that need to branch on it, and a `message` written to be
// shown to the Client verbatim — it always names which note, or which
// folder, the problem is about.

export type KnowledgeErrorCode =
  /** The configured knowledge base isn't there, or has no `notes/`
   * folder to read notes out of. */
  | "no-knowledge-base"
  /** A named note has no file in that folder, or one nothing can read. */
  | "missing-note"
  /** A named note has no front-matter `title:`, so there is no heading
   * to put it under. */
  | "missing-note-title"
  /** The brief would be past `MAX_BRIEF_BYTES` with these notes in it.
   * Notes are never trimmed, so this refuses instead. */
  | "brief-too-large";

export class KnowledgeError extends Error {
  readonly code: KnowledgeErrorCode;

  constructor(code: KnowledgeErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeError";
    this.code = code;
  }
}
