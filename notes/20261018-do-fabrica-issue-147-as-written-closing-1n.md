# Adding a line to the standing brief every worker gets

Issue #147 asked for one more line in the standing brief: when you fix
something, list every other place in the code with the same shape.

## Where a new standing line goes, and where it must not go

`src/foreman/standing-question.ts` composes the brief's prefix from
separate exported constants — `STANDING_QUESTION`,
`FINAL_MESSAGE_FORMAT_NOTICE`, `SAME_SHAPE_NOTICE` (new, issue #147),
`DURABLE_NOTES_NOTICE` — joined by `STANDING_PREFIX`.

Only `STANDING_QUESTION` is CONTRACT rule 11's ratified text, and
`contract/rule11.standing-question.test.ts` holds a verbatim copy of it
plus one `assertCarries…` helper per sentence that was ever appended to
it (the commit-ownership line, the docs-before-guessing line). So
appending a new sentence *into* `STANDING_QUESTION` means editing
`contract/` to keep that copy honest — a ratified, CI-protected path
that needs an explicit Client ruling. Adding the line as its own
constant folded into `STANDING_PREFIX` reaches every worker identically
and touches no protected path.

Note that the contract test asserts `brief.startsWith(STANDING_QUESTION)`
against its own hardcoded copy, so growing `STANDING_QUESTION` *would*
still pass silently — the old text is a prefix of the new one. That is
exactly the stale-duplicate trap the test's own comments describe, and
the reason the separate-constant route is the safe default rather than a
matter of taste.

## Where the prefix's composition is documented

Two places describe the brief's make-up and both need updating when a
line is added: the `standing-question.ts` row in
`src/foreman/README.md`'s file table, and the header comment of
`src/foreman/standing-question.test.ts`. Nothing else anywhere in the
repository holds a copy of the brief text — `src/cli/watch-command.test.ts`
and `src/brain/adapters/claude-code.test.ts` both build their
expectations by calling `withStandingQuestion` rather than pasting it, so
they need no edit. `src/brain/adapters/claude-code.md`'s mention of
`withStandingQuestion` is about the ask-step/work-brief boundary, not the
text.
