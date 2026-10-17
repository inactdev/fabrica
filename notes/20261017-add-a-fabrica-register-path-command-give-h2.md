# `fabrica register <path>` — the one command allowed to push

## The design decision, written before the change

Three shapes were available for where `register`'s real work lives.

**Chosen: a new `src/register/` module, with `src/cli/register-command.ts`
as a thin driver over it.** Safest first: every step that can refuse does
so *before* anything is created, and the three things that reach outside
this machine (`gh`'s auth state, the Docker daemon, `gh pr create`) plus
the containerized check run sit behind one injectable `RegisterTools`
seam, so the whole flow — including the real `git worktree add`, commit,
push to a real bare origin, and teardown — is testable without a Docker
daemon, a GitHub account, or a network. Real git against real fixture
repositories is already this project's convention (`src/line`'s own
tests), so git stays real and only the genuinely-outside things are faked.

**Rejected: putting the whole flow in `src/cli/register-command.ts`**, the
way `fabrica update` keeps its `git pull`/`npm install` inline. It would
have been fewer files, and `update` is the local precedent. But `update`
has two machine actions and no state to unwind; `register` has eleven
ordered steps, a temporary git worktree that must be torn down on every
failure path, and a `projects.toml` write that must not corrupt the
Client's own file. That is a module's worth of behavior, and AGENTS.md's
module-layout rule (`errors.ts` + one file per behavior + `helpers/`) is
exactly the shape it wants. A single 500-line CLI file would also have
left the origin/default-branch logic unreachable from `fabrica do`, which
needs the same answer for its new up-front refusal.

Also rejected: deciding "is this project set up" from the project's
**local** `HEAD` instead of origin's default branch. It needs no fetch, so
it is faster — and it is wrong for the same reason `src/line/cut.ts`
refuses to cut a line from the local checkout: a task's base commit comes
from origin, so whichever branch the Client last checked out locally has
no bearing on whether a task would find `.inspector.json`. `fabrica do`
pays one `git fetch` up front to answer the question it is actually
asking. Any failure to answer it (no origin, origin unreachable) is
treated as "unknown" and lets the existing downstream error speak, rather
than mislabelling an unreachable remote as an unregistered project.

## Facts worth keeping

- **`.inspector.json`'s schema was taken from this repository's own
  working copy**, not from Inspector's documentation: `github.com`,
  `raw.githubusercontent.com`, `api.github.com` and every manpage mirror
  are unreachable from a worker box, so Inspector's README could not be
  read. The authoritative in-repo evidence is `/.inspector.json` (a live
  config the real Inspector acts on in this repo's own CI, via the
  `inspector` commit status) plus `contract/helpers/fixture.ts`'s
  `FIXTURE_INSPECTOR_CONFIG`, which proves the minimal two-key form
  (`check`, `image`) is valid. `register` writes exactly `check`, `image`
  and `protectedPaths` — never a key neither of those two files shows.
- **`gh`'s flags were read from its current manual** (via search, since
  `cli.github.com` itself is blocked): `gh pr create` prints the new pull
  request's URL to stdout on success, and `--title` + `--body-file` +
  `--base` + `--head` together are what make it fully non-interactive —
  with `--head` specifically being the flag that stops it offering to push
  or fork. Its documented sharp edge is handled in `tools.ts`: it can exit
  non-zero while still having printed a real pull request URL, so a URL in
  stdout wins over the exit code (otherwise `register` would refuse after
  having already opened the pull request).
- **`gh auth status` exits 1 when *any* stored host has a problem**, not
  just the one being used. `register` therefore always scopes it with
  `--hostname <host parsed from origin's URL>`, so a stale token for an
  unrelated GitHub Enterprise host can't make a perfectly good GitHub
  login read as "not logged in".
- `git worktree add --no-track` is used for the same reason
  `src/line/cut.ts` uses it: tracking configuration is a write to the
  project's *shared* `.git/config`, which two concurrent git operations
  can collide over, and a throwaway branch has no business tracking
  anything.
- **The whole suite runs on `node --test` with no `node_modules` at all,
  which is how it was verified here.** A worker box can have no route to
  `registry.npmjs.org` (every `npm install` in this task returned 403),
  so `npm test`'s `tsc --noEmit` and `tsx --test` were both unavailable.
  Node 24 strips TypeScript types natively, and nothing under `src/`,
  `contract/`, `integrations/` or `skill/` uses non-erasable syntax (no
  enums, no namespaces, no parameter properties), so
  `node --test $(find contract src integrations skill -name '*.test.ts' | sort)`
  runs the identical file set `package.json` discovers. Three throwaway
  stand-ins under the gitignored `node_modules/` closed the remaining
  gaps, and were deleted afterwards: a strict TOML-subset `smol-toml`, an
  empty `tsx/esm` (the real one only has to *resolve* — Node does the
  stripping), and a `.bin/tsx` shell script that `exec node "$@"`.
  Useful next time, with its limits stated plainly: this runs the tests
  but **does not typecheck**, and a shimmed `smol-toml` is not the real
  parser — three `src/config` tests fail against a naive one (TOML
  datetimes, `inf`/`nan`, and a table literally named `__proto__`, which
  needs `Object.create(null)`), and those failures are the shim's, not
  the code's.
- On a failure after the branch was created but before it was pushed,
  `register` deletes the local `fabrica/register` branch as well as the
  worktree, so a retry with a corrected `--check` is not blocked by the
  wreckage of the previous attempt. After a *successful* push it leaves
  the branch alone — it is on origin, and deleting a branch the Client may
  want is never this command's call.
