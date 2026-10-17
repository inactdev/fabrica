# The repo declares its own Node version now (Node 24, in four places that agree)

Before this, nothing in a checkout of Fabrica said which Node Fabrica
runs on. The version was implied by four *other* things, none of which a
contributor's shell or a fresh CI runner reads: `.inspector.json`'s
`cimg/node:24.18.0`, the worker image and the relay image (both
digest-pinned `node:24.18.0-alpine`, see
`src/brain/adapters/docker/Dockerfile` and
`src/relay/container/launch.ts`), README's "Prerequisites: Node 24", and
a number typed by hand into `.github/workflows/docker-tests.yml`.

What's there now:

- **`.node-version`** containing `24` - the file `nvm`/`fnm`/`asdf`/`mise`
  read in a contributor's shell, and a documented value for
  `actions/setup-node`'s `node-version-file` input.
- **`package.json`'s `"engines": { "node": "24" }`** - the declaration
  npm itself checks.
- **`.npmrc`'s `engine-strict=true`** - what makes that declaration
  binding rather than advisory.
- **`docker-tests.yml`** reads `node-version-file: .node-version`
  instead of a hardcoded number, so the CI runner's Node and the
  declaration can no longer disagree.

## Why: the hardcoded 22 was never what this project runs

`docker-tests.yml` originally pinned `node-version: "22"`. That was not a
considered decision about a supported range - nothing else in the project
has ever been built or verified on Node 22, and the required-status-check
job was the only place that number existed. It is also the direct cause
of the three "cancelled" tests that showed up on that job **and nowhere
else** (same-day sibling note,
`notes/20261017-fabrica-issue-106-as-written-a-github-ac-lf.md`): three
consecutive tests in `src/cli/deny-and-log-edit-command.test.ts` drove
`readStdin` with a fake stdin holding no real OS handle, so an `unref()`'d
deadline timer was the only thing that could resolve the awaited race -
on Node 22 the event loop shut down before it fired, leaving the promise
unsettled, which `node:test` reports as "cancelled" and propagates to
every test after it in the file (nodejs/node#49952). The Client reproduced
it on Node 22 in under a second and could not reproduce it on Node 24.
Nobody running `npm test` locally on Node 24 could have seen it; it took
exactly the mismatched pin to surface at all. That pin has since been
changed to `"24"` by hand, and this change replaces the hand-typed number
with the file so the next divergence cannot be introduced by typing one.

## What `engine-strict` actually does here, verified rather than assumed

npm 11's own docs for the flag say it refuses to install "any package
that claims to not be compatible with the current Node.js version" -
wording about *dependencies*, while the package that matters here is this
repo itself. Checked empirically against this repo's real
`package.json`/`package-lock.json`/`.npmrc` copied into a scratch dir,
with the engines range temporarily bumped to an impossible `99`:

- Wrong Node: **both `npm install` and `npm ci` exit 1** with
  `npm error code EBADENGINE`, naming required vs. actual, *before* any
  registry traffic.
- Correct Node (`24`, this sandbox runs v24.18.0): the engines gate is
  passed entirely.
- `npm ci` reads that range from **`package.json`, not from
  `package-lock.json`'s root entry** - it refused on a lockfile written
  before the range existed. (The lockfile's root entry does carry the
  range now anyway: `npm install --package-lock-only` wrote exactly those
  three lines and nothing else, so a future install produces no
  incidental diff.)
- Without the flag the same mismatch is only `npm warn EBADENGINE` and
  the install proceeds - which is what "declaring it" would have been
  worth on its own: nothing.

Safe for the current dependency tree: every `engines` range recorded in
`package-lock.json` is `>=14.17`, `>=18`, `>= 18`, `>=18.0.0`, or
fsevents' `^8.16.0 || ^10.6.0 || >=11.0.0`, all satisfied by Node 24, so
no dependency is newly refused.

## Two deliberate non-changes

- **`fabrica doctor`'s own `node` check still reads `.inspector.json`**
  (`doctor-command.ts`'s `pinnedNodeVersion`, regex `node:(\d+\.\d+\.\d+)`),
  not `.node-version`. That is on purpose: doctor compares the *exact
  patch* the check box runs (`24.18.0`) and fails on any difference,
  which `.node-version`'s major-only `24` cannot express. The two are now
  one more pair that has to stay in step - bumping Node means
  `.node-version`, `package.json`, `.inspector.json`, and both image
  digests, and `npm ci` on CI is what notices if the first two drift from
  the runner.
- **No test asserts the four declarations agree.** `engine-strict` plus a
  runner whose Node comes from `.node-version` already makes `npm ci`
  itself fail loudly on exactly that drift, so a test would restate a
  check CI performs for real - and `*.test.ts` is a protected path
  (issue #96) needing the Client's direct review, which is a poor trade
  for no added safety.

## One related divergence found and deliberately left alone

`devDependencies` still pins `@types/node: ^22.20.1`, so the suite
typechecks against **Node 22's** type definitions while running on Node
24 - the same class of mismatch as the CI pin this change removes, just
at the types layer rather than the runtime. Not touched here: the brief
named four files, and a `@types/node` bump cannot be verified from inside
a task box (no registry tarball access - `npm ci` fails with `E403`), so
proposing one blind would be the guess this project's own rules forbid.
Worth a small issue of its own.

## Packing behavior, since it changes what an installed copy carries

Confirmed with a real `npm pack --dry-run` plus npm's own always-ignored
list: **`.npmrc` is never packed** (so `engine-strict` binds work inside a
checkout of this repo and never leaks into a consumer's npm config),
while **`.node-version` is packed** (3B, harmless). `engines` ships in
`package.json` either way, so `npm install -g github:inactdev/fabrica` on
a non-24 Node now warns `EBADENGINE` - and refuses outright during the
git-clone `prepare` step, where this repo's own `.npmrc` is present -
instead of installing a copy that silently runs on the wrong runtime.

## Documentation reachability from inside a task box

`WebFetch` was blocked for `docs.npmjs.com`, `github.com`, and
`raw.githubusercontent.com` ("Unable to verify if domain ... is safe to
fetch"), and there is no `curl` binary. Two things that did work and are
worth reaching for next time:

- **npm's own docs ship with npm**:
  `/usr/local/lib/node_modules/npm/docs/content/**` (plus `man/man7`) is
  the installed npm's authoritative documentation, offline - used here for
  `engine-strict` and the always-ignored-files list.
- **`WebSearch` works** where `WebFetch` is blocked - used here for
  `actions/setup-node`'s `node-version-file` input (supported files
  include `.node-version`; `node-version` wins if both are given;
  relative paths resolve against `GITHUB_WORKSPACE`, so the step must
  come after `actions/checkout`, as it does).
