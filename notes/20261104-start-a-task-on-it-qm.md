# Issue #342: build secrets from `brain.env` to Inspector and the machine image build

Written at the start of the task, before any code, as the brief asks:
the approach chosen, and the one alternative rejected.

## The approach, safest first

A project's paid gem source needs a credential at **image build time**
(`bundle install`), in two different builds of the same
`Dockerfile.inspector`: Inspector's check box, and Fabrica's own machine
image (the project's file plus Fabrica's layer). The credential lives
only in `~/.fabrica/brain.env`, mode 600 (standing ruling), and must
never reach the worker box, the record, a log or a message.

So the shape is: **names travel, values don't.**

- `.inspector.json` gains `buildSecrets`, a list of variable *names*,
  derived at `fabrica register` time from `Gemfile.lock`'s own non-
  rubygems `GEM` remotes by bundler's own documented naming rule
  (`BUNDLE_` + host uppercased, `.` -> `__`, `-` -> `___`).
- `Dockerfile.inspector`'s install step mounts each name as a build
  secret - the file form (`--mount=type=secret,id=NAME`, read with
  `cat /run/secrets/NAME` into a variable assignment in front of
  `bundle install`), because the `env=` form needs a newer Dockerfile
  frontend than some installs have (the issue says so explicitly).
  Docker's own docs confirm a secret mount is a tmpfs for that one `RUN`
  and is never in a layer.
- Values are read from `brain.env` only at the two moments a build or a
  handoff actually needs them, by one resolver with one list of names, so
  "which variables does this project need" can never be two answers.
- Every reader that is *not* one of those two moments gets names only:
  `fabrica doctor`'s per-project line, every message, the record.

Safety first: the one place a value could leak into a Worker's reach is
the worker box's environment, and that is an explicit allowlist
(`src/containment`'s `opts.env`, built from `credentialEnvFrom`'s single
credential). Two tests hold that shut - one behavioural (a `brain.env`
holding a build secret still yields a worker env of exactly one
variable), one structural (only the three intended modules may read a
build secret's *value* at all).

Accuracy next: the derivation is section-aware over `Gemfile.lock` (a
`GIT`/`PATH` block's own `remote:` is not a gem source), and a remote
whose host cannot become a legal variable name is **named in the notes**
rather than guessed at or silently dropped.

## The alternative rejected

**Reading the credential out of the Client's own `~/.bundle/config` (or
the project's `.bundle/config`) instead of `brain.env`.** It needs no new
`.inspector.json` key and no name derivation at all - bundler already
holds the value there, and `bundle config` would hand it over.

Rejected on all three axes:

- *Safest*: it puts Fabrica's secret handling outside the one file the
  standing ruling names ("secrets live only in `~/.fabrica/brain.env`,
  mode 600"), on a file with no mode guarantee at all, and spreads the
  blast radius of a leak to every credential bundler happens to hold.
- *Most accurate*: Inspector cannot do the same - it needs environment
  variable *names* in `.inspector.json` to pass as `--secret id=NAME,
  env=NAME` (inspector#86), so the two sides would be configured two
  different ways for the same credential and could silently disagree.
- *Fastest*: it would still need the mount lines and the doctor check, so
  it saves only the derivation - the smallest part - while making the
  Inspector half unimplementable.

## What the work then found (durable, worth keeping)

### The in-repository list has to be pinned to the base commit

The list of variable names decides *which* of `brain.env`'s variables
are handed to an image build. For a project whose `.inspector.json` is
in the repository, the copy in a task's worktree is a file the Worker
has been writing in - and a Worker that could add a name to it could
name any credential in `brain.env` and have it mounted into a build
whose `Dockerfile.inspector` it had also just written. The check box has
no network; the **build** does.

So the round reads that list at the task's base commit
(`src/foreman/judge.ts` passes `revision: baseCommit`), exactly as
`declaresTestPaths` pins "who reviews this work" for the same reason. A
terms folder needs no pinning: it is never mounted into a worker's box.
`src/buildsecrets/declared.test.ts` proves the pinning behaviourally and
`no-value-outside-the-build.test.ts` proves structurally that the round
still asks for it.

### `mode=0444` on the secret mount, not just `id=`

Docker mounts a build secret as mode 0400 owned by root. An install step
that does not run as root - which is exactly what a `cimg/*` base
image's step does, see `knownNonRootUser` - then fails on `cat:
Permission denied` inside an image build. `mode=0444` is the fix; the
file exists only inside that one `RUN`, on a tmpfs, and is in no layer.

The `env=` form of the mount would need no `cat` at all but needs a
newer Dockerfile frontend (Docker's own docs put it behind a `# syntax=`
pin), so it is deliberately not used - issue #342 says so, and the file
form works on any Docker with BuildKit.

### The Inspector half is not merged, so the pin did not move

`.github/workflows/docker-tests.yml`'s pin is unchanged on purpose:
checked against GitHub's API on 2026-11-04, **inspector#86 is an open
issue, not a merged pull request**, and Inspector's `main` is still at
`8cc11fd116ec` - which is exactly the commit already pinned. There is no
merge commit to move to.

Read from Inspector's own source at that pin
(`internal/inspector/config.go`): its `Config` is decoded with a plain
`json.Unmarshal`, so an unknown `buildSecrets` key is **read past**, not
refused. That is what makes writing the key ahead of the other side
safe: an existing project is unaffected, and a project that needs a
credential goes red in Inspector with its own authentication error.

`src/register/build-secret-e2e.test.ts`'s Inspector half is therefore
expected to FAIL on the current pin (it asserts the build step saw the
value; with no `--secret` passed, the mount is empty). It skips where
Docker is absent, which includes Inspector's own check box, so it does
not turn this repository's own check red - only the `docker-tests` job
on a real Docker runner.

### A gap in `docker-tests.yml`'s path gate, left alone deliberately

That job's `DOCKER_PATHS` list covers `src/register/*`, which is where
the new end-to-end test lives, so a change there triggers the full
suite. It does **not** cover `src/buildsecrets/*` (nor
`src/projectimage/*`, which was already in that position) - so a change
confined to the derivation alone would take the fast path and never run
the Docker proof. Not fixed here: `.github/workflows/**` is one of
rule 9's protected paths, and issue #342 sanctioned exactly one edit to
that file (moving the pin), which has nothing to move to yet. Worth one
line in `DOCKER_PATHS` next time that file is opened under a ruling.
