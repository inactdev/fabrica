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
