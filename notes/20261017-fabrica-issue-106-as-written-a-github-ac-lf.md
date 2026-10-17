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
without `gh` access.

**First diagnosis (wrong, since reverted):** a theory that `readStdin`
left its abandoned `for await` read-loop dangling past `destroy()`,
fixed by adding `await read`. Plausible-looking, matched the available
(incomplete) evidence, but wrong - the Client reproduced the real cause
directly on Node 22 on an idle Linux machine, in under a second, running
only this one test file, and the added `await read` made no difference
to it either way.

**Real cause, confirmed by the Client's own reproduction and corroborated
here against Node's own documented test-runner behavior:**
`readStdin` (`src/cli/deny-and-log-edit-command.ts`) built its timeout
race with `timer.unref?.()` on the deadline timer. The three affected
tests all drive `readStdin` with a fake stdin (a bare `new Readable({
read() {} })`, or an already-ended `Readable.from([...])`) that holds no
real OS handle of its own. When the *only* thing that could ever resolve
the pending race is an unref'd timer, Node's event loop can decide it has
no more real (ref'd) work left and begin shutting the process down before
that timer ever fires - leaving the test's `await` on that race
permanently unsettled. Node's test runner has a specific, documented
diagnostic for exactly this shape, `"Promise resolution is still pending
but the event loop has already resolved"` (nodejs/node#49952, and the
exact AbortSignal.timeout()-unref case in that issue's linked fix), and
per that issue, once one test in a file hits it, the failure "propagates
to all other tests" after it in the same run - matching this file's
pattern exactly: the three cancelled tests are consecutive, from the
first one that exercises the timeout path through the end of the file.

Why Node 22 and not Node 24 (confirmed here only indirectly: this sandbox
has no way to install Node 22 to reproduce side-by-side, no npm registry
access and no second runtime preinstalled) - the Client's own repro
report states it reproduces on 22 and that removing just the `unref()`
call (no other change) makes all 7 pass; this note takes that as given
rather than re-deriving it, since the Client already has both versions
to compare and this sandbox does not.

**Fix applied:** delete `timer.unref?.()` entirely - the timer is always
`clearTimeout`'d immediately after the race settles either way, so there
was nothing for `unref()` to protect against (no risk of outliving the
function); it only ever removed the one thing keeping the deadline honest
when nothing else does. The `await read` block from the first diagnosis
is reverted - it was solving a problem that wasn't the real one, and its
own inline comment's explanation (mocked timers starving a dangling
stream teardown) was never actually confirmed, only theorized.

Separately, `.github/workflows/docker-tests.yml` pinned `node-version:
"22"`, inconsistent with every other Node-version pin in this project
(the worker Dockerfile and relay image pin `node:24.18.0-alpine` by
digest, `.inspector.json` pins `cimg/node:24.18.0`, README says Node 24)
- changed to `"24"`. This was itself *masking* a divergence worth noting
for next time: the Node-22-only failure above would not have been caught
by a contributor running `npm test` locally on Node 24, nor (before this
fix) by this very CI job once it also ran Node 24 - it needed exactly the
mismatched pin plus a from-cold reproduction to surface at all.

General, durable takeaway for this codebase: never `unref()` a timer that
some `await`ed race is the *only* path to resolving - if nothing else in
that race holds a real handle, Node is free to end the process before an
unref'd timer fires, and the failure mode is an unresolved promise, not a
thrown error, which node:test reports as the whole file's tests from that
point on being "cancelled."
