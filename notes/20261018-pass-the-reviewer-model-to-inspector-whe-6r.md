# The reviewer Inspector judges test changes with

Inspector's `run` command judges a change's *test* edits with a model of
its own (`--vendor`/`--model`, keyed off `<VENDOR>_API_KEY`, with
`<VENDOR>_BASE_URL` read too for any vendor other than its default).
Fabrica now configures that model, because Fabrica is the side that
knows which vendor the Worker already is — and the standing ruling is
that **the reviewer must never be the Worker's own vendor**. A reviewer
drawn from the same vendor as the Worker is not an independent second
opinion; it is the same model marking its own homework one step
removed, which is the whole thing Inspector exists to prevent.

## Where each piece lives, and why

- **`[reviewer]` in `projects.toml`** (`src/config/load.ts`,
  `ReviewerConfig` in `src/config/types.ts`) — one global table
  (`vendor`, `model`, both required strings), with an optional
  `[projects.<name>.reviewer]` that overrides it wholesale for that
  project. Project wins; the override is all-or-nothing (both fields
  again) rather than field-by-field, so reading one entry always
  answers "who reviews this project" without a second lookup.
- **`src/reviewer/resolve.ts`** resolves it: picks the table, derives
  `<VENDOR>_API_KEY`/`<VENDOR>_BASE_URL` by upper-casing the vendor,
  reads them from Fabrica's environment first and then
  `<recordHome>/brain.env`, and returns one of three answers —
  `none` (nothing configured and nothing required), `reviewer`, or
  `refused` with the Client-facing message. One function, three
  refusals (no table while `.inspector.json` declares `testPaths`; no
  API key for the named vendor; reviewer vendor equals the Worker's),
  so the two call sites below can never disagree about what counts as
  configured.
- **`workerVendor()` in `src/brain/adapters/index.ts`** — the vendor
  comparison needs a vendor *name*, and CONTRACT rule 8 allows exactly
  one directory anywhere under `src/` to name one. `Brain.name` is the
  adapter's name ("claude-code"), not a vendor, and widening the
  ratified `Brain` interface to carry a vendor was not an option worth
  taking for this. So the adapters directory answers "which vendor is
  the selected Worker" and everything else compares opaque strings.
  Known limit: it reports the selected adapter's *nominal* vendor, so
  the direct-API adapter pointed at a custom base URL still reports its
  own default vendor.
- **Two call sites, one implementation.** `fabrica do`
  (`src/cli/do-command.ts`) refuses up front, before anything is
  registered and before any money is spent, exactly where an unset-up
  project is already refused — `testPaths` is read from **origin's
  default branch**, the commit a task is actually cut from, never the
  Client's local checkout (same reasoning as
  `inspectorConfiguredOnOrigin`). `prepareRound`
  (`src/foreman/judge.ts`) refuses again, from the worktree at the
  task's base commit, so a resumed round, a fix round, and the library
  entry point can't hand Inspector a configuration that cannot work.

## Decisions worth not re-litigating

- **The flags go on every Inspector call once a reviewer is
  configured**, not only when `.inspector.json` declares `testPaths`.
  `testPaths` is what makes a reviewer *required*; it is not what makes
  one *usable*. Conditioning the flags on it too would mean Fabrica
  re-reading and re-parsing the config blob at call time to decide
  argv, for no behavioral gain — Inspector ignores a reviewer it has
  nothing to judge.
- **`<VENDOR>_BASE_URL` is forwarded when set and never required.**
  Inspector reads it for any vendor other than its own default, and the
  standing ruling guarantees the reviewer is some *other* vendor than
  the Worker's — so a reviewer that works at all is usually one that
  needs it. Fabrica does not refuse on its absence: Inspector names the
  variable itself if it turns out to need it, and guessing which
  vendors do would be Fabrica inventing a vendor table it has no
  business holding.
- **Rejected: resolving the reviewer once in `createForeman` and
  passing a ready-made Inspector down.** It reads cleaner, but it would
  move the refusal to Foreman-construction time — which happens in
  `fabrica status`, `fabrica log`, the live view, and every contract
  test — so a half-configured reviewer would break commands that never
  call Inspector at all. Resolving inside `prepareRound`, from
  `recordHome` + `line.project`, keeps the refusal on the one path that
  actually hands work to Inspector, and mirrors how
  `resolveCheckCommand` already finds a project's own settings from
  exactly those two values.
- **`src/reviewer/` is its own module, not a file under
  `src/inspector/`.** Settling a reviewer needs the Worker's vendor and
  the record home's credential file, so it depends on `src/brain` —
  and `src/inspector` has no business depending on brains at all. The
  dependency only runs one way now: `src/inspector/run.ts` takes the
  `ResolvedReviewer` *type*, erased at compile time, and nothing else.
- **`consumer-contract.json` gains the two flags and nothing else.**
  The credential variable is Inspector's own read, not an argument
  Fabrica passes, and the sync job replaces Inspector's copy wholesale
  — the smallest change that keeps both sides in step is the one least
  likely to trip the other side's parser.

## Where this met master, when it was rebased

Three places needed both sides kept rather than one chosen, and all
three are the kind that a "take theirs" resolution would quietly break:

- **`projects.toml`'s global tables are now three, not two.** The
  unknown-top-level-table refusal names them in one sentence (`[caps]`,
  `[pause]`, `[reviewer]`); a new global table has to be added to that
  message as well as to the destructure at the top of `loadConfig`, or
  it is reported to the Client as a stale project to rename.
- **`FabricaConfig.pause` is required, so every empty-config literal
  carries `DEFAULT_PAUSE_RULE`.** There are three of them
  (`load.ts`'s `loadConfigOrProblem`, `src/cli/load-config.ts`'s
  `loadConfigOrDefault`, `src/foreman/reviewer.ts`'s
  `configOrDefault`); a fourth caller that needs "no config, not an
  error" belongs with those, spread from the same constant.
- **Inspector's argv order is `-repo -branch -expected-tip -vendor
  -model -pr-title -pr-body-file`.** Flags are independent to
  Inspector, but `run.test.ts` asserts the whole echoed argv as one
  string, so a reordering is a test failure rather than a silent
  change — which is the point.

## A new flag is only half a change until the binary is new enough

`src/inspector/consumer-contract.json` keeps Fabrica's and Inspector's
*source* in step. It says nothing about the Inspector **installed on the
machine**, and Go's flag package refuses an unknown flag outright rather
than ignoring it:

    flag provided but not defined: -expected-tip
    usage: inspector [flags] [claim text...]

followed by the installed build's own flag list. That is a refusal, not
a red report - nothing about the work was judged - and the fix is
upstream of this repository: update the installed binary. Read the
printed flag list before touching anything here; the flag missing from
it is the one the installed build predates. Removing the flag from
`run.ts` to make the refusal go away would un-ship whichever feature
added it and silently reopen whatever it was protecting against (for
`-expected-tip`, publishing a rewritten branch without a lease).

`fabrica doctor`'s Inspector check reports which build is installed,
which is where to look first when a call that works in the tests is
refused on the machine.
