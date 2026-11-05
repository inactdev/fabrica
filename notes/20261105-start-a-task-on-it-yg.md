# Issue #344: Fabrica's own image build never passed the `repo` build context

Written at the start of the task, before any code, as the brief asks:
the approach chosen, the one alternative rejected, and then what the
work found.

## The fault

A work-mode project's `Dockerfile.inspector` (the copy in its terms
folder) reaches the repository's own manifest and lockfile with `COPY
--from=repo ...` - the shape `fabrica register` writes for a
terms-folder project, because Inspector resolves a check image build's
own context against the terms folder, which holds none of those files.
`repo` is a *named build context*, not a stage and not an image:
Inspector passes `--build-context repo=<repository>` on every check
image build (`internal/container/image.go`'s `RepoBuildContext`, fixed
with no config key, inspector#83).

`machineImageBuild` passed no `--build-context` at all, so Docker read
`repo` as an image reference and every build of such a project's machine
image failed with `failed to resolve source metadata for
docker.io/library/repo:latest` - which is what `fabrica update` and
`fabrica doctor --fix` reported, and what a task on that project refused
with.

## The approach, safest first

One flag, unconditionally, from the one constant that already spells the
name: `--build-context repo=<machine.context>` on every machine image
build, layered or not, terms folder or repository. Same name, same
value, same "for every build" rule as Inspector's own, so one
`Dockerfile.inspector` works in both builds.

- **Safest.** It adds a context; it takes nothing away. A repository
  route project's Dockerfile has no `COPY --from=repo` in it (plain
  `COPY` from the main context is what `fabrica register` writes there),
  so for every project that built before this change the build is
  byte-identical in effect - the extra context is simply unused. Passing
  it there anyway is what makes a project that later moves its terms out
  of the repository need no second decision, and is exactly the rule
  Inspector states for its own side.
- **Most accurate.** The name is not re-spelled: `REPO_BUILD_CONTEXT`
  already existed, as the constant `fabrica register` writes `COPY
  --from=repo` from, and the flag is now built from the same constant.
  Two spellings of a fixed name is how the two halves silently disagree.
- **Fastest** is unaffected: one more argv element, no extra process, no
  extra probe. Docker sends only what a `COPY` actually reads from a
  named context, so a build that ignores it pays nothing for it.

### Where the constant lives now

It moved from `src/register/dockerfile.ts` to `src/inspector/
config-check.ts`, beside `INSPECTOR_DOCKERFILE`, and is exported from
`src/inspector/index.ts`.

Not a tidy-up: `src/projectimage/` needed to read it, and both the
module that writes the `COPY --from=repo` lines (`src/register/`) and the
module that passes the flag (`src/projectimage/`) already import
`src/inspector/`. Importing `src/register/` from `src/projectimage/`
would have pointed a low-level module at a high-level command's whole
graph (register pulls in `src/containment/`, `src/line/`, `src/brain/`)
and pointed the dependency the wrong way round - register already
imports projectimage in its own end-to-end test. The name is Inspector's
fixed convention in the first place, so `src/inspector/` is where its one
declaration belongs.

## The alternative rejected

**Making a work-mode project's `machine.context` the terms folder, so
the whole build is shaped exactly like Inspector's** (main context =
wherever the Dockerfile lives, repository = the named context).

Rejected:

- *Safest*: it changes what every existing `COPY` in a project's own
  file resolves against, including a repository-route project's, where
  the main context is the only way its `COPY` lines reach anything. That
  is a behaviour change for projects that build fine today, to fix a
  fault in projects that do not.
- *Most accurate*: nothing in a terms-route `Dockerfile.inspector` reads
  the main context at all - `fabrica register` writes every `COPY` in it
  as `COPY --from=repo` (`copyFrom`/`RepoFilesSource` in
  `src/register/dockerfile.ts`). So aligning the main context fixes
  nothing the named context does not already fix, and the repository is
  also the right thing for the main context to be: it is the folder the
  work under test lives in.
- *Fastest*: strictly more work (a second decision in `machineImageFor`,
  plus its own tests) for the same outcome.

Also considered and not done: refusing a project whose own Dockerfile
declares a build stage named `repo`. Inspector refuses that by name
(`parseDockerfile`, because Docker resolves a named context ahead of a
stage of the same name, so the stage would be silently replaced), and
Fabrica now shadows such a stage without saying so. It cannot bite in
practice - Inspector refuses that project before any verdict, so the
work could never be judged - and detecting it here means parsing the
project's Dockerfile for stage names, which is a second implementation
of something Inspector already owns. Named here rather than left
unsaid; worth an issue if a project ever hits it.

## What the work found (durable)

### Where a real-Docker test has to live to actually run in CI

`.github/workflows/docker-tests.yml`'s path gate (`DOCKER_PATHS`) does
not name `src/projectimage/*`. A pull request touching only that
directory takes the fast path, so a Docker-dependent test placed there
would never run on the merge path - it would skip locally and never
execute in CI, which is precisely the hollow pass that job's `docker
info` guard exists to prevent, arrived at from a third direction.

So this issue's end-to-end test lives in
`src/register/build-secret-e2e.test.ts`, under `src/register/*`, which
that gate does name - beside the repository-route build-secret test it
is the terms-route sibling of, and sharing its fake value, witness file
and leak searches. The same gap was already noted for
`src/buildsecrets/*` (see `notes/20261104-start-a-task-on-it-qm.md`);
`src/projectimage/*` is the second directory in that position, and both
want one line in `DOCKER_PATHS` the next time that protected file is
opened under a ruling.

### A base image for a real build of the generated machine Dockerfile

`machineImageBuild`'s own answer is the project's file *plus Fabrica's
layer*, so a real build of it needs a base the layer can install into:
bash, git, curl or wget, sha256sum or shasum, and an architecture and
libc nodejs.org publishes a build for. `alpine:3.20` - what the
repository-route build-secret test builds on, since it builds only the
project's own half - fails that twice: no bash and no git, and musl,
which nodejs.org publishes for x64 only (so it would pass on a CI runner
and fail on an arm64 Mac).

`debian:bookworm-slim` plus `apt-get install bash ca-certificates curl
git` is the cheap one that works on both: glibc, ~100MB before the
layer, where `cimg/*` (what `src/brain/adapters/
machine-image-build.test.ts` builds on, deliberately, as the real shape
of a registered project) is a multi-gigabyte pull and a multi-gigabyte
`docker save` to search for a leaked value afterwards.

### Why the name is not in `src/inspector/consumer-contract.json`

That file is the ratified copy of the facts of *the Inspector call* -
flags Fabrica passes to `inspector`, its exit codes, its stdout line,
its token variable - and a change to it opens a pull request on
Inspector's own copy automatically (issue #109). `repo` is not one of
those facts: neither side passes it to the other, they each pass it to
`docker`. Agreement is still required, and today it rests on both
projects having written the same literal down (Inspector's
`RepoBuildContext`, Fabrica's `REPO_BUILD_CONTEXT`). Adding a
`buildContext` key there would put that agreement under the same
automatic sync - worth considering, but it is a cross-repository change
(Inspector's `TestFabricaConsumerContract` reads its copy and would fail
until the sync pull request merged), so not something to fold into a
one-flag fix.

### Searching a layer tar for a value, without reading it into memory

The repository-route test reads the whole `docker save` tar in with
`readFileSync(...).includes(...)`. That is fine for an alpine-based
image and not for one carrying a Node and a ~280MB CLI. The new test
streams it instead, keeping the last `value.length - 1` bytes of each
chunk so a match spanning a chunk boundary is still found -
`tarCarriesValue` in that file.
