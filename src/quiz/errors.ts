// QuizError: every rejection this module produces carries a `code` for
// callers that need to branch on it, and a `message` written to be shown
// to the Client verbatim.

export type QuizErrorCode = "no-such-question" | "retired-question";

export class QuizError extends Error {
  readonly code: QuizErrorCode;

  constructor(code: QuizErrorCode, message: string) {
    super(message);
    this.name = "QuizError";
    this.code = code;
  }
}
