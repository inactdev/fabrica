# The fixed ask shape and stable question ids (issues #176 + #175)

A machine's clarifying question is no longer free prose. It is exactly one
question with two to four options, Fabrica appends "other", and Fabrica
derives a stable id from the question's own text plus its options so the
first answer to that id wins for the rest of the task.

## Where the pieces live, and why there

- `src/brain/ask-shape.ts` is the shape itself: `AskQuestion`, the option
  bounds, `OTHER_OPTION`, `askShapeProblem` (the dispatch-time check),
  `deriveQuestionId` (the hash), `ASK_SHAPE_NOTICE` (the wording every
  adapter's own ask prompt carries) and `withAskRejection` (the re-ask
  brief). It sits in `src/brain/` for the same reason `src/brain/
  writeup.ts` does: both the Foreman (which checks what came back) and
  the adapters (which ask their brain for it in this exact shape) need
  one copy, and an adapter must never import from `src/foreman/`.
- `src/foreman/questions.ts` is the record-reading half: which questions
  this task has already been answered (`answeredQuestionsOf`, latest
  answer per id wins), plus `renderAnswerRound`/`deriveBrief`, which both
  `ask.ts` (auto-answering) and `answer.ts` (the Client answering) need -
  kept here rather than in `answer.ts` so `ask.ts` does not have to
  import the module that imports `do.ts`, which imports `ask.ts`.

## Decisions that are not obvious from the code

