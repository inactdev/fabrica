# A rebase-only fix round ("master moved")

The Client's fix note is what decides a round's shape now, in one place:
`src/foreman/rebase-only.ts`. A note beginning "master moved" means the
round is a rebase and nothing else — narrow brief, narrow test run, one
section of write-up, and the pull request's body appended to rather than
rewritten. Any other note gets exactly the round it always got.

## The decision written down before the work started

**Chosen:** keep the worker's *answer shape* identical (the same
structured write-up, the same adapter schema) and narrow only two
things — the brief the round builds, and how Fabrica renders what comes
back. The policy lives in one new module; the rest of the fix round
(`verdict.ts`'s rebase, Inspector's full run, the stamp, the CI
read-back) is untouched, and every seam added is one optional parameter
with a default that reproduces today's behaviour exactly.

**Rejected: asking the brain for a different, one-field write-up on a
rebase-only round.** That would be the honest way to make the round
"one section" end to end, but the only way to ask for a different shape
per call is a new field on `BrainWorkOptions` — declared in
`contract/surface.ts`, which is immutable without an explicit ruling —
and it would put knowledge of rebase rounds into every adapter. Safety
and the contract both said no. The worker is therefore still *asked* for
every field; the brief tells it which one is published, and Fabrica
renders that one.

**Also rejected: storing the handed-over pull request body as a new task
file** and appending to that file each rebase round. Simpler to read,
but it adds state that can disagree with the record, and a task whose
earlier rounds predate the file would still need the record-side
reconstruction — so it buys nothing. The body is re-derived from the
record instead (`pullRequestOnRecord`), the same way a detached fix
round already re-derives its project, brief, note and receipts.

## Two things found while building this, worth keeping

- **`git rebase --continue` strips every `#` line from a commit
  message.** `src/line/rebase.ts` runs git with `GIT_EDITOR: "true"`, so
  git treats the replayed commit's message as *edited* and applies
  cleanup mode "strip" rather than "whitespace" — which removes any line
  beginning with `#`. The Client's pull request template is five `##`
  headings, so a fix round whose rebase conflicted silently rewrites the
  task's own commit message on the branch without them. Only the commit
  message is affected (the pull request body is handed to Inspector as
  text, untouched), which is why nothing here fixes it; a rebase round's
  own entry just avoids `#` so its date survives in both places.
- **A conflict round has no commit of its own.** The host stages the
  worker's resolution and finishes the rebase, so everything the worker
  did lands in the commit being replayed, under *that* commit's message;
  `commitWorktreeChanges` then finds nothing staged and no-ops. A test
  asserting "this round's message is on the branch" only holds for a
  round whose rebase went through cleanly and whose worker then changed
  something.

## Sharp edges worth knowing

- The prior pull request body is rebuilt from the task's latest
  *delivered* event carrying a valid write-up that was not itself a
  rebase round, re-rendered through `finalMessageFor` (never
  re-implemented), plus one dated entry per rebase-only round since.
  Nothing new is stored. The limit, stated in the module: that latest
  write-up may belong to a red round Inspector never published, in which
  case the body handed over is a little newer than what is on GitHub —
  no description is ever lost, which is the property that matters.
- `skipIfUnchanged` (judge.ts) is skipped for a rebase-only round whose
  rebase actually rewrote the branch. Without that, the common case —
  master moved, the rebase went through cleanly, the worker has nothing
  to resolve — delivers "nothing-changed" with Inspector never called,
  so the rebase is never published and the round accomplishes nothing.
  An `already-current` branch still takes the wrapper: there is
  genuinely nothing new there, and re-handing the identical commit only
  draws a refusal.
- The same shape is still there for an *ordinary* fix round whose rebase
  rewrote the branch and whose worker then changed nothing: it delivers
  "nothing-changed" and is never re-inspected. Left alone deliberately
  (this task's brief says everything else about a fix round stays as it
  is) — it is a real, known gap, not an oversight.
- The review page asks `publishedPullRequestMessage` rather than
  rendering the latest write-up itself, so it shows the Client what a
  reviewer sees. For a rebase round that is the description plus the
  rebase history; rendering the write-up would show four sections that
  were never published. Same renderer either way — the page has never
  held a copy of the template and still doesn't.
