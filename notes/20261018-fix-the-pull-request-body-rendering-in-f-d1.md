# A duplicated pull request heading came from the write-up, not from the renderer

The task was reported as "`src/foreman/pr-body.ts` emits `## Additional
information` twice in a row" (seen on a real inspector pull request).
`finalMessageFor` pushes that heading exactly once, and always has: a
scan of every commit that has ever touched `pr-body.ts` found one
emission in each version, and nothing else anywhere in the repo renders
that string (`contract/surface.ts`, `src/brain/writeup.ts` and
`src/foreman/standing-question.ts` only *mention* it in prose). Fabrica
also hands the body to Inspector verbatim, as a file
(`src/inspector/run.ts`'s `-pr-body-file`), so no later step composes it.

So the second copy can only have come from the worker's own write-up: a
field whose value ends with a line that is nothing but a template
heading lands immediately before Fabrica's real heading, which is
exactly the "twice in a row, nothing between" shape reported
(`outsideChanges: "None.\n\n## Additional information"` renders it). A
heading echoed at the *start* of a field doubles its own section's
heading the same way.

## What now prevents it

`pr-body.ts`'s `withoutTemplateHeadings` drops any line of a field's
value that is one of the five template headings and nothing else, so
each heading in a rendered body is Fabrica's own and appears exactly
once however the worker fills its fields. `TEMPLATE_HEADINGS` is
exported so the test derives the list from the renderer instead of
restating it.

Two deliberate limits:

- A heading inside a fenced code block is kept exactly as written. A
  write-up that quotes this template (documenting it) is showing a
  heading, not emitting one - and inside a fence markdown would not read
  it as a heading either. So the "exactly once" guarantee is about
  headings the body actually renders, not about the substring appearing
  once in a quoting write-up.
- Rejecting such a write-up in `writeupProblem` instead was considered
  and not done: that makes the attempt red (`attempts.ts` never calls
  `judge()` for an invalid write-up) and costs a whole retry round for a
  cosmetic slip, and it cannot repair a body that was already written.

## Testing this project without an npm registry

A worker box with no npm registry access (`npm install` → 403) has no
`node_modules`, so neither `tsc --noEmit` nor `tsx` can run - but Node
24 strips TypeScript types natively, and every `*.test.ts` here is
erasable syntax, so `node --test <files>` runs the suites as they are.
The one blocker is `smol-toml` (`src/config/load.ts`), which almost
every suite reaches transitively: a ~25-line TOML-subset stand-in plus a
`node:module` resolve hook, both written *outside* the checkout (under
the system temp dir, so nothing lands in the task's own diff), maps that
one specifier and lets the rest of the suite run for real. Useful for
any task that needs more than one module's own tests under the same
restriction. The typecheck still cannot run there, and must be reported
as unverified rather than assumed.
