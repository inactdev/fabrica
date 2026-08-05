# The Foreman

`src/foreman/` is the real implementation behind `createForeman` in
`contract/surface.ts` (issue #7, "the loop: `fabrica do`"). It is the
delegator LANGUAGE.md calls the Foreman: it registers a task, cuts a
ProductionLine, runs a Worker for a counted number of attempts, verifies
the result with the project's own check, and writes a delivery — wiring
`src/record`, `src/line`, `src/brain`, and `src/config` into the one loop
SPEC.md calls "fabrica do". It is pure code: it delegates and counts, it
never decides anything a model should decide instead.

## `createForeman({ recordHome, caps? })`

```ts
const foreman = createForeman({ recordHome: "/Users/ari/.fabrica" });
```

- **`recordHome`** — where the record lives (`src/record/README.md`). Every
  task this Foreman touches reads and writes under here; nothing in this
  module ever falls back to a fixed default path.
- **`caps`** — `{ perTaskUsd?, perDayUsd? }`. Accepted so this factory's
  shape matches `contract/surface.ts`'s `createForeman` exactly. Not
  enforced here: CONTRACT rule 10 ("It cannot outspend you") is issue
  #11's job, not this loop's. Passing it today has no effect; omitting it
  has no effect either.

The return value satisfies `Foreman`: `do`, `deliveryOf`, `receiptsOf`,
`status`, `events`, `recordPath`, and a `verdict` stub (see "What's
deliberately still a stub" below).

## `do(taskText, { project, attempts?, brain? })`

One call runs the whole loop to completion — register, cut, work, check,
possibly retry, deliver, tear down — and only then resolves. That is a
deliberate simplification, not an oversight: see "Why `do()` doesn't
return early" below.

1. **Registers** the task via `src/record`'s `registerTask`: a new
   `taskId`, `request.md` written verbatim, a `task-received` event.
   `brief.md` is written too, identical to the request — v1 never asks a
   clarifying question (see "The ask-first seam" below), so there are no
   answers yet to fold in.
2. **Cuts a ProductionLine** via `src/line`'s `createProductionLine`,
   passing `project` straight through as a filesystem path — the root of
   the Client's own git checkout. The Client's checkout is never written
   to (CONTRACT rule 1); everything from here on happens in the
   ProductionLine's `workdir`.
3. **Resolves the check command** (`resolve-check.ts`) and refuses before
   any Worker runs if there isn't one (`check.ts`'s `requireCheckCommand`)
   — CONTRACT rule 2 allows no path around the gate, so a task with
   nothing to verify against is refused up front, not after burning a
   Worker call on it.
4. **Runs the attempt loop** (`attempts.ts`): calls `brain.work(...)`,
   then runs the check, for up to `attempts` rounds. See "How `attempts`
   actually behaves" below — it is not simply "retry until green."
5. **Checks for an undeclared gate change** (`gate-changes.ts`) — CONTRACT
   rule 9. If the check script changed and nothing declared it, the whole
   attempt is discarded regardless of whether the check went green.
6. **Writes the delivery** (`delivery.ts`): `delivery.md` for a human to
   read, and the same structured `Delivery` object on the `"delivered"`
   event for `deliveryOf` to read back exactly.
7. **Destroys the ProductionLine** in every case — success, failure, or a
   thrown error — via a single `finally`.

### `project`

Always a filesystem path to the root of a git repository — the same
thing `createProductionLine` expects. SPEC.md's CLI describes `--project
<path-or-name>`; the "or-name" half (looking a registered project up by
name in `projects.toml`) is a CLI-layer concern nothing has built yet,
not something this function does. `resolve-check.ts` does something
related but different: it looks a *path* up in `projects.toml` to find
that project's configured check command (see below) — it never treats
`project` itself as anything but a path.

### `attempts`

Example: `fabrica.do("fix the flaky test", { project, attempts: 3, brain })`.

Omit it and the default is 2 — SPEC.md's step 5: one attempt, and on red
one fix pass with the failure output, then re-check. Still red after
that is a failure report, never "done" (CONTRACT rule 2).

Give an explicit number and the loop runs *exactly* that many attempts,
full stop — even if an earlier attempt's check already went green. That
is CONTRACT rule 3, "three means three," taken literally: a number given
is a number honored, not a ceiling the code is free to cut short because
it decided the work already looked done. `rule3.n-means-n.test.ts` proves
this with a project whose check is *always* green, specifically to rule
out "it just happened to need that many tries" as an explanation.

So there are two policies, chosen by one thing — whether the caller gave
a number:

| `attempts` | Stops early on green? | Why |
| --- | --- | --- |
| omitted (default 2) | yes | SPEC.md's real, cost-conscious default: don't burn a second Worker call on a task that already passed. |
| given explicitly | no | CONTRACT rule 3: an explicit count is a promise, not a hint. |

An explicit `attempts` that isn't a positive integer is refused up front
(`ForemanError("invalid-attempts")`), before any task is registered or
line cut.

### `brain`

Required — v1 has no default adapter to fall back on yet (issue #6 builds
the first real one). Omitting it raises `ForemanError("no-brain")` before
anything else happens.

## Why `check.sh`, not only config

CONTRACT rule 2 needs *a* check command for every task, but every
contract test hands `do()` a bare filesystem path with no `projects.toml`
anywhere — there is no name to look up. `resolve-check.ts` resolves this
with one rule: if `projects.toml` at `recordHome` registers a project
whose `path` matches this ProductionLine's project (after both sides are
resolved through `realpath` — see the sharp-edge note in that file's
comment, and in the project's own root agent-memory file), that
project's configured `check` command wins. Otherwise it falls back to the v1 default convention: an
executable `check.sh` at the project's root, run as `./check.sh -> exit
N`.

```toml
# recordHome/projects.toml
[projects.spending-app]
path  = "/Users/ari/inkling-umbrella/spending-app"
check = "bin/ci"
```

A task run against that exact path gets `bin/ci` as its check command; a
task run against any other path (every contract test's throwaway fixture
repos, or an ad hoc path before it's ever registered) gets the
`check.sh` convention. Nothing about how `do()` runs changes between the
two — only which command `runCheck` executes.

## What CONTRACT rule 9 protects, and what it doesn't yet

`gate-changes.ts` snapshots `check.sh`'s content the moment the
ProductionLine is cut, and compares it again after the attempt loop.
Differ with no `gateChanges` declared on any attempt, and the outcome is
forced to `"discarded-protected-path"` — overriding even a green check,
exactly as CONTRACT rule 9 requires ("no matter how good the result
looks").

**Known v1 limitation:** this protection only applies when the check
command in use is the `check.sh` convention above. A project registered
with a custom `check` command (`bin/ci`, `npm test`, …) has no single
file this module knows to watch, so an undeclared change to *that*
project's real checks isn't caught yet. This is a real, documented gap,
not a silent one — closing it needs a way for a registered project to
say which paths are its "ratified tests and check settings," which
doesn't exist yet.

## Why `do()` doesn't return early

SPEC.md describes `fabrica do` as detached: it prints the task id and
returns immediately while work continues in the background, streaming to
the transcript. This module's `do()` does not do that — it runs the
whole loop to completion before resolving.

That's deliberate, not a shortcut taken by accident: every contract test
calls `await fabrica.do(...)` and immediately inspects `deliveryOf` and
`receiptsOf`, which only makes sense if the delivery already exists by
the time the promise resolves. "Detached" is a property of the CLI a
Client types at — spawning the loop in a background process and
returning control to the shell right away — not a property this
programmatic seam can have while staying testable synchronously. No CLI
exists yet to make that distinction concrete; when one is built, it can
wrap this same `do()` in whatever backgrounding mechanism it needs
without reshaping anything here.

## The ask-first seam

SPEC.md step 2 says v1's default is to ask a clarifying question before
working on a materially ambiguous task. This module always proceeds
straight to work instead. Two things make that the honest choice for
now, not a corner cut:

- The `Brain` interface (`src/brain/README.md`) has no way for a Worker
  to hand back "I have questions" instead of doing work — only a
  transcript, an optional gate declaration, and an optional session id.
  There is nothing to route yet.
- `rule5.total-recall.test.ts`'s expected event order —
  `task-received`, `work-started`, `check-run`, `delivered` — has no
  `questions-asked` step in it. The loop as ratified today goes straight
  through.

`brief.md` is written on every task regardless — see the comment above
the `writeTaskFile` call in `do.ts` for the full reasoning, which is two
complementary halves. `fabrica answer` (issue #8) is why it's written
*now*, upfront: so a clarify round only has to append to `answers.md` and
re-derive `brief.md`, instead of creating the file itself. Per-project
lessons (issue #19) are why it must be *stored* rather than derived on
demand later: once lessons get primed into it, `brief.md` becomes the
record of what was actually handed to a Worker, not a cache of
`request.md` — material `request.md` + `answers.md` can no longer
reconstruct on their own, because lessons change over time. Today the two
files are byte-identical, because v1 does neither yet.

## Why receipts and deliveries live on `events.jsonl`, not their own file

`src/record`'s `TaskFile` union has no slot for a Delivery object or a
list of Receipts — only markdown/text files a person reads
(`delivery.md`, `transcript.log`, …). Rather than invent a place to store
structured data outside the record, `do()` puts the whole `Delivery`
object and the full `Receipt[]` array straight into the `"delivered"`
event's `details` field. `deliveryOf` and `receiptsOf` (`queries.ts`)
read that one event back and return its `details.delivery` /
`details.receipts` directly — no markdown parsing, no second source of
truth. `delivery.md` still gets written, as a human-readable rendering of
the exact same object, matching the same "events.jsonl is authoritative;
everything else is a convenience view of it" design `src/record/README.md`
already documents for `brief.md`.

One consequence: the last attempt's `Receipt.outcome` can't be decided
until *after* the attempt loop and the rule-9 gate check both finish (an
attempt that looked "delivered" the moment its check went green can still
turn into `"discarded-protected-path"` a moment later). Since
`events.jsonl` is append-only, that receipt can't be corrected in place —
so `do()` computes every receipt's final `outcome` before it ever calls
`appendEvent`, and logs the whole batch once, on the single `"delivered"`
event, already correct.

## What's deliberately still a stub

`verdict()` throws `ForemanError("not-built")`. CONTRACT rule 6 ("You get
the last word") is issue #10's job — recording a ruling and closing the
loop on it. `status()`'s state derivation already leaves room for it
(`"closed"` once a `"verdict-recorded"` event exists), but this module
doesn't write that event or interpret one; that's left to whoever builds
#10, including a sibling lane that may already be working on it.

## Files

| File | Holds |
| --- | --- |
| `types.ts` | `GateResult`, `Receipt`, `Delivery`, `FabricaTask` — matched by hand to `contract/surface.ts`, same pattern as `src/record/types.ts`'s `FabricaEvent`. |
| `errors.ts` | `ForemanError`, with codes `no-brain`, `invalid-attempts`, `missing-check`, `not-built`. |
| `check.ts` | Runs the check command; refuses up front when the `check.sh` convention applies and there's no script. |
| `resolve-check.ts` | Picks the check command: a registered project's `check`, or the `check.sh` convention. |
| `gate-changes.ts` | Snapshots and compares `check.sh`, for rule 9's undeclared-change detection. |
| `attempts.ts` | The counted retry loop; builds each correction brief from the previous check's failure output. |
| `files.ts` | Lists files a Worker touched (`git status --porcelain`), for the delivery's `files` field. |
| `delivery.ts` | Builds the `Delivery` object and its `delivery.md` rendering. |
| `do.ts` | `doTask` — the orchestration described above. |
| `queries.ts` | `deliveryOf`, `receiptsOf`, `eventsOf`, `statusOf` — all read from `events.jsonl`. |
| `foreman.ts` | `createForeman` — assembles the above into the `Foreman` shape. |
