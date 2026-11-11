# A page-render test fixture gets one clock read, not two

`integrations/live-view/quiz-render.test.ts`'s "nothing due, but
questions exist" was flaky: it stamped a question due exactly two hours
out from one `Date.now()`, then `quizBody` stamped the response's own
`now` from a second `Date.now()` a few lines later. The pages take their
clock from the response, not from the browser (`public/quiz.js`:
`serverNow = body.now || Date.now()`), so the gap between those two
reads is subtracted from the due-in the page renders — and
`formatAge` floors, so **a single elapsed millisecond** turns `2h` into
`1h59m`. It passed whenever both reads landed in the same millisecond,
which is most of the time on a fast machine and less often on a loaded
CI runner (it failed `docker-tests` on PR #350, 2026-11-11).

The durable rule, for any future test of these pages: **compute one
`const now = Date.now()` per test and use it for every time in the
fixture, including the response's own `now`.** The fixture builder's
`now` parameter is deliberately required rather than defaulted, so a new
call site cannot quietly reintroduce the second read. `src/cli`'s
`status-command.test.ts` meters test already works this way — one `now`,
shared by the recorded reading and the injected clock — so this is the
project's existing convention rather than a new one.

What this is *not*: fake timers were considered and rejected. That file's
`render()` helper relies on real microtask/`setImmediate` flushing to
land the page's first poll, so freezing the clock would mean putting
timer plumbing into a helper whose whole value is being minimal — for a
bug that is only ever two clock reads in a fixture. No production change
was needed either; the page's time source was already correct.

## Unrelated trap noticed while running the suite here

`.gitignore` ignores `node_modules/` **with a trailing slash**, which
matches a directory only. `check.sh` does not always create a directory:
where `/deps/node_modules` exists (inspector's own check container) it
creates a *symlink* named `node_modules`, and a symlink is a file as far
as that pattern is concerned — `git status` lists it as untracked.
Anywhere the working tree is committed wholesale after `check.sh` ran,
that symlink would go in with it. Dropping the trailing slash would cover
both, but that is a root dotfile and nothing to do with the flaky test,
so it is written down here rather than changed on the way past.

Everywhere else with the clock-read shape was checked and is sound: `src/quiz/`'s
tests, `src/foreman/base-standing.test.ts`, and the `render`/`status`/
`watch` command tests all pass a single `now` into the function under
test, and the quiet-ceiling tests stamp events *into the past*, where
extra elapsed time can only reinforce the boundary they assert, and they
match on wording rather than an exact duration.
