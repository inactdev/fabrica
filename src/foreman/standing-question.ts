// CONTRACT rule 11 (Client ruling 2026-10-10): every brief Fabrica hands a
// worker begins with this question, put there by Fabrica's own code -
// never left to a file the model might or might not read.

export const STANDING_QUESTION =
  "Before you change anything: if your planned solution works, is it the best one, all things considered - " +
  "safest first, then most accurate, then fastest? Name one alternative you rejected and why. Write this down " +
  "before you start. You cannot and need not commit - leave your changes in the working tree; Fabrica commits " +
  "them. When your change calls an outside tool or service, read its current documentation before writing the " +
  "call; never guess a command or API shape. If you cannot reach the documentation from here, stop and ask " +
  "instead of guessing.";

/** Pull requests must read like a human wrote them: a worker returns its
 * write-up as a structured answer (BrainWorkResult.writeup) - title, why,
 * what, how, outsideChanges, confidence, assumptions, expectedOutcomes,
 * deviations, quiz, and the one optional couldNotVerify - which Fabrica uses as
 * the commit message and, when Inspector is configured, the pull request
 * title and body, laid out as the Client's own template (ruling
 * 2026-10-18): why/what/how/outsideChanges verbatim under "## Context
 * (Why)" / "## Description (What)" / "## Changes in the codebase (How)" /
 * "## Changes outside the codebase", then the rest as labelled bullets
 * under "## Additional information" (`src/foreman/pr-body.ts`). It is
 * never parsed out of the worker's prose and never falls back to the
 * task's own words. A missing or invalid write-up makes the attempt red,
 * named back to the worker on the next attempt (see attempts.ts), so this
 * is stated as a requirement, not a suggestion. The notice also says what
 * each section is *for*, because a reviewer who did not run the task is
 * the reader: a worker that describes its own box under "How" is the one
 * failure this wording exists to prevent.
 *
 * The quiz (issue #98) is the one field whose reader is not this pull
 * request's reviewer: it is for the owner of the codebase, who did not
 * read the diff, and is shown to him on the live view's review page and
 * kept on its own /quiz page afterwards - never in the pull request
 * body. "Exactly three" is stated as the hard requirement it is, since a
 * fourth question, or a missing one, makes the whole write-up invalid. */
export const FINAL_MESSAGE_FORMAT_NOTICE =
  "When you finish, give your write-up as the structured answer you are asked for. Fabrica uses it verbatim as " +
  "the commit message and (when a pull request is opened) its title and body, so write every field for a " +
  "reviewer who did not run this task and cannot see your surroundings - plain words, no mention of your box, " +
  "your tools or your own run anywhere except couldNotVerify and assumptions. The fields: title (your own " +
  "words, in the imperative, at most 60 characters, summarizing the change - never the task text itself); why " +
  "(what this change is for, from the product side - the pull request's Context section, and what a reviewer " +
  "reads first); what (the steps you took to accomplish the task - the Description section); how (the " +
  "engineering side: what you added, modified or refactored - the Changes in the codebase section); " +
  "outsideChanges (anything this change needs beyond this repository - settings, infrastructure, an external " +
  'service, the machine it runs on - or "None." if there is nothing); confidence (a number from 0 to 100, how ' +
  "sure you are in this result); assumptions (every judgment call you made where the brief was silent); " +
  "expectedOutcomes (what should be true once this change lands, so it can be checked); deviations (what you " +
  'deviated from the request and why, or "None." if nothing); quiz (exactly three questions about what this ' +
  "change did and why, each with its own one-line answer, written for the owner of the codebase who did not " +
  "read the diff - he reads these on his own review page, not in the pull request, so ask what he would " +
  "actually want to know and answer it plainly); and, optionally, couldNotVerify (anything you " +
  "could not check from where you are - a service you could not reach, a test you could not run; leave it out " +
  "entirely if there is nothing). Every field except couldNotVerify is required and must not be empty, and the " +
  "quiz must hold exactly three questions - not two, not four. Do not " +
  "type the write-up out as text; an attempt without a valid structured write-up is not accepted as done.";

