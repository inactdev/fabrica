# Issue #306: a project's `.inspector.json` is checked before a task starts

## The plan, written before any change (and what was rejected)

Safest first, then most accurate, then fastest:

1. **One pure function** holding Fabrica's own copy of the config
   refusals the installed Inspector documents today, in Inspector's own
   words, with the Client's own hand fix beside each
   (`src/inspector/config-check.ts`). Reads only; Fabrica never edits
   `.inspector.json` or `Dockerfile.inspector`.
2. **Two callers, one answer**, so the task gate and `fabrica doctor`
   can never disagree about what Inspector would refuse: the round's own
   gate (`src/foreman/inspector-config.ts`, called from
   `judge.ts`'s `prepareRound`) and doctor's per-project line.
3. **The inspector side is filed as its own issue** with the exact
   command shape Fabrica wants, so this local copy can be deleted the
   day Inspector ships the real check. The shape is written out in
   `src/inspector/config-check-issue.md`.

**Where the task gate goes, and the alternative rejected.**
`prepareRound` was chosen over `registerAndAsk` (where issue #304's
publish gate sits). `registerAndAsk` is earlier - ahead of `brain.ask()`
- but it has no ProductionLine, so the only tree it could read is the
Client's own checkout, which legitimately sits on another branch or
mid-edit; a refusal derived from it can be wrong about the commit the
task is actually cut from. `prepareRound` reads the task's exact base
commit - the same `(workdir, baseCommit)` pair `requireReviewer` and
`inspectorIsConfigured` already read - so a false refusal is not
possible, and it is the one chokepoint every round goes through
(`fabrica do`, `fabrica answer`, `fabrica verdict fix`, and a library
caller that never touched the CLI), where `registerAndAsk` would have
covered only a first `fabrica do` round. It still runs before any
machine: `prepareRound` is called before `"work-started"` is appended,
so `fabrica do` prints the refusal and exits 1 exactly as it does for
`cap-refused`.

**Rejected: refusing on every documented config refusal Inspector has.**
Inspector also refuses `ErrNoCheckCommand` (an `.inspector.json` whose
`check` is empty or whitespace) and any config it cannot parse
(`parsing .inspector.json: ...`). The clarification on this issue says
"exactly the refusals the installed Inspector documents today - a
retired image or network key, and no committed Dockerfile.inspector",
and that enumeration is what was built. Both left-out cases are named in
"What is deliberately not checked" below rather than quietly skipped.

**Rejected: adding the config check to `src/inspector/consumer-contract.json`.**
That file pins the call Fabrica makes *today*, and Inspector's own
`TestFabricaConsumerContract` verifies every flag in it is really
accepted - so an entry for a command that does not exist yet would fail
Inspector's suite the moment the sync job carried it over. The shape
belongs in the issue until the command exists; the contract entry is
part of *that* issue's work.

## What Inspector actually documents, read from its own source

Read at `inactdev/inspector` `main` = `a5cf7050` (2026-10-28), files
`internal/inspector/config.go`, `internal/inspector/image.go` and
`internal/inspector/run.go`. Not from prose about them.

- **`"image"`** - `ErrRetiredImageKey`, refused on the key's *presence*,
  whatever its value: the field is `json.RawMessage` precisely so that
  `"image": null` or `"image": false` is still a refusal rather than a
  setting that quietly does nothing. Fabrica's copy therefore tests for
  the key, not for a truthy value.
- **`"network"`** - `ErrRetiredNetworkKey`, same rule, same reason.
- **No `Dockerfile.inspector`** - `ErrNoProjectImage`. The path is
  fixed and has no config key, by Inspector's own ruling: a configurable
  path would be a second way to say the same thing, one its gate could
  not protect by name from the base branch alone.
- **An untracked `Dockerfile.inspector`** - `ErrUncommittedProjectImage`:
  the file is on disk but `git ls-files` does not list it (in practice a
  gitignored one). "No *committed* `Dockerfile.inspector`" covers both,
  so both are checked, and Inspector resolves them in that order.

Inspector checks the config first and the Dockerfile second, so Fabrica
names the same first problem Inspector would rather than a different one.

## What is deliberately not checked, and why that is not a silent skip

- **An empty `check`** (`ErrNoCheckCommand`). Outside the
  clarification's enumeration. `fabrica doctor`'s own per-project line
  already fails a project with neither `.inspector.json` nor `check.sh`,
  and `resolve-check.ts` refuses a self-tested round with no check
  command, so this is a narrow residue rather than an open hole.
- **An `.inspector.json` that is not valid JSON.** The two key checks
  cannot be answered on a file that will not parse, so they are skipped
  for it - the committed-Dockerfile check still runs, since it does not
  depend on parsing anything. This follows the settled precedent in
  `src/inspector/run.ts`'s `declaresTestPaths` ("an unparseable config is
  Inspector's own refusal to make"), and it is why the gate cannot
  produce a false refusal on a file Go and JavaScript might read
  differently.
- **A caller-supplied Inspector.** The gate runs only when the Inspector
  that will judge the round is the one installed on this machine
  (`prepareRound`'s `opts.inspector === undefined`). This is not a test
  convenience: the whole claim being made is "the *installed* Inspector
  would refuse this", and a different Inspector implementation's
  refusals are its own. It is also what keeps the suite's answer the
  same on a machine with Inspector installed and one without.

## Where it ended up

- `src/inspector/config-check.ts` - the refusal list and the two reads
  (a commit's tree, the working tree). Pure answer, no policy.
- `src/foreman/inspector-config.ts` - `requireInspectorConfig`, raising
  `ForemanError("inspector-config-refused")`, called from `judge.ts`'s
  `prepareRound` in the Inspector-mode branch beside `requireReviewer`
  and `Inspector.prepare()`.
- `src/cli/doctor-command.ts`'s `projectCheck` - asked last of its four
  questions, since the three above it decide whether the project can be
  worked at all and a path that is not a repository has no config to
  read. Its `OK` line says "nothing Inspector is known to refuse", not
  "Inspector would accept it": the refusals checked are the ones
  Inspector documents, not the whole of its own validation.
- `src/inspector/config-check-issue.md` - the inspector-side issue, with
  the command shape, exit codes, output and the refusals it must cover.
  **Still to be filed**: a task box has no GitHub credential to open an
  issue with.

## Sharp edges worth knowing

- **`fabrica doctor` reads the working tree, the round reads the base
  commit**, and both are right: doctor is answering "is this project
  configured" about the checkout in front of the Client, while a round
  is answering "will Inspector refuse the commit this task was cut
  from". The reader takes an optional revision for exactly that, the
  same way `declaresTestPaths` does.
- **A commit cannot hold an untracked file**, so the
  `uncommitted-dockerfile` refusal is reachable only from the
  working-tree read. The revision read collapses it into
  `no-dockerfile`, which is what Inspector itself would say about that
  commit.
- **The fixtures still carry the retired `image` key.**
  `contract/helpers/fixture.ts`'s `FIXTURE_INSPECTOR_CONFIG` and the
  inline configs in `src/inspector/run.test.ts`,
  `src/foreman/reviewer.test.ts`, `inspection.test.ts`,
  `task-issue.test.ts`, `ci-checks.test.ts`, `writeup.test.ts`,
  `src/cli/do-command.test.ts` and `src/register/origin.test.ts` all
  name it, and none of them commits a `Dockerfile.inspector`. They are
  harmless (a fake Inspector reads none of it, and the gate is inert for
  a caller-supplied Inspector) and were already named as the last stale
  places in `notes/20261028-do-fabrica-issue-303-as-written-never-ed-ie.md`.
  Left exactly as they are: `contract/helpers/fixture.ts` is a protected
  path, and nothing in this issue asks for them. Two test-local helpers
  did have to bring their projects up to what Inspector accepts, because
  a *doctor* line now reports them - `doctor-command.test.ts`'s
  `healthyProject` and `up-command.test.ts`'s `healthyRecordHome`.
- **The filename is spelled in two modules now.**
  `src/register/dockerfile.ts`'s `DOCKERFILE_INSPECTOR` (the copy the
  *writer* uses) and `config-check.ts`'s `INSPECTOR_DOCKERFILE` (the
  copy the *reader* uses) hold the same string under different names,
  deliberately, so both can be exported through `src/index.ts` without
  colliding. `.inspector.json` is already in the same position
  (`src/inspector/run.ts`'s `INSPECTOR_CONFIG` and
  `src/register/origin.ts`'s own), which is the status quo this follows
  rather than a new duplication - worth collapsing one day, and not on
  this issue's budget.
- **`src/inspector/consumer-contract.json` is already ahead of
  Inspector's copy** (`-vendor`/`-model` are in Fabrica's and not in
  Inspector's `cmd/inspector/testdata/fabrica-consumer-contract.json`),
  noticed while reading Inspector's side. Issue #109's sync job carries
  that across on a push to Fabrica's default branch; nothing here
  touches it.
- **Every round goes through one gate, not four.** Unlike the start
  gates in `registerAndAsk` (issue #304's note §"The same shape,
  elsewhere, left standing"), this one needed no second, third and
  fourth call site - `prepareRound` is the only way into a round. What
  it shares with them is the shape of the problem: `requireReviewer`,
  `Inspector.prepare()` and now `requireInspectorConfig` are three
  by-hand calls in one function with nothing that fails when a fourth
  lands at only some of the places it belongs.
