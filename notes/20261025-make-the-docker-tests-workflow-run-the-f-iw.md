# Path-gating the `docker-tests` required check

## The one thing to know before touching this gate

`docker-tests` is a **required status check**. That single fact rules out
both of the shapes a path gate normally takes in GitHub Actions:

- **`on.pull_request.paths:`** — a workflow a path filter excludes does
  not run *at all*, so the check never reports. A required check that
  never reports leaves the pull request pending forever; it does not
  pass. (This is why `sync-inspector-contract.yml` *can* use a native
  `paths:` filter — it is a push-triggered automation, not a required
  check. Same mechanism, opposite correct answer.)
- **a job-level `if`, or a second `needs:`-gated job** — a job an `if`
  (or an unmet `needs`) skips reports a `skipped` conclusion, and whether
  GitHub counts `skipped` as satisfying a *required* check is a known
  trap rather than a documented guarantee. `rule9-gate.yml`'s own
  comments already say this about its job, and this repository's own CI
  reader (`src/ci/README.md`) reads `skipped` as "the repository says
  this check does not apply" — so a gate bug would be absorbed as a
  pass instead of showing up.

So the job always runs on every pull request and decides in its first
step; the **steps** are what an `if` skips, and the job itself always
reports a genuine pass or fail. `src/containment/docker-tests-workflow.test.ts`
binds both halves (no job-level `if`; every expensive step gated).

## The gate skips only on positive evidence

The direction a gate fails in is the whole design. This one can only
skip the suite when it has the pull request's complete changed-file list
in hand and nothing in it matches. Everything else runs the full suite:
a trigger that is not a pull request, a changed-file list GitHub will not
give us, and a listing whose length disagrees with the pull request's own
`changed_files` (the API caps that listing at 3000 files *silently*, and
a push landing mid-run moves the count too — `rule9-gate.yml` documents
both). The gate step also contains no `exit 1` at all, bound by a test:
deciding *how much* to run must never fail the job, which is a different
question from whether the pull request is allowed (that is
`rule9-gate.yml`'s business, in its own file).

A gate that skipped on a silence would be the same hollow pass the
`docker info` guard exists to prevent, arrived at from the other
direction.

## Rename handling is not optional here

The changed-file read emits `.filename` **and** `.previous_filename`,
exactly as `rule9-gate.yml` does. Without the previous name, a file
renamed *out of* `src/containment/` reports only its new, unwatched
path — and the one change most likely to break a containment test would
be the one that skipped its tests.

## `[[ ]]` pattern matching, and why each basename pattern has a twin

In bash's `[[ "$candidate" == $pattern ]]`, `*` matches any characters
**including `/`** (it is not pathname expansion). Consequences used
deliberately in `DOCKER_PATHS`:

- `src/containment/*` already covers nested files — no `**` needed.
- A bare `Dockerfile` therefore needs a `*/Dockerfile` twin to match the
  same name in a subdirectory, and `*Dockerfile` would be wrong: it also
  matches `my-Dockerfile`. Verified by running the extracted step against
  a stub `gh` over thirteen cases, decoys (`src/foreman/my-Dockerfile`,
  `docs/Dockerfile-notes.md`) included.

## Known coverage holes, named rather than left to be discovered

- **Build inputs that are not Docker's own are not watched.** A change to
  `package.json`, `package-lock.json` or `.node-version` now takes the
  fast path, even though it can plainly change what a Docker-dependent
  test does. The Client's ruling on the trigger set was explicit
  ("nothing else"), so this is deliberate, not an oversight — but it is
  the first thing to add if a dependency bump ever breaks a worker-box
  test after a green fast path. `workflow_dispatch` is the manual way to
  run everything against such a branch without pushing an empty commit.
- **The three workflow-proving tests are not mapped in `tests.map`.**
  `docker-tests-workflow.test.ts`, `inspector-stamp-workflow.test.ts` and
  `contract-sync-workflow.test.ts` each prove a file under `.github/`,
  and nothing maps those workflow files to them, so a worker touching a
  workflow is not told which test covers it. Left standing here (a map
  edit belongs to whoever owns the map), recorded so it is known.
