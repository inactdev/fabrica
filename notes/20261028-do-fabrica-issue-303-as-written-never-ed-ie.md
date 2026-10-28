# Issue #303: register scaffolds Dockerfile.inspector; `image`/`network` are retired

## The plan, written before any change (and what was rejected)

Safest first, then most accurate, then fastest:

1. **Nothing in any project's `.inspector.json` is edited.** Only the
   *generator* of that file changes (`src/register/scaffold.ts`'s
   `inspectorConfigJson`, `src/register/propose.ts`). This repository's
   own `.inspector.json` was already moved by PR #302 and is left
   exactly as it is.
2. **A committed `Dockerfile.inspector` is never overwritten** (Client
   ruling on this issue's clarification 2): register leaves it alone and
   says so in its own report and in the pull request body.
3. **The proving run is unchanged** — still `./check.sh` inside
   `--image`, in a container, network allowed, never on the host. The
   issue says to keep the pull that proves the tag exists; it now proves
   the `FROM` line.
4. `--network` is removed outright; passing it is an unknown-flag
   refusal whose message says where dependencies go now (clarification
   1).

**Alternative rejected:** having register *build* `Dockerfile.inspector`
(`docker build -f Dockerfile.inspector .`) for its proving run, instead
of running the check inside the raw `FROM` image. It would prove more —
that the generated Dockerfile builds, not only that its base tag
resolves — but the issue explicitly says to keep the pull, a build is far
slower on the Client's machine, `prepare()` proves only that `docker
info` answers (not that a build backend is usable), and building the
check image is Inspector's own job. A second rejected alternative, named
in the clarification and settled by it: keeping `--network` as a flag
that fails loudly rather than deleting it.

## What was learned that outlives the task

- **The check box has no network (inspector#47 / inspector PR #64).**
  `.inspector.json` accepts no `image` and no `network` key with any
  value. The box is built from a `Dockerfile.inspector` committed at the
  repository root, so a project's dependencies are installed there, at
  build time. `register` writes that file now; the `--image` flag sets
  its `FROM`.
- **Why dependencies go in `/deps` and not beside the checkout.**
  Inspector puts the repository's own files in place when it runs the
  check, so anything installed at the checkout's path at build time is
  shadowed. This repository's own `Dockerfile.inspector` + `check.sh`
  (PR #302) are the reference: install into `/deps` at build time, and
  have `check.sh` link `/deps/node_modules` in when it finds it. A
  generated `check.sh` for a project with a `package-lock.json` now
  carries that same link preamble, because a baked `/deps` that nothing
  links in would be a silent gap.
- **A `cimg/*` image does not run as root** (its user is `circleci`),
  which is why this repository's own Dockerfile has the
  `USER root` / `mkdir` / `chown` / `USER circleci` dance around the
  install. `src/register/dockerfile.ts` reproduces it for a `cimg/`
  `FROM` - the one image family there is live evidence for - and, for
  anything else, writes the plain root-default form plus a comment
  naming exactly what to add if that image runs as someone else. It
  never guesses a user name.
- **Three places still name an `image` key, deliberately untouched:**
  `contract/helpers/fixture.ts`'s `FIXTURE_INSPECTOR_CONFIG` and
  `src/inspector/run.test.ts`'s inline config are test fixtures whose
  config Inspector never reads here (the fake Inspector/box does), and
  `src/register/README.md`'s history section. The fixtures are harmless
  but they are the last places in the repository that still show the
  retired key.