- The delivery's own test-map block still resolves against the round's
  whole touched-file diff, not the conflicted files. Only the worker's
  own run in the workstation is narrowed (Client ruling), so the
  delivery deliberately keeps reporting what the task as a whole maps
  to; the worker's `testsRun` beside it will be shorter, and already
  reads as "the worker's own report, not checked against the list".

## A fix round calls its worker from more than one place

Found rebasing this onto a master that had landed the code reader
(inspector issue #34): `verdict.ts`'s round now makes worker calls from
**two** sites — the rebase pass loop, and the reader's own fix pass
after Inspector's green — and master had just factored the brief they
share into one `briefFor(extra?)` helper for exactly that reason.

Anything that is a property of the *round* rather than of one pass has
to reach both, or the round quietly changes shape half-way through:

- the brief's conditional notice (`briefFor`, master's own fix);
- how a write-up becomes a commit message (`rebaseOnlyRendering`, spread
  onto both `runAttempts` calls);
- the judge wrapper that appends to the pull request's body instead of
  rewriting it (`judgeThisRound`, which the reader pass takes too — it
  is `roundJudge` without `skipIfUnchanged`, which is what that call
  site actually wanted, since `readAndFlag` does its own).

The reader's fix pass is also the pass that *publishes* when the reader
flags something, so a per-round rendering that skipped it would have
produced the right commit messages and the wrong pull request.

The other half of the lesson is about resolving such a rebase at all:
where master re-shapes a region a branch also changed, the conflict
markers cover only the overlap, and the clean merge around them already
carries master's new shape. "Keep both sides" there means re-applying
the branch's *intent* inside master's structure — the rebase-only
lookup moved into `briefFor`'s options — not pasting both texts and
hoping the result compiles.

## Inspector retired `image` and `network`, and no task can migrate them

Found when a later round of this task was refused with `.inspector.json
still names an "image"`. This repository has since migrated (master's
own commits for inspector#47: the two keys dropped, a root
`Dockerfile.inspector` committed with dependencies baked into `/deps`,
and `check.sh` linking those in when it finds no `node_modules` and no
network). Inspector's own README (read 2026-10-27) is the authority for
the rules themselves, which are worth keeping here because any other
project Fabrica is pointed at meets them for the first time:

- `"image"` and `"network"` are **retired keys**, and a config that
  still carries either is refused by name, with any value — never
  silently dropped.
- The check environment is now whatever a committed
  **`Dockerfile.inspector`** at the repository root builds. The path is
  fixed and there is no config key for it; a project that commits none
  is refused by that file's name. The point is that the box work is
  written in and the box it is judged in cannot differ — "one file, one
  name, in both places."
- Two constructs in it are refused outright: a variable in `FROM` (the
  base must resolve to a digest) and a `# escape=` directive. A
  Dockerfile carrying `COPY`/`ADD`/`RUN --mount` is rebuilt every run;
  a pure toolchain install is built once and then skipped.
- **The check container has no network, and there is no way to ask for
  one.** Dependency installation therefore has to move into the image
  build, which still has network. `check.sh` running `npm ci` when
  `node_modules` is absent is exactly the shape that stops working.

Why a task can never do this itself, however plainly the refusal asks:
Inspector treats *any* final `.inspector.json` differing from the base
commit — deletion included — as a refusal rather than a skip, which is
what stops a Worker weakening its own inspection. So an edit to it from
inside a round is guaranteed to draw the refusal it was meant to clear.
`Dockerfile.inspector` sits in the same always-protected floor, and the
standing rulings allow a merge override only for the contract, a
workflow file, or `check.sh` — so neither file can reach master through
a task branch at all. Both are the Client's own commits, on master, and
a round that hits this refusal should say so and change nothing.

Still open after that migration, and none of it touched by this task:
`fabrica register` goes on writing both retired keys and scaffolds no
`Dockerfile.inspector`, so a project registered today gets a config
Inspector refuses — `src/register/scaffold.ts`'s `inspectorConfigJson`
(its `image` parameter is required; `--network` writes `network: true`),
`src/register/propose.ts`'s `proposeImage`/`proposeNetwork` and the two
lines of its proposal note, `src/register/tools.ts`'s registration check
(runs in `--image`), `src/register/README.md`'s description of the
schema, and `contract/helpers/fixture.ts`'s `FIXTURE_INSPECTOR_CONFIG`
plus the fixture configs in a dozen test files. The three
`src/register/` tests that asserted register writes only keys this
repository's own config uses are skipped by name on master until that
lands, which is where to look for the state of it.
