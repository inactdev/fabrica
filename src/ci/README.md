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
| `unknown` | nothing red, but the wait expired with checks still running | unchanged; the evidence names them |
| `none` | GitHub reported no check at all, even after the grace window | unchanged; the evidence says so |
| `unreadable` | the API could not be read | unchanged; the evidence says why |

Only a concluded red turns a round red. Inventing a red out of a silence
is the same lie as calling it green, read in the other direction — issue
#267's fourth ask ("recorded as unknown, never as green") cuts both ways.

A red *conclusion* is anything in GitHub's own vocabulary that is not
`success`, `neutral` or `skipped`. `skipped` is the repository itself
saying a check does not apply to this change; `neutral` is a check
declining to judge. `cancelled`, `timed_out` and `action_required` are
red: a check that was supposed to answer did not pass. A word this code
has never seen is red too — an answer nobody understands must not read as
a pass.

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
- **A check's identity across ticks is its mechanism plus its name**, not
  its check run id: a re-run answers under a new id, and announcing that
  as a second check would double-count it.
- **One page per endpoint, deliberately.** A commit with more than a
  hundred checks is not a case this is for, and the summary says so
  (`more checks than one page holds, not all read`) rather than reporting
  a partial picture as complete.

## The token

The same one Inspector publishes with, from the same resolver
(`src/inspector/run.ts`'s `resolveGithubToken`, issue #103) — never a
second lookup that could disagree about which credential is in play. It
is only ever placed in a request header: never logged, never on an argv,
never in Fabrica's own process environment. A token that cannot be
resolved is an `unreadable` report, not a thrown error: by the time this
runs the round's work is done and Inspector has already published, so it
must not be lost to a credential problem.

## Testing

`helpers/fake-github.ts` is a real local HTTP server on `127.0.0.1`
answering the exact endpoints this module reads, so the tests exercise the
real client — headers, status codes, the 302 and the blob — without
touching github.com. `helpers/fake-github.ts`'s `fakeClock` drives a whole
expired twenty-minute wait in no real time at all.

No test here reaches the network. `src/foreman/ci-checks.test.ts` covers
the round-level wiring with a fake reader; `src/cli/ci-checks-render.test.ts`
and `integrations/live-view/ci-checks.test.ts` cover the three surfaces.
