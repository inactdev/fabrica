# The test map's unmapped report counts code only (issue #305)

`tests.map`'s report used to count every touched file, so a delivery
read `tests.map: 31 touched files unmapped (HANDBOOK.md, README.md,
integrations/live-view/public/app.js, and 28 more)` - and the one file
in there that genuinely lacked a test was hidden behind the prose.

**Where the answer lives now:** `src/testmap/classify.ts`, one module,
called from exactly one place - `match.ts`'s `testMapReport`, the single
function that decides what `TestMapReport.unmapped` holds. That matters
because `unmapped` feeds four readers (the delivery's block, the
`fabrica status` / live-view row, the brief's test-map notice, and a
rebase-only fix round's notice). Filtering at any one of them is the
drift `describe.ts`'s own header warns about - "three separately-worded
copies are how they stop agreeing" - so classification belongs at the
source, not at a reader.

**The rules, from the Client's ruling and his clarifications on it:**

- documentation is never counted as unmapped: any `*.md`, anything
  under a `notes/` or `docs/` directory **at any depth** (so
  `integrations/live-view/docs/` too), and - at the repository root
  only - every dot-prefixed file plus `LICENSE`;
- a touched file that is itself a test is mapped to itself, so a newly
  added `*.test.ts` nobody has written a line for is never reported as
  a file with no test;
- the row names up to **five** files, then "and N more"
  (`STATUS_FILES_NAMED`, was three);
- when no code file is unmapped, the `tests.map` line is omitted
  entirely - "silence means nothing is missing". That fell out of the
  existing `describeTestMapNote` returning null for an empty list, once
  documentation stopped landing in it.

**Two sharp edges this left behind:**

1. The exemption is only about what counts as *missing* a test. A
   documentation file that matches an entry is still mapped by it (a
   project may point `docs/**` at a link checker), because the
   classification is consulted only when the union of matching entries
   came back empty.
2. `generateTestMap` still writes a `foo.test.ts: foo.test.ts` line per
   test file, which `match.ts` now also derives on its own. Left as it
   was deliberately: dropping those lines would shrink every committed
   map by half for no behavioural gain, and the generator's output is
   also what a human reads to see what is covered.

Reporting only, by the issue's own last line - nothing about what makes
a task green changed, and the whole suite still runs either way.