/** A bug is rarely a one-off: the same shape - the same missing guard,
 * the same mis-ordered pair of calls, the same copy-pasted branch - is
 * usually sitting in two or three other places nobody has tripped over
 * yet, and a worker fixing one of them is the cheapest moment anyone
 * will ever have to find the rest (issue #147). Stated here rather than
 * left to the project's own agent-memory file for the same reason the
 * standing question is: Fabrica's own code puts it in front of every
 * worker, instead of hoping the file gets read. It asks for the list in
 * the write-up because that is the one channel a worker has to the
 * reviewer - so a twin left alone is a known, reviewable decision
 * rather than an omission nobody sees. */
export const SAME_SHAPE_NOTICE =
  "When you fix something, look for every other place in the code with the same shape and list them in your " +
  "write-up - whether or not you also fixed them, so the ones left standing are known rather than missed.";

/** A project-intrinsic fact a worker discovers (build/test/release/
 * architecture, a sharp edge) belongs in the project's root agent-memory
 * file, but not as a bullet appended straight into its shared body: two
 * tasks running in parallel branches (the common case here) both insert
 * text at that same spot, and their pull requests collide on merge every
 * time. `notes/` is the merge-safe alternative - one new file per task,
 * which can never collide with another new file - folded into the
 * curated document by hand later. See `notes/README.md` for the naming
 * convention. */
export const DURABLE_NOTES_NOTICE =
  "If you find a durable, project-intrinsic fact worth keeping, add it as a new file under notes/ (one file per " +
  "task - see notes/README.md for the naming convention) instead of editing the project's root agent-memory " +
  "file's shared body directly - that is what causes parallel tasks' pull requests to conflict on the same " +
  "spot, every time.";

/** The Client's standing ruling on how a worker spends its own time
 * (issue #142): the project's check runs in full after the worker is
 * done, by Inspector or in the worker's own box, so a worker re-running
 * the whole suite itself buys nothing and costs minutes on every
 * attempt. Carried by each project's own settings
 * (`projects.toml`'s `onlyTouchedTests`, on unless the project turns it
 * off) rather than retyped into every task - which is the whole point
 * of the issue - and resolved per round by
 * src/foreman/touched-tests.ts, which is also where a single task's
 * "run the full suite" opt-out lives. Unlike the four notices above it
 * is therefore conditional, which is why it is not part of
 * STANDING_PREFIX. The second sentence is the safety valve: narrower
 * test runs must not turn into silent risk, so an untested consequence
 * is something the reviewer hears about. */
export const ONLY_TOUCHED_TESTS_NOTICE =
  "While you work, run only the tests that cover what you touched, not the project's whole suite - the " +
  "project's own check runs in full after you finish, so running everything yourself costs time and proves " +
  "nothing that check will not. If your change could break something the tests you ran do not cover, say so " +
  "in your write-up.";

const STANDING_PREFIX = [
  STANDING_QUESTION,
  FINAL_MESSAGE_FORMAT_NOTICE,
  SAME_SHAPE_NOTICE,
  DURABLE_NOTES_NOTICE,
].join("\n\n");

/** `brief`, beginning with the standing question, the write-up notice,
 * the same-shape notice and the durable-notes notice exactly once -
 * applied by every brief builder and again where the brief is handed
 * over, so a builder nested inside another never doubles it.
 *
 * `onlyTouchedTests` adds ONLY_TOUCHED_TESTS_NOTICE after those four.
 * The doubling guard deliberately keys on STANDING_PREFIX alone, which
 * the conditional notice sits *after*: a brief an outer builder already
 * prefixed comes back untouched whatever this call asks for, so a
 * nested re-application can neither double the prefix nor quietly drop
 * a notice the outer builder resolved. Resolving it is
 * src/foreman/touched-tests.ts's job, in one place per round. */
export function withStandingQuestion(brief: string, opts: { onlyTouchedTests?: boolean } = {}): string {
  if (brief.startsWith(STANDING_PREFIX)) return brief;
  const prefix = opts.onlyTouchedTests ? `${STANDING_PREFIX}\n\n${ONLY_TOUCHED_TESTS_NOTICE}` : STANDING_PREFIX;
  return `${prefix}\n\n${brief}`;
}
