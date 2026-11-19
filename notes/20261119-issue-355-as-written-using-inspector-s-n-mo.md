# Version build args: the repository's own files decide the image's version

Issue #355. A project's `Dockerfile.inspector` hard-coded `FROM ruby:3.4.8`
while the repository's `.ruby-version` moved to 3.4.13, so every task that
rebased past that bump failed at `bundle install` with nothing wrong with
the work. The fix: the Dockerfile names a build argument, the repository's
own version file supplies its value, and both image builds (Inspector's
check box and Fabrica's own worker box) read that file rather than a number
typed into a Dockerfile.

## The design decision, and the alternative that was rejected

**Chosen: the ARG carries a default, and that default is the version the
file declared when the line was written** - `ARG RUBY_VERSION=3.4.8`, then
`FROM ruby:${RUBY_VERSION}`.

**Rejected: a bare `ARG RUBY_VERSION` with no default.** It is what issue
#355's own proposal sketches, and it is the less safe of the two: an
Inspector that does not pass the argument (every installed Inspector until
the `buildArgs` half lands, and any hand `docker build` of the same file)
resolves `FROM ruby:` - not a stale image, but an invalid reference, so
every check-image build on every converted project fails at once, and fails
with Docker's own "invalid reference format" rather than with anything
naming this change. With a default, the same build produces exactly what it
produced before the conversion, and the only way to get a *wrong* version is
the way the Client already had. Safest first: a conversion that cannot break
a project whose Inspector is a week old.

Both forms are identical once the argument is passed, which is the ordinary
path: Fabrica always passes it, and Inspector passes it once `buildArgs`
lands. Verified against BuildKit's own Dockerfile reference ("`FROM`
instructions support variables that are declared by any `ARG` instructions
that occur before the first `FROM`", and `ARG CODE_VERSION=latest` /
`FROM base:${CODE_VERSION}` is its own example), read from
moby/buildkit's `frontend/dockerfile/docs/reference.md` - docs.docker.com
itself is not reachable from a worker's box.

## Which tree the values are read from, and why not "the commit a round
works on"

Issue #355 asks for the values "at the commit being checked". That is
Inspector's half, and Inspector reads them there itself. Fabrica's own
machine-image build reads them from the **build context**, which is the
registered project's checkout - the same tree that build's `COPY` lines
already read the manifest and the lockfile out of (`--build-context
repo=<project>`), and the same tree `machineImageBuild` already reads the
project's `Dockerfile.inspector` and its `buildSecrets` list from.

Reading the version from a different commit than the files copied in would
be the one combination that cannot work: `.ruby-version` is itself copied
into `/deps` for `bundle install` to read, so a `FROM` resolved from
origin's tip while the Gemfile and `.ruby-version` come from the checkout
would have bundler refuse the build ("your Ruby version is X, but your
Gemfile specified Y") - the very failure this issue is about, arrived at
from the other side. One tree, one answer.

## Sharp edges worth knowing

- `finalStageBaseImage` (src/brain/adapters/machine-layer.ts) used to
  return `null` for any `FROM` carrying a `$`, and `machineRestoreUser`
  throws on `null`. So the ARG form alone would have made every converted
  project's machine image "unreadable" - no image, every task refused. It
  now expands `$VAR`/`${VAR}` from the file's own `ARG` defaults plus the
  resolved values the build will pass, and still refuses when a reference
  carries a variable nothing declares.
- The image stamp is the hash of the generated Dockerfile. With the version
  in a build argument instead of the text, a version bump no longer moves
  that text - so the resolved values are hashed with it
  (`machineImageStamp(text, buildArgs)`), which is what makes a bumped
  `.ruby-version` rebuild the worker's box.
- A resolved value lands in a Docker tag and in an argv, so it is validated
  (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, 128 chars) and a value that fails is
  reported and not passed, never passed and hoped for.
- `buildArgs` patterns are matched **one trimmed line at a time**, first
  match wins, first capture group (or the whole match when the pattern has
  no group). No `(?m)`: Fabrica's engine is JavaScript's and Inspector's is
  Go's RE2, and `(?m)` is a syntax error in one of them.
- **This repository is now one of the projects its own doctor line
  reports on.** `Dockerfile.inspector` says `FROM cimg/node:24.18.0`
  while `.node-version` declares 24.18.0, so `fabrica doctor` prints the
  exact replacement lines for it - and nothing converts it, because its
  terms are committed in it. Whoever applies that by hand should know
  that `pinnedNodeVersion` (doctor's own Node check, bound to
  `.node-version` by `src/cli/node-version-pins.test.ts`) reads the
  `FROM` tag: it now resolves the argument form through the file's own
  `ARG` default, so the conversion is safe, and that is pinned by a test
  of its own rather than left to be discovered.
- `src/register/build-arg-e2e.test.ts` is **expected red** until
  `.github/workflows/docker-tests.yml`'s Inspector pin moves to the
  commit that teaches Inspector the `buildArgs` key. It names the pin in
  its own failure message; nothing in it is to be worked around.
