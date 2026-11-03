# Issue #322, second attempt: why the first one could not be built

The first attempt (PR #323, reverted in #327) was the right design with
one fatal detail wrong. This note records the detail, because it is a
fact about the world rather than about this repository, and anything else
in Fabrica that installs the coding agent will meet it.

## The published package is a native binary now, not a JavaScript CLI

`@anthropic-ai/claude-code@2.1.222`:

- its `bin` is `{"claude": "bin/claude.exe"}`, and the file at that path
  in the published tarball is a 500-byte, **shebang-less** stub;
- its `postinstall` is `node install.cjs`, which picks the matching
  platform package out of `optionalDependencies`
  (`@anthropic-ai/claude-code-linux-{x64,arm64}[-musl]`, ~280 MB each,
  selected by npm's own `os`/`cpu`/`libc` fields) and hardlinks the
  native executable inside it over that stub, `chmod 0755`;
- in that installer's own words: *"After this runs, `claude` execs the
  native binary directly — no Node.js process stays resident."*

Verified on the machine, not inferred: `npm install -g --prefix <dir>`
leaves `<dir>/bin/claude` as a symlink to that 279 MB executable, and
`env -i PATH=/usr/bin:/bin <dir>/bin/claude --version` prints
`2.1.222 (Claude Code)` — **with no `node` anywhere on `PATH`**. Handing
the same file to `node` fails (`ERR_UNKNOWN_FILE_EXTENSION`).

The first attempt's layer wrote `/usr/local/bin/claude` as
`exec <pinned node> <that file> "$@"`. That is Node being asked to parse
an executable as JavaScript, so the self-check at the end of the
generated Dockerfile could never pass, on any base image. So: **the
launcher names no interpreter.** It execs what npm installed, by
absolute path, and nothing else.

Two consequences worth keeping:

- If that packaging ever changes back to a JS entry point with a
  `#!/usr/bin/env node` shebang, the generated image's own self-check
  fails loudly at build time (`the worker CLI installed but will not run
  in this image`) and `machine-layer.ts` is the file to change. That is
  deliberate: shape detection at build time was considered and rejected
  as a second, silent place for this to be wrong.
- The launcher must **not** put Fabrica's Node on `PATH` either, not even
  for its own process. The agent's shell tool spawns the project's own
  commands as children of the launcher, so a `PATH` set there reaches
  the project's check anyway, by a longer route - the exact divergence
  the per-project image exists to remove.

### Two npm settings that leave it installed but inert

The stub names them itself, and either can arrive from a base image's
npmrc or environment rather than from Fabrica's own command line, so the
install passes both explicitly: `--include=optional` (without the
platform package there is no binary to place) and
`--ignore-scripts=false` (without the postinstall the stub stays). Both
verified accepted by npm 11.16.

## Every `cimg/*` image runs `RUN` under bash, not `/bin/sh`

`cimg/base`'s own Dockerfile sets
`SHELL ["/bin/bash", "-exo", "pipefail", "-c"]`, inherited by
`cimg/node`, `cimg/go`, `cimg/ruby` and anything built `FROM` them -
which is most `Dockerfile.inspector` bases `fabrica register` writes. So
a generated `RUN` runs with `-e`, `-x` and `pipefail` already set, by
bash. `machine-layer.test.ts` syntax-checks each step with `sh -n`
(the stricter of the two to satisfy); the real-build test is what
exercises them under the shell they will actually meet.

Also read off those images' own Dockerfiles, for the record:
`/usr/local/bin` is on the `PATH` of every one of them (the official
`ubuntu` image sets it, `cimg/base` only prepends), which is what makes
`/usr/local/bin/claude` the right place for one added command and the
self-check's demand a fair one.

## A fake docker cannot prove a Dockerfile is buildable

Every test in the first attempt drove `helpers/fake-docker.mjs`, so the
generated file was never once handed to a real builder before it merged -
and once merged, every project needed an image that could not be built,
which blocked every task on every project. The fast tests still cover
the argv and the decisions, and that is the right place for those;
`src/brain/adapters/machine-image-build.test.ts` covers the file, with a
real `docker build` against `cimg/node` and `cimg/go`, skipping with a
banner where there is no daemon and running for real in the
`docker-tests` CI job.

The general shape: **when Fabrica generates something another program
executes, at least one test has to hand it to that program.**

## A base image's user is in the image, not in anybody's Dockerfile

The real build above then failed on `cimg/go` for a second reason, one
only a real daemon could have shown: the built image ended as `root`
where `cimg/go` runs as `circleci`. Fabrica's layer switches to root to
install, and switched back only to a user it could find a `USER` line
for - and `cimg/go`'s `circleci` is set **inside the image's own
config**, by no line of any Dockerfile a project (or Fabrica) writes.
`cimg/node` passed only because the stand-in `Dockerfile.inspector`
happened to end with its own `USER circleci`.

So the question "which user does this stage end as" cannot be answered
from Dockerfile text alone. It is answered in two steps now
(`machineRestoreUser`): the final stage's own last `USER` when it has
one, otherwise the resolved base image's `.Config.User`, read with
`docker image inspect`. Only an empty value there means root.

Three facts that shape the implementation, read off `docker/cli` and
`moby/moby` rather than assumed:

- `docker image inspect` asks the **local daemon** and never pulls, so
  the probe pulls once itself when the base is not on the machine yet
  (a fresh CI runner, or a first `fabrica doctor` on a new project).
  It says so on stderr first: the alternative is minutes of silence.
- The `--format` template runs against a typed struct, so an image whose
  config names no user renders as the empty string, not as an error.
  That is what makes "empty means root" a reading rather than a guess.
- There is no Dockerfile-native way out. `USER` expands build args and
  environment, never the output of a command, so no `RUN` can capture
  `id -un` and hand it to a later `USER`. The host has to know.

**Why not a multi-stage build instead** (the alternative weighed and
rejected): install into a throwaway stage and `COPY --from` the result
into a final stage that never switches user at all, so nothing needs
asking. It needs no daemon probe, which is genuinely safer - but it
rewrites the whole layer rather than fixing the bug, it would have to
pick a stage name that cannot collide with any name a project already
uses, and `COPY`'s ownership behaviour for a ~280 MB native executable
landing in a non-root image was not something that could be verified
here. Reading the user is the smaller, checkable change.

### The same shape elsewhere

"Read a fact off Dockerfile text that really lives in the image" is the
defect class. The other text readers in this repository were checked:

- `finalStageUser` itself (still right, now only the first of the two
  steps) and `finalStageBaseImage`, which is text-only by nature - it
  resolves which image to ask, and refuses rather than guessing when a
  build argument names it.
- `pinnedMachineNodeVersion` and `pinnedCliVersion` read Fabrica's own
  worker Dockerfile for its pins. Those are declarations in a file this
  repository owns, not facts an image carries, and both refuse loudly
  when the text is not there.
- `src/cli/node-version-pins.test.ts` binds those same pins across five
  declarations. Same reasoning: all five are this repository's own text.
- Nothing else under `src/` parses a Dockerfile.

### Reading an image is a seam every caller can replace

Because composing a generated Dockerfile now asks the daemon, every
layer between a command and `machineDockerfile` carries one optional
probe (`BaseUserProbe`, defaulting to the real read):
`machineDockerfileFor`/`machineImageBuild`/`machineImageCurrency` and
`machineImageStatus`'s probe bag, then `MachineImageIo.baseUser`
(`fabrica do`, `fabrica update`) and `RepairImagesOptions.baseUser`
(`fabrica doctor --fix`, `fabrica up`). It is reached only for a project
whose own final stage names no `USER`, but a unit test that leaves it
out reaches a real `docker` - loudly, with the full "could not be read"
refusal, which is how the three suites that needed it were found. A
fixture on a root base image passes `() => ""`.

The two `fabrica doctor` lines a registered project has now are easy to
confuse in a test: `project <name>:` (its configuration) and
`project <name> image:` (issue #322). A test counting lines that merely
*contain* `project <name>` counts both - match the colon.
