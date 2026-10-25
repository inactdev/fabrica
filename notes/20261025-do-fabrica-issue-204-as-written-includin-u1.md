# Skip rules, shadow mode only (issue #204 + its 2026-10-25 amendment)

## The plan, written before any code was changed

Shadow mode only. Nothing closes, nothing merges, every task still goes
to the Client exactly as it does today. What is built:

1. A committed per-project rules file, `.fabrica/skip-rules.toml`, read
   **at the task's base commit through git**, never from the worktree the
   worker just had write access to.
2. A fixed condition vocabulary in code. A rules file can only combine
   those keys; an unknown key, a missing `version`, or a `mode = "live"`
   is refused loudly. `live` names CONTRACT rule 6 in its refusal.
3. One evaluator, run once after every delivery, answering each condition
   from the record plus one `git diff --shortstat` for the counts, and
   appending a `would-close-by-rule` event carrying every answer, the
   rule-file version and the change's `git patch-id` fingerprint.
4. `fabrica shadow-report`, plus one count line on `fabrica status` and
   on the live view's header.

Deferred by the amendment and the Client's own clarifications, and
deliberately not built here: live mode, the merge-and-close path, the
graduation pull request, `fabrica propose-skip`, the four-part proposal
body, the every-tenth-task grade loop, and the noticer.

## Safest, then most accurate, then fastest

- **Safest.** The rules file is read from the base commit, not the
  worktree: a worker can edit `.fabrica/skip-rules.toml` in its own
  throwaway checkout, and reading the worktree copy would let the thing
  being judged write its own rules. Every unanswerable condition answers
  `unknown`, which is never safe. A code-fixed floor (`deliveryDone`)
  sits in front of every kind's own conditions and cannot be configured
  away. The evaluator never throws into the round: it records its own
  problem on the event instead, so a bad rules file can never lose a
  delivery, and never passes silently either.
- **Most accurate.** Every answer comes from the record (Inspector's own
  verdict, the pull request's concluded checks, the delivery's file list,
  whether the task asked questions, what the worker said it could not
  verify) or from git. No model is consulted anywhere, which
  `no-model.test.ts` pins structurally as well as behaviourally.
- **Fastest.** Two extra git calls per delivery (`--shortstat`, then one
  diff piped into `patch-id`), and nothing at all for a project with no
  rules file.

## The alternative that was rejected

**Putting the skip list in `projects.toml`** - which is what the issue
body itself says ("next to `projects.toml`"). Rejected because today's
amendment supersedes it with "each project commits a file", and because
the two differ in a way that matters: `projects.toml` lives in the record
home, is not under version control, and has no reviewable history, so a
line could be added or widened with nothing to review and no way to tell
when it changed. A committed file in the project is diffable, is a
protected path its own repository's gate can defend, and gives the
`rulesVersion` on each event something real to point at.

A second, smaller alternative also rejected: adding
`would-close-by-rule` to `contract/surface.ts`'s ratified
`FabricaEventName` union. It went into `src/inspector/types.ts`'s
widening instead, which is the documented single place Fabrica's own
event names are added without touching a protected path - and a shadow
event that closes nothing is Fabrica's own bookkeeping, not a new promise
to the Client about a seam.

## Durable facts worth keeping

- **`integrations/live-view/record-view.ts` contains a literal NUL byte**
  (around offset 34788), so `grep` and `rg` treat it as a binary file and
  silently report "binary file matches" or nothing at all. Use `rg -a`
  (or `grep -a`) on it. This cost real time to notice; a search that
  returns nothing there does not mean the string is absent.
- **The condition vocabulary is fixed in code, on purpose** - see
  `src/skiprules/conditions.ts`. "No test files touched" and "no
  dependency manifest changed" are answered against conventions written
  there (`*.test.*`, a `tests/` path segment, `package-lock.json`, ...),
  not against anything a project can configure, because issue #204 says
  the vocabulary is fixed and a line can only combine its questions.
- **`git diff --shortstat` is `--stat`'s last line and nothing else**
  (verified against git 2.54.0 on the machine, output
  `" 2 files changed, 3 insertions(+)"`), which is why it stands in for
  the amendment's "one `git diff --stat` for counts" without buffering a
  whole patch to throw it away.
- **`git patch-id --stable` reads a diff on stdin and prints
  `"<patch-id> <commit-id>"`**, with the commit id all zeros when the
  input is a raw `git diff` rather than `git log -p` output (verified the
  same way). Only the first field is the fingerprint.
- **The two `fakeBrain` helpers have different `onWork` signatures.**
  `contract/helpers/fake-brain.ts`'s takes `(workdir)`;
  `src/brain/helpers/fake-brain.ts`'s takes `(brief, workdir,
  reasoningEffort?)`. A test that copies the wrong one gets the whole
  brief where it expected a path, and fails with a very confusing
  `ENAMETOOLONG: mkdir '<the entire brief>'`.
- **`src/foreman/no-host-check.test.ts`'s child-process scan has a
  latent false positive** that `src/skiprules/no-model.test.ts`'s copy of
  it now guards against: its regex is anchored on `\b`, so an ordinary
  method call sharing one of the names it looks for - `new
  RegExp(...).exec(line)` - reads as a child-process spawn. Nothing under
  `src/foreman` trips it today, so it was left alone; the new copy uses
  `(?<![.\w])` instead. If a future `src/foreman` file calls `.exec(x)`
  on a regex, that is why its no-host-check test suddenly fails.

## `src/foreman/round.ts`'s round context is a named interface now

`recordRoundResult`'s fifth parameter used to be an inline object type
written out at the function's own signature, which every round-level
addition grew by a few fields. Splitting the function in two (the public
wrapper that calls the shadow evaluation, and the private
`writeRoundResult` that does the delivery work) meant that type had to be
named, so it is: `RoundContext`, declared once between them. Anything a
future round needs to carry into the tail - a test map, a reader's read,
the next thing - is added there, in one place, instead of to a signature
that two functions now share.

## What issue #204 asks for that is deliberately NOT here

The amendment is explicit that shadow comes first, and the Client's own
clarifications on this task narrowed it further. Left for follow-ups, so
nobody reads the absence as an oversight:

- live mode, and with it the merge-and-close path, the landing delay, the
  merge through Fabrica's GitHub identity, and the pull-request comment
  naming the kind;
- the graduation pull request (30 days, 100+ would-close, all accepted)
  and the rollback-to-shadow on a single revert or "wrong" grade;
- the every-tenth-task grade loop (explicitly deferred until real
  skipping is on);
- `fabrica propose-skip` and the four-part proposal pull request, plus the
  noticer issue they depend on.

`mode = "live"` in a rules file is therefore refused by the loader,
naming CONTRACT rule 6 - which is the Client's to amend before any of
the above is built.
