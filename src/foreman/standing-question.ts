// CONTRACT rule 11 (Client ruling 2026-10-10): every brief Fabrica hands a
// worker begins with this question, put there by Fabrica's own code -
// never left to a file the model might or might not read.

export const STANDING_QUESTION =
  "Before you change anything: if your planned solution works, is it the best one, all things considered - " +
  "safest first, then most accurate, then fastest? Name one alternative you rejected and why. Write this down " +
  "before you start.";

/** `brief`, beginning with the standing question exactly once - applied
 * by every brief builder and again where the brief is handed over, so a
 * builder nested inside another never doubles it. */
export function withStandingQuestion(brief: string): string {
  return brief.startsWith(STANDING_QUESTION) ? brief : `${STANDING_QUESTION}\n\n${brief}`;
}
