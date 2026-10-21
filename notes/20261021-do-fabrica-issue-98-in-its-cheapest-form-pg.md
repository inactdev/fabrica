# Adding a required field to the worker's write-up (issue #98's quiz)

Three things worth knowing before the next field lands on
`contract/surface.ts`'s `WorkerWriteup`.

## The five places a required field has to be added, or it is asked for nowhere

`src/brain/writeup.ts`'s `WRITEUP_FIELDS` is the single list both
adapters' schemas declare `required` from, so adding a field there gets
it *asked for*. It still has to be:

1. declared as a property in `claude-code.ts`'s `WRITEUP_JSON_SCHEMA`
   (`additionalProperties: false` - an undeclared field cannot arrive at
   all) **and** in `openai-compatible.ts`'s `writeupToolSchema()`;
2. copied in **both** adapters' `writeupFrom` - each builds the write-up
   field by field on purpose, so rule 9's `gateChanges` (which rides in
   the same tool-call arguments) can never end up inside the write-up;
3. carried over the job file for the openai-agent's own in-box check, if
   it isn't a plain string: `loop.mjs` names `confidence` and `quiz`
   explicitly while `writeupStringFields` keeps every string field's
   name out of that directory;
4. checked in `src/foreman/pr-body.ts`'s `writeupProblem`, which is the
   one gate the Foreman actually enforces;
5. added to both fake brains' default write-up (`contract/helpers/` and
   `src/brain/helpers/`), or every ordinary test that expects a "done"
   delivery starts failing on an invalid write-up instead.

A non-string field also wants its own validator next to the field list
rather than inline in `writeupProblem` - `quizProblem`/`quizEntriesOf`
are the pattern: one function returning the *reason* for the Foreman,
one returning the showable value for display surfaces, so "is there one
to show" is decided once.

Worth knowing about `writeupFrom`'s deliberate asymmetry: the string
fields and `confidence` are shape-tested there (anything else is "no
write-up at all"), but `quiz` is carried through unexamined. A write-up
with four quiz questions and nothing else wrong *is* a write-up;
reporting "the worker returned no write-up" for it would be both false
and unactionable, where `writeupProblem` names the real reason and the
worker can fix it on the next attempt.

## `appendEvent` always stamps its own `occurredAt`

`src/record/append.ts` overwrites `occurredAt` on every append, so a test
that needs several events in a *guaranteed* order has two options:
a real sleep between them (what
`integrations/live-view/record-view.test.ts`'s "finished tasks sort
newest-first" does - fine for two, twelve would be slow), or
`appendFileSync(recordPath(recordHome), ...)` with a hand-written line
carrying the timestamp you want (what the `getQuizRows` ordering test
does). The second is already an established test-only pattern in that
same file, used for the corrupt-line test.

Same-millisecond ties are not a bug in the reader: `discoverTaskIds`
order decides them, which is arbitrary but harmless for real
acceptances.

## The fake DOM's `dataset` is a snapshot, so a render test gets one poll

`integrations/live-view/helpers/load-time-dom.ts`'s `dataset` getter
builds a fresh plain object from the attribute map each call, so
`card.dataset.taskId = id` - how `review.js`, `app.js` and `quiz.js` all
key a card so a poll never rebuilds one that is being read - is a no-op
there. A test that renders a page through that fake can assert on the
markup of one drawn pass; asserting what survives a *second* poll would
be testing the fake, not the page.

That is why `quiz-render.test.ts` renders once, and why it brings its own
loader instead of extending `page-scripts.test.ts`: that file's `fetch`
deliberately never settles (the state a just-loaded page is really in,
which is what makes its script-load-order proof honest), and a render
test needs exactly the opposite.
