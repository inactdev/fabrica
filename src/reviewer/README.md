# Who reviews a project's test changes

Inspector's run judges a change's *test* edits with a model of its own,
named by `-vendor`/`-model` and paid for with that vendor's own key.
Fabrica configures it. This module is the whole of "which model, and is
that settled enough to hand Inspector anything at all".

## The standing ruling: the reviewer is never the worker's vendor

A reviewer drawn from the same vendor as the Worker is not a second
opinion. It is the same house marking its own homework one step
removed - which is the thing an independent inspection exists to
prevent. So this is **enforced in code**, not written down and hoped
for: a `[reviewer]` naming the Worker's own vendor refuses, naming both,
before Inspector is called at all.

Fabrica is the side that can enforce it, because Fabrica is the side
that knows which vendor the Worker is. That fact comes from
`workerVendor()` in `src/brain/adapters/` - the only directory anywhere
under `src/` allowed to name a vendor (CONTRACT rule 8). Everything in
this module compares vendor names as opaque strings, trimmed and
case-insensitively, so the Client's spelling in `projects.toml` and the
adapter's own spelling can't disagree over capitalisation.

`workerVendor` reports the *selected adapter's nominal vendor*. A
direct-API worker pointed at some other compatible base URL still
reports that adapter's own default vendor, because nothing in a base URL
reliably names the company behind it. Worth knowing before trusting the
collision check to catch an exotic setup.

## Configuring one

One global table in `projects.toml`, optionally overridden per project:

    [reviewer]
    vendor = "<the reviewing vendor>"
    model  = "<that vendor's model>"

    [projects.spending-app.reviewer]
    vendor = "<a different one, just for this project>"
    model  = "<that vendor's model>"

The project's own table wins, **outright** - not field by field. A
project that names a reviewer names both fields, so reading one entry
always answers "who reviews this project" without a second lookup. Half
a reviewer (a vendor with no model, or the reverse) is refused at load
time rather than quietly ignored, which would hide a typo behind "no
reviewer configured".

The credential is `<VENDOR>_API_KEY` - the spelling Inspector itself
reads, derived by upper-casing the vendor rather than tabulated, so a
vendor Fabrica has never heard of works exactly like any other. It is
read from Fabrica's own environment first, then from
`<recordHome>/brain.env`, the same 600-mode file the Worker's own token
already lives in and with the same precedence. `<VENDOR>_BASE_URL` is
read the same way and **forwarded when set, never required**: Inspector
reads it for any vendor other than its own default and will name it
itself if it turns out to need it, and guessing which vendors do would
be Fabrica inventing a vendor table it has no business holding.

## The three refusals, and where they fire

`resolveReviewer()` answers `none`, `reviewer`, or `refused`. It refuses
when:

1. the project's `.inspector.json` declares `testPaths` - asking for its
   test changes to be judged - and no `[reviewer]` is configured at all;
2. a reviewer is configured whose vendor is the Worker's own;
3. a reviewer is configured and its `<VENDOR>_API_KEY` is nowhere to be
   found (or `brain.env` is readable by other users on the machine,
   which is its own refusal in its own words and never quietly read as
   "no key").

Grounds 2 and 3 apply to a configured reviewer **whether or not**
`testPaths` is declared. That is not over-strictness: a configured
reviewer is passed to Inspector on every call, so a configured reviewer
that cannot work is a configuration that cannot work. `testPaths` is
what makes a reviewer *required*, not what makes one *usable*.

The same function answers for both call sites, so they can never
disagree about what counts as configured:

- `fabrica do` (`src/cli/do-command.ts`) asks before anything is
  registered and before any money is spent, reading `testPaths` from
  **origin's default branch** - the commit a task is actually cut from,
  never the Client's local checkout.
- the round itself (`src/foreman/reviewer.ts`, called from
  `prepareRound`) asks again just before Inspector is handed anything,
  reading `testPaths` at the task's **base commit** - never the worktree
  a Worker has already had its hands on, so a Worker cannot add or drop
  `testPaths` and change who reviews its own work. A refusal here is
  `ForemanError("reviewer-not-ready")`, so a resumed round, a fix round,
  and a library caller that never went through the CLI all stop on the
  same three grounds the Client saw up front.

## Why this is its own module

Settling a reviewer needs the Worker's vendor and the record home's
credential file, so it depends on `src/brain`. `src/inspector` has no
business depending on brains at all - it takes only the
`ResolvedReviewer` type from here, erased at compile time. The flags and
the credential are put on the Inspector call in
`src/inspector/run.ts`; `src/inspector/consumer-contract.json` is where
the two flag names are ratified and synced to Inspector's own copy.
