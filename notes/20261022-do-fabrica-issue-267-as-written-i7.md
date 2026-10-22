# Pulling a pull request's CI results onto the record (issue #267)

## The design chosen, and the one rejected

**Chosen:** a standalone read-only module, `src/ci/`, that reads a pull
request's published check runs and commit statuses over the GitHub REST
API, wired into `src/foreman/judge.ts`'s `inspectorJudge` at exactly one
point: right after `handToInspector` returns a *green* verdict that
carried a `prUrl`. The poll's result becomes part of that attempt's own
`Judgement` - a red one flips the gate to red, carrying the checks'
output - so everything downstream already works unchanged:
`roundOutcome` yields `inspection-red`, `buildDelivery` puts the output
in `delivery.evidence`, `attempts.ts`'s `correctionBrief` hands it to the
next counted attempt, and `deliveredState` puts the task in front of the
Client for a verdict.

Safest first: every call is a GET, the token is never logged nor placed
on an argv, the log download's redirect is followed by hand so the token
is never sent to the blob host it points at, the wait is bounded, and
every failure mode (unreadable API, no token, a check that never
concludes) is recorded as itself and never as green. Accuracy next: the
delivery's own summary says "the pull request's own checks went red",
never "Inspector reported red", because Inspector said green. Speed
last: one `pulls/{n}` read plus two reads per poll tick, nothing
fetched per check unless that check is red.

**Rejected:** polling *after* the delivery was written - either at the
end of `round.ts`'s `recordRoundResult` or from a separate follower
process (`fabrica watch`, the live view). It would satisfy "record the
events" but not "the delivery becomes a red delivery with the check
output attached": every reader in `queries.ts`, `render.ts` and
`record-view.ts` takes the *latest* `"delivered"` event as the round's
result, so a post-delivery red would have to append a second one for the
same round - the task would read green-delivered and then flip, and
`fabrica await`/the review page could fire on the first. A separate
follower would additionally need its own token handling, its own
liveness, and would poll for tasks nobody is waiting on. Doing it inside
the judge keeps one round = one delivery and needs no new process.

**Also rejected:** shelling out to `gh` for the API. `src/foreman` may
spawn nothing but `git` (`no-host-check.test.ts`), `gh` need not be
installed, and Node's own `fetch` needs no dependency.

## What the module does and does not decide

- Which checks exist is the repository's business (issue #267's own
  non-goal). `src/ci/` names no check and no workflow; it reads whatever
  GitHub reports for the head commit.
- Fabrica still runs no project check on the host (issue #64). This
  module executes nothing - it reads results.
- A red *conclusion* is anything in GitHub's own vocabulary that is not
  `success`, `neutral` or `skipped`: `failure`, `cancelled`,
  `timed_out`, `action_required` for a check run, `error`/`failure` for a
  commit status. `neutral`/`skipped` are deliberately not red - a
  skipped job is the repository saying this check does not apply here.
- A check still `queued`/`in_progress`/`pending` when the wait expires is
  recorded as unknown on the summary event, never as green, and it does
  not turn the delivery red either - fabricating a red from a silence
  would be the same lie in the other direction.
- A pull request URL that is not a GitHub pull request URL (Inspector
  prints whatever its own host is) is not polled at all: there is no
  GitHub API behind it. Nothing is recorded, by design - this is not a
  failure to read something, it is nothing to read.

## Sharp edges found while writing it

- `GET /repos/{o}/{r}/actions/jobs/{job_id}/logs` answers **302** with a
  `Location` to a plain-text blob that expires after one minute. Node's
  `fetch` follows redirects by default and would carry the
  `Authorization` header to that host; `redirect: "manual"` plus a
  second, header-free request is both safer and what the blob host
  expects.
- There is no documented way to go from a check run to its Actions job
  id. The documented route runs the other way: a job carries
  `check_run_url`. So the log lookup lists the head commit's workflow
  runs (`?head_sha=`), lists each run's jobs, and matches
  `check_run_url`'s trailing id against the red check run's own id.
  Parsing a job id out of `details_url` would have been one call instead
  of two but that URL's shape is not documented anywhere.
- The combined-status endpoint already resolves to the latest status per
  context (the same fact `rule9-gate.yml`'s two jobs lean on), so there
  is no paging back through a commit's whole status history.
