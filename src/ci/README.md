# `src/ci/` — what the repository's own checks said about the pull request

Issue #267. Fabrica judges a branch with the project's own check, through
Inspector or in the worker's own box. Everything GitHub runs on the pull
request *afterwards* — the protected-path gate, a formatter, a container
rehearsal, `docker-tests` — used to be invisible: no event landed on the
task record when one went red, the worker never heard about it, and
`status`/`watch`/the live view read "delivered" while the pull request
page read red. The only path a failure had to a human was the Client
opening the job on GitHub and pasting its log into a chat.

This module closes that. It is **read-only**: GET requests to GitHub's
REST API and nothing else. Fabrica runs no project check on the host
(issue #64's ruling) and nothing here changes that — it reads results
that already exist, caused by Inspector's own push. Which checks exist
stays the repository's business; nothing here names a check, a workflow
or a provider.

## The shape

```
checks.ts        readPullRequestChecks(prUrl, opts) — the front door
  pull-request.ts  which URLs are addressable over the API at all
  poll.ts          WHEN to read, and when to stop
    read.ts        one function per documented endpoint
    latest.ts      WHICH run of a check answers for it
    logs.ts        a red check's own job log, when the API serves one
    conclusions.ts reading GitHub's two vocabularies
  report.ts      how a read is said — one phrase, and the full output
github.ts        the thin GET client (headers, timeouts, the 302)
errors.ts        CiError — caught by poll.ts, never thrown at a round
```

Nothing here writes to the record. `src/foreman/ci-checks.ts` does, the
same way `src/foreman/inspection.ts` — and not the `Inspector` adapter —
records Inspector's own call. That split is not cosmetic: it is what
makes "a round records one event per concluded check" a property of the
system rather than a property of whichever reader happens to be
installed. A test fakes the read; it cannot fake the recording.

## Where it is wired in, and why there

`src/foreman/judge.ts`'s `inspectorJudge`, immediately after
`handToInspector` returns a **green** verdict that carried a `prUrl`. The
read's result becomes part of that attempt's own `Judgement`, so
everything downstream already works unchanged: a red one flips the gate
to red carrying the checks' output, `roundOutcome` yields
`inspection-red`, `buildDelivery` puts the output in `delivery.evidence`,
`attempts.ts`'s `correctionBrief` hands it to the next counted attempt,
and `deliveredState` puts the task in front of the Client for a verdict.

A red or refused inspection published nothing, so there is no pull
request whose checks could say anything about that attempt — it is never
read. Neither is a green run that opened nothing (no URL on Inspector's
stdout).

Polling *after* the delivery was written was considered and rejected:
every reader in `queries.ts`, `render.ts` and `record-view.ts` takes the
latest `"delivered"` event as the round's result, so a post-delivery red
would have to append a second one for the same round. The task would
read green-delivered and then flip, and `fabrica await`/the review page
could fire on the first. See `notes/` for the full comparison.

## The verdicts, and what each one does to the round

| verdict | means | the round |
| --- | --- | --- |
| `green` | at least one check concluded, none red | unchanged; the evidence says so |
| `red` | at least one concluded check is red | **red delivery**, output attached |
| `unknown` | nothing red, but the wait expired with a check that never answered — still running, or cancelled with no newer run yet (issue #348) | unchanged; the evidence names them |
| `none` | GitHub reported no check at all, even after the grace window | unchanged; the evidence says so |
| `unreadable` | the API could not be read | unchanged; the evidence says why |

Only a concluded red turns a round red. Inventing a red out of a silence
is the same lie as calling it green, read in the other direction — issue
#267's fourth ask ("recorded as unknown, never as green") cuts both ways.

A red *conclusion* is anything in GitHub's own vocabulary that is not
`success`, `neutral` or `skipped`. `skipped` is the repository itself
saying a check does not apply to this change; `neutral` is a check
declining to judge. `timed_out` and `action_required` are red: a check
that was supposed to answer did not pass. A word this code has never seen
is red too — an answer nobody understands must not read as a pass.

`cancelled` is the one conclusion that is neither (issue #348) — see
below.

## Which run of a check answers for it (issue #348)

One commit can carry several check runs of the same name, and reading
each on its own terms gets the answer wrong. The ordinary cause is a
workflow with `concurrency: cancel-in-progress` triggered on `opened`,
`synchronize` and `edited`: every push and every description edit starts
a fresh run and stops the one before it, so the commit ends up holding
two or three `cancelled` runs of a check plus the one that finished.
Fabrica used to call that check red while the pull request page showed it
green — and spend a whole extra attempt handing a Worker a failure with
nothing in it to fix.

Two rules, in `latest.ts`, fixed for every project:

1. **A cancelled run is not a result.** Dropped before anything is
   judged: never read as red, never read as green.
2. **The newest remaining run of a check is its answer** — which is also
   what GitHub's own pull request page shows for it, and what its
   required-status-check settings judge.

A check whose every run on this commit was cancelled therefore has no
answer yet, and lands in `unresolved` with GitHub's own word
(`cancelled`) as its status: the poll keeps waiting for the newer run,
and if the wait expires with still nothing the verdict is `unknown` —
never red, and so never a retry. That is deliberately the bucket this
already had for "nobody answered"; a fourth `ChecksVerdict` would have
meant a new case in every surface that renders a report, for a state
meaning exactly what `unknown` already means.

`filter=latest` on the endpoint does **not** do this for us, whatever
the name suggests — see the sharp edge below. Commit statuses need none
of it: the combined-status endpoint already resolves to the latest status
per context, and a commit status has no cancelled state to begin with
(its documented states are `error`, `failure`, `pending`, `success`).

### Whether a red check starts another attempt is a project's setting

`projects.toml`'s `retryOnRedChecks` (issue #348), resolved once per
round by `src/foreman/ci-checks.ts`'s `retryOnRedChecksFor`. On unless a
project turns it off, which is what every project did before it existed.
Off, the round still delivers red with the checks' own output for the
Client's verdict — what stops is Fabrica spending a correcting attempt on
it by itself. Nothing in this module reads the setting: a report says
what the checks said, and what a round does about it is
`src/foreman/`'s business.

## The three bounds, and why they are different numbers

- `DEFAULT_CHECKS_WAIT_MS` (20 min) — the whole wait. Sized to a real
  repository's CI, not to anything Fabrica does: this project's own
  `docker-tests` job runs the full suite and a container rehearsal is
  slower still.
- `DEFAULT_CHECKS_APPEAR_MS` (1 min) — how long "GitHub reports no checks
  at all" is read as "they have not registered yet" rather than "this
  repository has no CI". A repository with no workflows must not cost
  every task twenty idle minutes. **Deliberately a different order of
  magnitude** from the wait; do not harmonize them, they answer different
  questions.
- `MAX_LOGS_FETCHED` (3) and `MAX_LOG_TAIL_BYTES` (8 KiB) — a log lands in
  the append-only record and in the next attempt's brief, so the whole of
  a verbose job cannot be stored. Whatever either of these cuts is named
  out loud in the summary; a silently partial report reads as the whole
  picture.

`DEFAULT_CHECKS_POLL_INTERVAL_MS` matches `attempts.ts`'s heartbeat
interval, so one poll tick and one liveness tick cost one wake-up between
them, and the whole wait stays at a couple of hundred requests —
comfortably inside GitHub's hourly quota.

## Sharp edges, verified against GitHub's current REST reference (2026-10-22)

- **The log download answers 302, to a link that expires after a minute.**
  Node's `fetch` follows redirects by default and would carry the
  `Authorization` header to the blob host it points at — handing a
  third-party host a GitHub token, and sending a header that host does
  not expect. `github.ts`'s `redirectText` uses `redirect: "manual"` and
  fetches the `Location` separately, with no headers of ours at all.
  `poll.test.ts` proves the blob request carries none.
- **There is no documented way from a check run to its Actions job id.**
  The documented link runs the other way: a job carries `check_run_url`.
  So `logs.ts` lists the head commit's workflow runs (`?head_sha=`), lists
  each run's jobs, and matches `check_run_url`'s trailing id against the
  red check run's own id. Parsing a job id out of a check run's
  `details_url` would be one call instead of two, but that URL's shape is
  documented nowhere, so it is not used.
- **A log is fetched the moment its check is first seen red**, not once at
  the end — both so the one event the record carries for that check
  already has the log on it, and because the download link expires in a
  minute and the end of a twenty-minute wait is a long way from the moment
  the job finished.
- **The combined-status endpoint already resolves to the latest status per
  context**, so a commit's whole status history is never paged back
  through. The same documented fact `.github/workflows/rule9-gate.yml`'s
  two jobs already lean on.
- **`filter=latest` does not collapse two runs of the same check name.**
  GitHub documents it as no more than "Filters check runs by their
  completed_at timestamp. latest returns the most recent check runs",
  which says nothing about collapsing per *name* — and issue #348 is the
  empirical proof that it does not: one commit carried two `cancelled`
  runs of a check and a later `success` run of the same check, and all
  three arrived here. Each workflow run opens its own check suite, which
  is the level `latest` appears to work at. It is still passed
  explicitly, as the cheapest narrowing available; the per-name reduction
  is `latest.ts`'s.
- **Nothing documented orders two runs of a check except `started_at`.**
  `completed_at` is null for the run that has not finished — exactly the
  case that matters — and `id`, though newer in practice, is documented
  nowhere as monotonic. So `latest.ts` orders on `started_at`, breaks a
  tie on the larger `id`, and breaks a remaining tie by preferring a run
  that answered and then a red answer over a green one: a tie must never
  resolve into a pass by accident, and the answer must not depend on the
  order GitHub happened to list them in.
- **Named limit: two genuinely different checks that share one name read
  as one check.** The reduction groups by name, because "the newest run
  of that check" is a rule written in names and a name is what every
  surface here already identifies a check by — and because nothing a
  check run carries separates "this check ran again" from "a different
  check happens to share this name": each workflow run opens its own
  check suite in both cases. So on a commit where two unrelated
  workflows each post a check called `build`, only the newer of the two
  answers, and a red older one is not reported. Stated rather than
  guarded, because there is no field to guard it with; keeping check
  names distinct is the repository's own business, and this project's own
  jobs are uniquely named. The direction of the remaining risk is the
  reason the tie-breaks below exist at all.
- **Nothing is ever promoted by missing data.** A run GitHub reported no
  `started_at` and no `id` for sorts as the oldest run in its group,
  whatever colour it is — so a real failure is never replaced by an
  unplaceable pass, and an unplaceable failure never displaces a run
  GitHub actually placed. `latest.test.ts` holds both directions.
- **A check's identity across ticks is its mechanism, its name and its
  answer**, not its check run id: a re-run answers under a new id, and
  announcing that as a second check would double-count it. The answer is
  part of it since issue #348, because a check's answer can genuinely
  change between ticks now — a newer run lands and replaces what the
  older one said — and the record must not keep the first answer while
  the round's own summary reports the second.
- **One page per endpoint, deliberately.** A commit with more than a
  hundred checks is not a case this is for, and the summary says so
  (`more checks than one page holds, not all read`) rather than reporting
  a partial picture as complete.

## The token

A GitHub App installation token minted for **this pull request's own
repository** — the repository the branch was pushed to, read off the
pull request URL rather than from the project — with only the four
read permissions these endpoints need (issue #187;
`src/githubapp/scopes.ts`'s `READ_CHECKS_PERMISSIONS`: `pull_requests`,
`checks`, `statuses`, `actions`). Nothing here can write, and the token
cannot either.

This module never resolves it: `ReadChecksOptions.mintToken` is asked
for one once the repository is known, and `src/foreman/ci-checks.ts`'s
`defaultChecksReader` is what supplies that — so the mint lands on the
task's record (`"token-minted"`) where no fake can skip it. One token
for the whole poll rather than one per tick: an installation token lives
an hour and the bounded wait is twenty minutes, so a mint per tick would
be a hundred extra API calls and a hundred extra record entries for a
scope that is identical every time.

It is only ever placed in a request header: never logged, never on an
argv, never in Fabrica's own process environment. A token that cannot be
minted at all is an `unreadable` report, not a thrown error: by the time
this runs the round's work is done and Inspector has already published
through the same App, so it must not be lost to a credential problem.

## Testing

`helpers/fake-github.ts` is a real local HTTP server on `127.0.0.1`
answering the exact endpoints this module reads, so the tests exercise the
real client — headers, status codes, the 302 and the blob — without
touching github.com. `helpers/fake-github.ts`'s `fakeClock` drives a whole
expired twenty-minute wait in no real time at all.

No test here reaches the network. `src/foreman/ci-checks.test.ts` covers
the round-level wiring with a fake reader; `src/cli/ci-checks-render.test.ts`
and `integrations/live-view/ci-checks.test.ts` cover the three surfaces.
