# Skip rules — shadow mode only

Issue #204, as amended by the Client's ruling of 2026-10-25. **Nothing in
this module closes, merges, or verdicts anything.** Every task still goes
to the Client exactly as it did before; the only thing shadow mode adds is
one `would-close-by-rule` event per delivery, saying what a rule *would*
have done, and the counts the surfaces read off it.

The real path — a safe task closing by rule, a landing delay, a merge
through Fabrica's GitHub identity, every tenth one graded — is a follow-up
behind the graduation proposal, and CONTRACT rule 6 is the Client's to
amend before any of it is turned on. So is the noticer, and so are
`fabrica propose-skip` and its four-part pull request.

## The rules file

`.fabrica/skip-rules.toml`, committed in the project's own repository —
not in `projects.toml`. A committed file is diffable, has a reviewable
history, and is a protected path the project's own gate can defend, which
is what gives `rulesVersion` on each event something real to point at.

```toml
version = 1

[kinds.docs-only]
description = "A documentation-only change under docs/ or notes/"
mode = "shadow"
allowedFolders = ["docs", "notes"]
maxFiles = 5
maxLines = 80
noTestFiles = true
noDependencyManifest = true
inspectorGreen = true
requiredGreenChecks = ["inspector-tests"]
noQuestionsAsked = true
noCouldNotVerify = true
```

Everything about this file fails loudly rather than quietly:

- `version` is required, a whole number, and the Client bumps it when he
  changes a line. The event records `"<version>@<12 hex of the file's
  sha-256>"`, so a file edited without bumping the number is still
  distinguishable on the record.
- `mode = "live"` gets its own refusal, naming CONTRACT rule 6 — it is
  not a typo and must not be answered as one.
- An unknown condition key is refused, naming the whole vocabulary.
- A flag condition's only legal value is `true`. `false` is refused: a
  question you don't want asked is one you leave out, and `false` is the
  one spelling where a typo silently removes a safeguard.
- A kind with no conditions at all is refused — that would read as "close
  anything of this kind".
- `allowedFolders = ["."]` is refused for the same reason.

## Read at the base commit, never from the worktree

`loadSkipRules(project, baseCommit)` reads through `git show`, in the
Client's own checkout, at the commit the ProductionLine was cut from. The
worker has write access to its throwaway worktree, so the working-tree
copy of this file is a file the thing being judged could have written
itself. The base commit is the one revision nothing in the round can have
changed.

A project with no file there gets **no event at all** — not an empty one.
"Never opted in" and "opted in and said nothing" are different facts.

## The vocabulary is fixed in code

`conditions.ts`. The Client combines questions; he does not write them,
and he does not write what they mean either — a file that could also
define "test file" would be a file that can widen its own questions.

| condition | answered from |
|---|---|
| `allowedFolders` | the delivery's `files`, as directory prefixes |
| `noTestFiles` | the delivery's `files`, against `isTestFile`'s conventions |
| `noDependencyManifest` | the delivery's `files`, against a fixed manifest list |
| `maxFiles` | one `git diff --shortstat` |
| `maxLines` | the same, insertions **plus** deletions |
| `inspectorGreen` | this round's `inspection-finished` verdict |
| `requiredGreenChecks` | this round's `ci-check-concluded` events, by name — including the `inspector-tests` commit status, which is why it needs no question of its own |
| `noQuestionsAsked` | whether the task ever has a `questions-asked` event |
| `noCouldNotVerify` | the write-up's own `couldNotVerify` field |

**No model is consulted anywhere between "checks finished" and the
answer.** A model's finding reaches this decision only as "did a check go
red", so a model can send a task to the Client and can never let one skip
him. `no-model.test.ts` pins that structurally (nothing in this module
imports a brain, and nothing spawns anything but git) and behaviourally
(an evaluation with a brain in the record home calls it zero times).

## Three answers, and a floor

`"safe"`, `"unsafe"`, `"unknown"`. Only `"safe"` is safe: git that could
not be read, a required check that never concluded, an Inspector never
called, a delivery naming no files — all `"unknown"`, which never closes
anything. A question nothing could answer is the one case where a rule
must fail closed.

In front of every kind's own conditions sits one question that is **not**
from the rules file: `deliveryDone`. No line a Client could write may
close a task whose delivery is not `"done"` — a failure report, a red
inspection, a cap or meter stop, a rebase conflict, a round that changed
nothing. It is marked `fixed: true` on the record so a reader can tell
Fabrica's own question from his.

## Where it runs

`src/foreman/round.ts`'s `recordRoundResult`, once, after whichever of its
five delivery shapes actually landed — so every delivery is evaluated and
none of the shapes needs its own call. It **never throws into the
round**: a delivery has already landed by then, and losing it to a
mistyped rules file would be far worse than not evaluating. A refusal
becomes the event's own `problem`, where `fabrica shadow-report`,
`fabrica log` and the live view all show it.

## Reading it back

- `fabrica shadow-report` — per project and kind: would-close count,
  accepted, disagreed, days running, plus any rules file that could not
  be used and why.
- `fabrica status` and the live view's header — one count line, from the
  same `shadowCountsLine`, so the terminal and the phone can never
  disagree.

"Accepted" and "disagreed" are both counted off the task's latest
`verdict-recorded`, the same way `stateOf` reads it. A task still waiting
is counted as `pending` rather than folded into either, so the three
always add up to `wouldClose` — a report where they didn't would read as a
bug. Only a task's **latest** evaluation counts: a fix round delivers
again and is evaluated again, and counting both would report one task
twice.
