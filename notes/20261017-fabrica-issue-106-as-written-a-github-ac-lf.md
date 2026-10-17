Reading a GitHub Actions job's raw log from this agent's sandbox is not
possible without a real `gh` CLI session or a GitHub token - and neither
is available here by default. Verified directly against PR #218's own
`docker-tests` check run (job id, fetched via the unauthenticated,
public `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` endpoint,
which does work anonymously for a public repo):

- `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` → 403, body
  `{"message":"Must have admin rights to Repository."}`. Same result for
  the whole-run zip endpoint, `GET .../actions/runs/{run_id}/logs`. Both
  are documented as needing real authentication; in practice there is no
  partial/anonymous-but-public-repo carve-out - a public repo's commits,
  pulls, and check-run *conclusions* are readable with no token at all,
  but the actual log *text* is not.
- `check-runs/{id}/annotations` only ever carries what the Actions UI
  auto-generates for a failed `run:` step with no `::error::` of its
  own - just the generic "Process completed with exit code 1" plus
  whatever notices GitHub itself injects (e.g. the runner-image migration
  notice). No per-test detail rides along on it.
- Fetching the job's `html_url` anonymously returns the page shell only
  (`"logged_in":false"`) - the step list and log text are loaded by
  client-side JS calling the same authenticated endpoint above, so
  scraping the HTML doesn't help either.

There is no gh CLI binary installed in this sandbox and no
`GH_TOKEN`/`GITHUB_TOKEN` in the environment to install one with. If a
future task is asked to read a specific run's log (as issue #106's
follow-up asked), either the Client needs to paste the relevant log
excerpt into the task brief, or whatever provisions this sandbox needs
to supply a real token with at least `actions:read` before the task
starts - there is no way to get it from inside the task itself.

## Follow-up (same task): the 3 "cancelled" tests on docker-tests

The Client later supplied the actual evidence by hand (pass/fail/cancelled
counts plus the 3 test names) instead of a log, which unblocked this
without `gh` access. Root cause, verified in this sandbox (not on the
real CI runner, which stayed unreachable) against Node 24 on Linux/arm64:

`src/cli/deny-and-log-edit-command.ts`'s `readStdin` raced a real
`for await (const chunk of stream)` loop against a timeout. On timeout it
called `stream.destroy()` and returned immediately, without waiting for
that abandoned loop's own promise to settle - a genuine dangling-async-work
bug, confirmed by instrumenting the original function: across 5/5 runs,
`readStdin` resolved and returned to its caller while its internal
`read` promise had `readSettledAtReturn === false` (still pending).
Awaiting that promise after `destroy()` (instead of firing-and-forgetting
it) made it `true` on 5/5 runs, with no change to timing or to what the
three affected tests assert.

Why this surfaces as "cancelled" specifically on a loaded Linux CI runner
and not on a quiet machine: Node's `node --test` runs each file in its
own child process (default `--test-isolation=process`), and top-level
tests within one file run sequentially (concurrency 1) - but "sequential"
only governs when each test's *own* callback promise resolves, not
whether stray background work it kicked off (and never awaited) has
finished by the time the next test starts. One of the three affected
tests enables `t.mock.timers.enable({ apis: ["setTimeout"] })`, which
patches the process-wide `setTimeout` for the file's one process. If the
prior test's abandoned read-loop teardown is still in flight at that
moment - far more likely on a CI runner whose CPU is shared with dozens
of concurrently running real `docker run` processes from the rest of
`npm test` than on an idle laptop - anything that teardown still depends
on can be starved by the mock, and the file's process never reports the
remaining tests, which the outer test runner then shows as cancelled
rather than failed. This was not reproduced as an actual hang in this
sandbox (no Docker here to generate the matching CPU pressure); the fix
is the general one - never let `readStdin` return before the work it
abandoned on timeout has actually settled - which removes the dangling
promise regardless of the precise way a loaded runner's scheduling
would have exposed it.

General, durable takeaway for this codebase: any function that races a
real stream-consuming loop against a timeout and calls `.destroy()` on
timeout must `await` that loop's own promise before returning. Returning
first and letting the loop settle "whenever" is invisible on a quiet
machine and only shows up as flaky, hard-to-reproduce failures elsewhere
once something else in the same process touches global timers or the
event loop is under real contention.
