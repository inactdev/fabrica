# The machine's box is built from the project's `Dockerfile.inspector` (issue #322)

## The decision, and the two designs rejected before it

**What landed.** For a project carrying a `Dockerfile.inspector` (in the
repository, or in its terms folder in work mode), Fabrica generates a
Dockerfile that is *that file verbatim*, followed by Fabrica's own layer,
and builds it as `fabrica-machine-<slug>-<hash of the project path>:latest`.
The machine's box and the self-test check box both start from that image.
A project with no `Dockerfile.inspector` keeps the shared image exactly as
before.

**Rejected: `FROM <the image Inspector built>`.** The issue's own wording
("builds the machine's image FROM that project's image") reads like this,
and it would avoid rebuilding the project's own layers twice. It was
rejected because Fabrica does not own, and cannot see, the tag Inspector
builds under: pinning one here would be a second, undeclared contract
between the two sides (issue #109 exists because that kind of pin drifts),
and the machine's image would silently depend on Inspector having been run
at least once. Concatenating the project's own file is self-contained -
Fabrica builds from the same *source* Inspector builds from, which is the
property the issue actually asks for, and Docker's layer cache makes the
second build of the project's own stages nearly free.

**Rejected: resolving the image inside the adapter from `workdir`.**
`resolveCommonGitDir(workdir)` would yield the project path with no
plumbing at any call site. It was rejected because `fabrica doctor` has to
report the image a round will actually use: resolving it in two places
(doctor's own line, and the adapter's own look at its workdir) is exactly
the "two answers to one question" shape `src/workmode/` and
`src/projecttoken/` exist to prevent. `src/projectimage/` is one resolver
with several readers instead.

## Why Fabrica's layer installs its own Node off `PATH`

The layer puts Node under `/opt/fabrica/node`, which is **not** added to
`PATH`, and exposes exactly one new command - a `claude` wrapper at
`/usr/local/bin/claude` that execs that Node directly.

Prepending Fabrica's Node to `PATH` would shadow the project's own
toolchain: a Node project whose `Dockerfile.inspector` is pinned to some
other Node would then run its check on Fabrica's version in the machine's
box and on its own in Inspector's box - reintroducing, one layer down,
exactly the divergence this issue exists to remove. Appending it instead
would leave the CLI's own `#!/usr/bin/env node` resolving to the
project's Node, which is the same bug pointed the other way. A wrapper
that names the interpreter explicitly is the only arrangement where
neither side can shadow the other.

The wrapper's target is read back from what `npm` actually installed
(`readlink -f` on the installed `claude`), never a guessed path inside the
package.

## Sharp edges worth knowing

- **Both pins live in `src/brain/adapters/docker/Dockerfile`.** The layer
  reads the Node version from that file's `node:<x.y.z>-alpine` tag and the
  CLI version from its `npm install -g` line (`pinnedCliVersion`), so a
  bump moves one file. `src/cli/node-version-pins.test.ts` binds the
  layer's Node version to `.node-version` along with the other four.
- **The layer fails the build, loudly, on anything it needs and cannot
  install**: no `bash` (the CLI's own Bash tool needs a real one - issue
  #89), no `git` (the read-only `.git` mount is useless without it), no
  `curl`/`wget`, no `sha256sum`/`shasum`, an architecture Node publishes no
  build for, or a libc Node publishes no build for. Each message names the
  missing thing and what to add to `Dockerfile.inspector`.
- **Node is verified against `SHASUMS256.txt` from the same release
  directory**, fetched at build time rather than a checksum pinned here:
  nothing offline can keep a pinned checksum honest across a Node bump,
  and a missing line in that file is what makes an unpublished build
  (musl, say) fail by name instead of silently.
- **The stamp is the hash of the generated Dockerfile**, passed in as
  `--build-arg FABRICA_IMAGE_STAMP` and stored under the same
  `fabrica.dockerfile-sha256` label the shared image uses. It therefore
  moves when either input moves - the project's file, or Fabrica's layer
  (which carries both pins). It does **not** move when the project's
  dependencies do: a `package-lock.json` change is Docker's own cache
  question, exactly as it is for Inspector's box.
- **The build context is the repository**, even for a project whose terms
  live outside it - that is where the `COPY` lines in the common
  `Dockerfile.inspector` shape (`package.json`, `package-lock.json`) point.
- **The generated Dockerfile is written under `<recordHome>/images/`**,
  and only ever by the step that is about to build it. Plain `fabrica
  doctor` stays read-only, which is why its fix line for a missing image is
  `fabrica doctor --fix` rather than a `docker build` command the Client
  could paste (there would be no file for it to point at).
- **`fabrica quiz` re-checks still run in the shared image.** They read a
  scratch checkout and run no project check, and one re-check run covers
  several tasks across different projects, so there is no single project
  image for it to use.
