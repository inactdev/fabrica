# The Client's pull request template (2026-10-18)

## The plan, written before the change

**Chosen approach.** Keep the write-up a single-source field list
(`src/brain/writeup.ts`) and render the Client's template from one
section table in `src/foreman/pr-body.ts`. The new `outsideChanges`
field reaches both adapters' schemas through those exported lists, so no
adapter restates a field name; the one optional field gets its own
exported list (`WRITEUP_OPTIONAL_STRING_FIELDS`) and a matching
`AgentJob.writeupOptionalStringFields`, because "optional" and
"required" are different lists to a JSON Schema's `required`.

**Alternative rejected: hardcode the new field names in each schema.**
Faster to write — three small edits instead of a new exported list plus
a job field — but it would put the write-up's field list in four places
(`writeup.ts`, `claude-code.ts`, `openai-compatible.ts`,
`openai-agent/loop.mjs`). The project deliberately keeps it in one, and
`loop.mjs` runs *inside* the worker's box with no TypeScript and no
compile-time check, so a drifted list there would fail silently at the
one moment it matters — a finished task losing a section of its write-up.

**Alternative rejected: make "could not verify" a required field** with
a `"None."` convention, exactly like `deviations`. Rejected because the
Client's clarification says to omit that bullet entirely when its field
is empty; a required, non-empty-checked field can never be empty, so the
instruction would be dead code and the bullet would always render, often
saying "None." for no reason.

## What the body looks like now

`finalMessageFor` renders exactly five sections, in this order, and
`judge.ts` prepends `Closes #N` as the pull request body's **first**
line (never the commit message's — GitHub closes an issue from a merged
pull request's body):

```
Closes #N            <- pull request body only, when the task has an issue

## Context (Why)
## Description (What)
## Changes in the codebase (How)
## Changes outside the codebase
## Additional information
```

The first four are the worker's `why`/`what`/`how`/`outsideChanges`
verbatim. "Additional information" is labelled bullets in a fixed
order — Confidence, Assumptions, Expected outcomes, Deviations, Could
not verify here — and a bullet whose field is empty is omitted
entirely, with no placeholder. Only `couldNotVerify` is optional, so in
practice it is the only bullet that is ever omitted.

## Sharp edges found while doing it

- **`withClosesLine` prepends now, it does not append.** Its name did
  not change (`judge.ts` and `src/foreman/README.md` both name it), but
  its position did. A test that asserted the trailing form was the only
  thing pinning it.
- **A bullet's value is indented, not raw.** A worker that writes two
  paragraphs into `assumptions` would otherwise break out of the
  markdown list at the blank line. `bulletLines` indents every
  continuation line by two spaces, which renders correctly for one
  paragraph or several and is harmless in a commit message.
- **`WRITEUP_FIELDS` is in render order, and render order changed.**
  `why` now comes before `what`, because the body leads with Context.
  The list's own doc comment claims render order, so it was reordered to
  stay true. Two consequences: `writeupProblem` reports problems in that
  order, and both adapters' JSON Schema `required` arrays are in that
  order. Nothing depends on either, but a test that hardcodes an
  unsorted copy of the list would.
- **`src/inspector/consumer-contract.json` is untouched, on purpose.** It
  pins the *call* to Inspector (flags, exit codes, the stdout line, the
  token env var), not the body's shape. The body rides in through
  `pr-body-file`, so changing what is written in that file needs no sync
  with Inspector's own copy of the contract.
- **`/review`'s write-up panel is `white-space: pre-wrap` plain text**
  (`integrations/live-view/public/style.css`'s `.review-writeup`), so the
  `##` headings now show literally there. That is the deliberate
  trade-off the panel already made - it renders the *exact* pull request
  body through `finalMessageFor` rather than a prettier second copy that
  could disagree with the real one. Rendering it as markdown is its own
  change, for its own task.
- **`WRITEUP_FIELDS` means *required* fields.** It feeds
  `claude-code.ts`'s `required: [...WRITEUP_FIELDS]`, so an optional
  field must never be added to it — `WRITEUP_OPTIONAL_STRING_FIELDS` is
  the separate list, declared as a schema property (both schemas set
  `additionalProperties: false`, so an undeclared field is rejected
  outright) but kept out of `required`. This is the same shape rule 9's
  `gateChanges` already had in `openai-compatible.ts`.

## How this was verified from inside a worker box (and the sharp edge)

`npm install` is blocked in a worker box here — the registry answers 403
on every tarball — so `npm test` cannot run as written: `tsc` and `tsx`
are both absent. Two things made it checkable anyway, and both are worth
knowing for the next task that lands in the same spot:

1. **`node --test <file>.ts` runs this repo's tests directly.** Node 24
   strips types natively and resolves the `.ts` import specifiers this
   repo uses, so the whole suite runs without `tsx`. What it does *not*
   do is typecheck — it erases types rather than checking them, so a real
   type error still slips through. It is a substitute for `tsx --test`,
   never for `tsc --noEmit`.
2. **The one import that stops everything is `smol-toml`**
   (`src/config/load.ts`), and it is only ever used for `TOML.parse`.
   Dropping a throwaway shim at `node_modules/smol-toml/` with a
   small-subset `parse` unblocked 1022 passing tests.

The honest way to read a run like that is a **differential** one: run the
suite once on the unmodified baseline (restore each changed file with
`git show HEAD:<path>`, since `git stash` cannot work — the git directory
is mounted read-only in a worker box) and once with the change, then diff
the failure sets. Identical sets means the change broke nothing; it does
*not* mean the suite is green. Here both runs failed the same 35 tests —
every one of them either spawning the missing `tsx` binary or tripping
over the shim's TOML gaps (`nan`/`inf` literals, a `__proto__` key).
Every test file this change touches ran for real and passed.