- **The id is a hash, never the machine's own string.** A machine cannot
  supply an id, so two different questions can never collide on one
  (Client ruling 2026-10-25, clarifying #175). The hash input is the
  question text plus its options, each NFKC-normalized, lowercased and
  whitespace-collapsed, with the options **sorted**: re-ordering the same
  choices is presentation, not a new question. `OTHER_OPTION` is never
  part of the input - Fabrica appends it to every question, so including
  it would only let a change in its own wording invalidate every id ever
  derived.
- **`contract/surface.ts` was deliberately not touched.** The ratified
  `BrainAskResult.questions?: string[]` stays exactly as it is; the fixed
  shape is a widening in `src/brain/types.ts` (`question?: AskQuestion`),
  the same way `src/inspector/types.ts` widens `Receipt`/`Delivery`/
  `FabricaEventName` and for the same stated reason. #176 asks for
  free-form questions to be *rejected at dispatch*, which is a runtime
  rule Fabrica enforces, not a new promise about the seam's type - and
  the contract is a path `rule9-gate.yml` protects, so a change there
  cannot be merged by CI at all. The two new event names
  (`ask-rejected`, `question-auto-answered`) are widened in
  `src/inspector/types.ts` for the identical reason.
  The one unavoidable contract-side change is a two-line fixture
  repoint: `contract/helpers/fake-brain.ts`'s `askQuestions?: string[]`
  became `askQuestion?: AskQuestion`, because that fake implements
  `Brain.ask` and the shape it returns is now rejected. No ratified
  assertion was added, removed or weakened.
- **A rejected ask is re-asked inside the same pass, twice, then fails
  loudly.** `registerAndAsk` calls `brain.ask()` up to three times: the
  first call, then one re-ask per rejection, and the third rejection
  throws `ForemanError("ask-shape-invalid")`, which the existing
  `ask-failed` path records. Every rejection lands on the record as
  `ask-rejected` (a silent skip would be a bug), and **every** call
  records its own `ask-cost-recorded`, so a re-asked pass is not a free
  pass through rule 10's ledger.
- **Only an adapter that got something recognizable surfaces it.** The
  reference adapter's `parseAskResult` still treats output that is not
  JSON at all as "nothing to ask" (deliberate, issue #8), but output that
  *is* an ask attempt and merely wrong-shaped is now passed through
  untouched so Fabrica can reject it and re-ask. Cleaning it up inside
  the adapter would make the re-ask loop unreachable.
- **"The first answer wins" has two halves, and only one of them is
  reachable today.** At an *ask*, `questions.ts`'s
  `autoAnswerFromRecord` (called by `registerAndAsk`) answers a question
  whose id the record already holds an answer for: it appends
  `question-auto-answered`, writes the round into `answers.md`,
  re-derives `brief.md`, and the task proceeds instead of stopping. A
  Fabrica task asks exactly once - on its first pass, where nothing is
  answered yet (a resumed round and a fix round deliberately never call
  `ask()` again) - so on that pass it finds nothing; it is a function
  against the record rather than an inline branch precisely so it is
  testable and so the guarantee holds for any round that does ask, in
  whatever process. The half that bites now is on the *answer* side: a
  second `fabrica answer` that names no question leaves the first answer
  standing and appends nothing. That is the documented retry of a round
  that threw mid-flight - before question ids it appended a second,
  duplicate round to `answers.md` and handed the worker the Client's
  words twice, which `src/foreman/answer.test.ts` used to assert as
  correct.
- **A correction never rewrites anything, and only ever names its
  question.** `fabrica answer <id> --question <qid> -m "<text>"` appends
  a second answer round for that id; `answeredQuestionsOf` takes the
  latest. Naming the question is what makes it a correction - a plain
  second `fabrica answer` keeps meaning exactly what it meant before
  (the retry above, or the `already-answered` refusal), because changing
  a decision is something the Client does on purpose. A correction
  arriving after the round already completed is recorded but does **not**
  resume the task (there is nothing to resume - that is what
  `already-answered` has always protected); `recordAnswerDecision` now
  returns whether to resume, and both callers (the CLI and the live
  view's `/review` page) honor it.
- **An option is the whole answer; "other" needs words and they *are*
  the answer.** Pairing a listed option with `-m` is refused rather than
  guessed at - it would leave the worker two answers to one question.
  `-m` alone, with no option named, is "other", which is what this
  command has always meant, so every older invocation still works.
- **The one thing the shape rule could not be verified against here.**
  The reference adapter's own `ask()` tests are Docker-gated and skip on
  a machine without a daemon; `.github/workflows/docker-tests.yml` is
  what actually runs them. The fake CLI's ask scenarios were renamed
  with the shape change (`ASK_SCENARIO_QUESTIONS` → `ASK_SCENARIO_QUESTION`,
  `ASK_SCENARIO_MIXED` → `ASK_SCENARIO_FREE_FORM`), so a stale reference
  to either fails there rather than silently matching the fallback
  branch.
- **`AskedDetails.questions` is still a `string[]`.** It is the one-element
  list holding the question's own text, kept beside the new structured
  `question` so every existing reader of the `questions-asked` event -
  `fabrica log`'s renderer, the live view, the Herdr watcher, old events
  already on disk - keeps working untouched. The record is append-only;
  nothing is backfilled.
- **The clarifying step's Docker-network sweep runs once per ask call,
  not once per task.** `registerAndAsk`'s model call is wrapped in a
  `try/catch/finally` whose `finally` calls `sweepTaskNetworks(taskId)`,
  and that whole block now sits *inside* the shape-rejection loop. A
  rejected shape asks again, which opens a second set of worker networks
  under the same task id, so sweeping per call is what keeps a re-asked
  pass from leaving one behind. `sweepTaskNetworks` never throws and is
  silent on a machine with no Docker, so calling it up to three times in
  a row costs nothing.

## Resolving this branch's rebases, and the rule that keeps working

- **Plan, written before the change (safest, then most accurate, then
  fastest).** Both stopped conflicts were additive on both sides - a
  barrel's export list and a README table - so the safest resolution
  is per-item rather than per-hunk: for each exported name and each
  table row, keep whichever side's version carries the other's content
  too, and keep both sides' items where they are different items.
  Nothing is reworded while resolving, so the diff against each side
  stays readable as "the other side's additions, and nothing else".
  *Alternative rejected:* taking one whole side of each hunk and
  re-adding the missing pieces by hand afterwards. That reaches the
  same text when it goes well, but it retypes lines nobody asked to
  change - in a 2,700-character table row, a retyped word is invisible
  in review and indistinguishable from a deliberate edit.
- **Why the barrel conflicts at all, every time.** `src/index.ts` is
  the single public entry point, so any task that adds a module or
  widens a seam edits it, and two tasks in flight almost always edit
  the same region. This branch's edit is not an addition but a
  *replacement*: `Brain` moved out of the `contract/surface.ts` export
  line and into the `./brain/index.ts` one, because issue #176 widens
  the ratified pair by one field (`src/brain/types.ts`). So resolving
  that hunk by keeping both sides literally would export `Brain`
  twice, from two places, and fail the typecheck - the contract line
  has to come across *without* `Brain`, which is the one item in
  either hunk that cannot be decided by "keep the longer side".
- **The README's Files table is a per-row merge, not a per-hunk one.**
  Three rows conflicted and each side was a strict superset for a
  different row: this branch's `errors.ts` row names the three error
  codes issues #176/#175 add, master's `judge.ts` and `pr-body.ts`
  rows name `withPullRequestMessage` and `titleProblem` from the
  rebase-only round. Taking either side whole silently drops real
  documentation for two modules, and nothing in the suite reads this
  table to notice.
