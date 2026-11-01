# Pins stay fresh: a weekly job proposes the bump (issue #326)

## The decision, written before any code was changed

**What was built:** `.github/workflows/pin-freshness.yml` (weekly schedule
plus `workflow_dispatch`) running `.github/scripts/check-pin-freshness.sh`,
proven by `src/cli/pin-freshness-workflow.test.ts`. One issue per stale
pin (Client clarification on this task), updated rather than duplicated on
a later run.

**Safest first.** Three properties decided the shape:

1. *No second source of truth for what is pinned.* The script reads every
   pinned value out of the real files it is watching (`.node-version`, the
   worker Dockerfile, `src/relay/container/launch.ts`, `README.md`) and
   fails the job if a pin's value is no longer findable where it expects
   it. A committed `pins.json` listing "the pins" would have been less
   code and would have drifted from the files the moment one moved — a
   watcher that silently watches nothing is worse than no watcher, and
   this project's standing ruling is that everything fails loudly.
2. *Read-only upstream, one write.* Every upstream read is a GET. The only
   write is the issue, through `POST`/`PATCH` on this repository's own
   issues. No commit, no branch, no push, nothing cross-repository — so
   the job cannot damage a pin while reporting on it.
3. *Identity by marker, not by title.* Each pin's issue carries
   `<!-- fabrica-pin-freshness: <key> -->` in its body, and the job finds
   its own earlier issue by listing open issues with the
   `pin-freshness` label and matching that marker. Titles name the exact
   bump, so they change when upstream moves again; matching on a title
   would have opened a second issue every time upstream moved twice.
   Listing by label is also immediate, unlike the search API's index,
   which lags and would have opened duplicates on a fast second run.

**The alternative that was rejected:** writing the comparison logic as a
TypeScript module under `src/` with an injectable `fetch`, which would
have given it real unit tests instead of a source-reading test. Rejected
for two independent reasons. CONTRACT rule 8's scan
(`contract/rule8.no-favorite-brain.test.ts`) forbids naming the coding
agent's vendor anywhere under `src/` outside `adapters/`, and the pin this
job watches most closely is that agent's own version — the module and any
test naming it would fail that scan. And CI glue has no business in
Fabrica's library surface: this repo already settled that shape for
`sync-inspector-contract` (a `.github/scripts/*.sh` plus a test that reads
the workflow's and script's own source, with an honest note that the real
API orchestration is only exercisable inside a real Actions run), and
following the settled precedent beats inventing a second one.

The risky half of a bash script is version comparison, so that half is not
only source-read: `newer_version` is a pure function with no I/O, and the
test sources the script in a real `bash` and exercises it (`24.9.0` is
older than `24.18.0`, which text sorting gets wrong; `go1.26.8` and
`v24.18.0` compare as versions; a non-numeric component fails rather than
being guessed at).

## What each pin compares, and where "upstream" is

| key | pinned in | upstream |
| --- | --- | --- |
| `node` | `.node-version`, `package.json`'s `engines.node`, `Dockerfile.inspector`'s `FROM` tag, the worker Dockerfile's `node:<x.y.z>-alpine` comment | newest release in `.node-version`'s own major line, from `https://nodejs.org/dist/index.json` |
| `worker-cli` | the worker Dockerfile's `npm install -g <pkg>@<version>` | that package's `dist-tags.latest` on the npm registry |
| `node-image` | the worker Dockerfile's `FROM node@sha256:...` and `src/relay/container/launch.ts`'s `RELAY_IMAGE` | the current manifest-list digest of the tag the Dockerfile's own comment names |
| `go-toolchain` | the worker Dockerfile's `golang@sha256:...` stage, identified by the `go1.x.y` its comment records | newest stable release from `https://go.dev/dl/?mode=json` |
| `inspector-go` | `README.md`'s "This needs **Go N.N+**" line for `go install` of Inspector | the `go` directive in `inactdev/inspector`'s own `go.mod` |

**The golang base image is watched by its Go version, not by its digest,
and that is deliberate.** The node base image's digest can be re-resolved
because the Dockerfile records the tag it was taken from
(`node:24.18.0-alpine`, the spelling `src/cli/node-version-pins.test.ts`
already binds). The golang stage records only the Go version the digest
resolves to (`go1.26.8` on Alpine), not a tag — so there is nothing to ask
a registry about without inventing a tag and hoping it is the one that
digest came from. A guessed tag would produce confident, wrong bumps. The
Go version is the honest signal available, and it moves whenever the thing
that matters moves; a future task that adds the tag to that comment, the
way the node line already carries one, turns this into a second digest
pin with no change to the comparison code.

