# Issue #349: a repository's own pull request template, and nothing else

## The decision, written before the change (rule 11)

Issue #349 asks for three things: a pull request body that follows the
repository's own template section by section with short entries, no
sections the template does not have, and Fabrica's own write-up
(confidence, assumptions, what it could not verify) kept to the delivery
the Client reads rather than the body the team's reviewers read.

Two of the three are the same removal: `pr-template.ts`'s `## Notes`
block was what added a heading the template never had and what carried
the confidence/assumptions/expected-outcomes/deviations bullets, plus
`outsideChanges` and whatever why/what/how found no section, into a
company pull request. Deleting it answers both. The delivery side needed
nothing: `pr-body.ts`'s four-section rendering is what the live view's
review page already shows the Client (`integrations/live-view/
record-view.ts`'s `writeupBody`) and what the commit message already
carries, on every project, template or not.

**The alternative rejected.** The other way to answer "the write-up goes
in the delivery note, not the PR description" was to keep `## Notes` and
shorten it - drop the bullets, keep the unplaced why/what/how. It was
rejected because it still fails the issue's second expectation: `##
Notes` is a section the template does not have, and a reviewer who wrote
that template gets a heading nobody on the team asked for. It also keeps
two ideas of what a body is, which is the drift this module's own header
warns about.

## The edge the issue did not name: a template nothing can be placed into

With `## Notes` gone, a template whose headings claim no write-up field
at all (no heading matching why/what/how/testing, or none at all -
"Thanks for contributing!", or a bare checklist) would render a body
that describes the change nowhere. `renderIntoTemplate` therefore
returns `undefined` in exactly that case and `judge.ts`'s
`pullRequestBody` falls back to Fabrica's own four-section body - the
same outcome a project that asks for a template and has none already
gets, and the same line `readPullRequestTemplate` already draws for a
whitespace-only template ("no template to render into").

The cost is real and worth knowing: that fallback drops the template's
own checklist from the body, which is the one case where this module's
"nothing in the template is ever thrown away" rule bends. A body with no
description at all was judged worse than a body without the checklist.
A template with at least one matching heading keeps everything, as
before.

## Both spellings of the template's path

`.github/PULL_REQUEST_TEMPLATE.md` and `.github/pull_request_template.md`
are both read now, uppercase first (what Fabrica read before, so a
repository holding both renders exactly as it used to). GitHub's own
documentation ("Creating a pull request template for your repository")
spells the file lowercase in every example and says nothing anywhere
about the name being case-insensitive - so the only safe reading is that
both spellings occur in the wild, which is why both are looked for
rather than one assumed.

**The same shape, left standing deliberately:** that same documentation
names two more locations for a single template that Fabrica still does
not read - `pull_request_template.md` in the repository root and
`docs/pull_request_template.md` - each presumably in either spelling. A
repository using one of those gets Fabrica's own body with no
indication, exactly the silent fallback this change fixed for the
lowercase `.github/` spelling. It was left alone because the ruling on
this task named the two `.github/` spellings and nothing else, and
because reading a root-level template would change the body for any
project that happens to have a stale one. `fabrica doctor`'s project
line is where the Client sees "no template to render into", so the
fallback is at least not silent to him.

## Brevity is asked for, never enforced

"A small change gets a few lines, not paragraphs" is a sentence in
`FINAL_MESSAGE_FORMAT_NOTICE` (`standing-question.ts`), which every
brief carries. It is deliberately not validated: refusing a write-up for
being long would cost the task a whole red round over something
cosmetic, which is the same line `quizProblem` and
`withoutTemplateHeadings` already draw for a wrapped answer and an
echoed heading.

One tension worth knowing, not resolved here: `SAME_SHAPE_NOTICE`
(issue #147) asks a worker to list the code's other instances of a bug's
shape "in your write-up" without naming a field, and issue #349's own
report of what went wrong names exactly that - unrelated findings about
other parts of the codebase under the template's `## What`. The notice's
destination is issue #147's ruling, so it was not changed; the brevity
sentence asks for every field to stay about this change, which is the
most that could be done without re-deciding where that list belongs.
