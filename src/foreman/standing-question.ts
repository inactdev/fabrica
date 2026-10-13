// CONTRACT rule 11 (Client ruling 2026-10-10): every brief Fabrica hands a
// worker begins with this question, put there by Fabrica's own code -
// never left to a file the model might or might not read.

export const STANDING_QUESTION =
  "Before you change anything: if your planned solution works, is it the best one, all things considered - " +
  "safest first, then most accurate, then fastest? Name one alternative you rejected and why. Write this down " +
  "before you start. You cannot and need not commit - leave your changes in the working tree; Fabrica commits " +
  "them.";

/** Pull requests must read like a human wrote them: Fabrica parses a
 * worker's own final message into the commit subject/body and, when
 * Inspector is configured, the pull request title/body too
 * (src/foreman/final-message.ts) - it never falls back to the task's own
 * words. A message missing the title line or any section is refused a
 * "done" outcome and named back to the worker on the next attempt (see
 * attempts.ts), so this is stated as a requirement, not a suggestion. */
export const FINAL_MESSAGE_FORMAT_NOTICE =
  "End your final message in this session with the write-up Fabrica will use, verbatim, as the commit message " +
  'and (when a pull request is opened) its title and body: first a title line of your own words, at most 60 ' +
  "characters, summarizing the change - never the task text itself - then a blank line, then four sections, " +
  'each starting on its own line with its name and a colon, in this order: "What:", "Why:", "How:", and ' +
  '"Deviations:" (what you deviated from the request and why, or "None." if nothing). A message missing the ' +
  "title or any section will not be accepted as done.";

const STANDING_PREFIX = `${STANDING_QUESTION}\n\n${FINAL_MESSAGE_FORMAT_NOTICE}`;

/** `brief`, beginning with the standing question and the final-message
 * format notice exactly once - applied by every brief builder and again
 * where the brief is handed over, so a builder nested inside another
 * never doubles it. */
export function withStandingQuestion(brief: string): string {
  return brief.startsWith(STANDING_PREFIX) ? brief : `${STANDING_PREFIX}\n\n${brief}`;
}