## Two bash traps this hit for real, worth copying the fix from

Both were found by running the thing, not by reading it, and both are
the kind that leave a job *looking* fine.

**A `::error::` written inside `$( )` is swallowed, not logged.** Most of
the reads in this script hand their answer back on stdout, so they are
called inside a command substitution - and an error message written to
stdout in there goes into the value being computed instead of the log.
Measured: an empty release index failed the job with no message at all.
The fix is `exec 3>&1` once at the top, before anything can capture it,
and `fail` writing to `>&3`. File descriptors are inherited into
subshells, so fd 3 is still the job's real stdout from inside any depth
of `$( )`. (Writing to stderr instead was considered and rejected:
GitHub documents workflow commands as being read from stdout, so an
annotation on stderr may be only ordinary log text.)
`.github/scripts/sync-inspector-contract.sh` does not have this bug -
it returns its reasons *through* stdout to a caller that annotates them -
so there was nothing else to fix.

**`$(cmd 2>&1)` corrupts JSON from any tool that writes notices on
stderr while succeeding.** `npm view --json` and `docker buildx
imagetools inspect` both do. The capture has to keep the two streams
apart: `run_capturing` leaves stdout in `RUN_OUT` and a flattened
one-line stderr in `RUN_ERR`. Flattening matters on its own - a raw
newline ends a `::error::` annotation, so an unflattened reason is
truncated at its first line. Nothing else in this repository's CI glue
captures a command that way (`docker info > /dev/null 2>&1` in
docker-tests.yml discards both streams rather than parsing either), so
again there was nothing else to fix.

## Sharp edges worth knowing

- **No jq anywhere, on purpose.** The first draft read JSON with jq, the
  way `sync-inspector-contract.sh` does. jq is on every GitHub-hosted
  runner, but it is not installed in a worker box or reliably in a check
  box - so the test would have had to skip there, and a test that skips
  proves nothing. The script already needs node (it reads the published
  CLI version through `npm view`), so node does the JSON instead and the
  test runs everywhere. `gh api --jq` is still used freely: that is the
  jq built into gh, not a system install.
- `gh api` switches to POST the moment any `-f` parameter is added, so
  every read here passes `-X GET` explicitly. The in-repo precedent
  (`.github/scripts/sync-inspector-contract.sh`) does the same.
- Listing issues by label returns pull requests too (GitHub treats every
  pull request as an issue), so the match filters on `.pull_request ==
  null`. Without it, a pull request quoting the marker could be mistaken
  for the job's own issue and "updated" — which for a pull request means
  rewriting its body.
- A label must exist before it can be applied: whether `POST
  /repos/.../issues` auto-creates an unknown label is not documented
  either way, and unknown labels are "silently dropped" for anyone
  without push access. The job therefore gets the label and creates it on
  a 404 before opening anything, rather than relying on unspecified
  behavior and ending up with an unlabelled issue it could never find
  again.
- `docker buildx imagetools inspect --format '{{.Manifest.Digest}}'` does
  not work: plain sub-field templates are a long-standing buildx bug
  (docker/buildx#1175) and print the whole human-readable block instead.
  The job uses `--format '{{json .Manifest}}'` and reads `.digest` with
  `jq`, which is the documented working form.
- Scheduled workflows run only from the default branch's newest commit,
  so this job does nothing at all until the workflow file is merged — and
  `.github/workflows/**` is one of rule 9's protected paths, so this pull
  request fails `block-protected-path-change` on purpose and the Client
  merges it by hand.
- The cron is `17 6 * * 1`, deliberately not on the hour: GitHub's own
  documentation warns that scheduled runs are delayed, and queued jobs
  sometimes dropped, at peak times, of which the top of the hour is one.

## What the job deliberately does not do

It never closes an issue. When a bump lands, the Fabrica task that takes
it closes the issue through its pull request body (`Closes #N`, which
`src/foreman/pr-body.ts` already writes from a task text opening with
`Issue #N:`), so the loop closes itself through the path this project
already has. Having the job close issues would be a second write the task
did not ask for, on a judgement — "upstream matches again" — that is also
true after a hand-edit it never saw.
