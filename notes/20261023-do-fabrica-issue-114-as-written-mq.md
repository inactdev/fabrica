# Proposing an `.inspector.json` (issue #114)

## The design decision, written before the change

The Client's clarification fixed three of the four open questions:
the proposal is part of `fabrica register`, stdout is the JSON alone with
one reasoning line per field on stderr, and the derivation is Fabrica's
own deterministic parsing (no machine), with an existing `check.sh`
winning any disagreement and the disagreement named on stderr.

**Chosen: a pure `src/register/propose.ts` — one reader (`git show` against
origin's default branch) and one total function over the signals it read —
reached from `registerProject` at exactly the point the
`missing-check-or-image` refusal used to be, and carried out to the CLI on
a `RegisterProposalError` so the two streams stay separate.**

Why this and not the alternatives:

- **Safest.** The proposal lands *after* `prepare()`'s whole refusal
  cascade, so it is only ever printed for a repository `register` could
  genuinely set up. A project already in `projects.toml`, a bad name, an
  unreadable origin, a leftover `fabrica/register` branch — each still
  refuses with its own words, as before, rather than being answered with a
  config proposal. Nothing is written on this path at all: no worktree,
  no branch, no `projects.toml` entry, exit 1.
- **Most accurate.** Signals are read from **origin's default branch**
  (`git show origin/<branch>:<path>`), the same ref the
  "does this repo have `.inspector.json`" question was already asked
  against and the ref a task's base commit is actually cut from — not the
  Client's local working tree, which may be mid-edit or on a feature
  branch. The derivation itself is a pure function over three read
  strings, so every rule is unit-testable with no git at all.
- **Fastest to read and to extend**: the only git in it is one `git show`
  per signal file, on a ref already fetched a step earlier.

**Rejected: returning a `kind: "proposal"` variant from
`registerProject`.** It reads better than throwing — a proposal is a
result, not an error. But `RegisterResult` would have had to become a
discriminated union (`check`, `tomlPath`, `tomlEntry` are required and
meaningless for a proposal), and every existing
`const result = await registerProject(...)` site then loses its narrowing,
for no behavioral gain. Throwing is also the honest shape: this path
refuses, registers nothing, and exits non-zero, exactly like the
`missing-check-or-image` refusal it replaces. The error subclass carries
the proposal as data so the message and the document never have to be
parsed apart.

**Also rejected: building the proposal in `src/cli/register-command.ts`
before calling `registerProject` at all.** It needs no `gh` and no Docker,
so running it first would be friendlier to someone whose `gh` login is
stale. It would also duplicate `prepare()`'s repo/origin/default-branch
reading in the CLI layer, and — worse — would answer "this project is
already registered" with a config proposal. Refusals first, proposal last.

**Also rejected: `fabrica propose-inspector-config` as its own
subcommand.** The Client's answer to question 1 was explicit ("part of
`fabrica register`"), and a separate command would need its own slot in
`help.ts`, its own skill allow-list decision, and its own repo checks.

## Why some fields are proposed as *omitted*

`.inspector.json`'s established convention in this repository
(`src/register/scaffold.ts`) is that **off is the absence of the key** —
never `network: false`, never `timeoutSeconds: 0` — because only values a
live config has been seen to carry are ever written. The proposal follows
it:

- `timeoutSeconds` is **always** omitted. Nothing in a `package.json`, a
  `go.mod` or a `check.sh` says how long a check takes, so any number here
  would be invented, and the invented number would be the one deciding
  whether a real check is killed mid-run. The stderr line says so and says
  Inspector's own default stands. (A CI workflow's `timeout-minutes:` is
  the one real signal in a repository, and it is deliberately not read:
  workflow files are not among the signals issue #114 names, and this
  repository ships no YAML parser.)
- `protectedPaths` is omitted when the check is an indirect command
  (`npm test`, `go test ./...`), per the Client's answer to question 4:
  which file freezing `npm test` means — the script file, `package.json`,
  the lockfile, all three — is his decision, named on stderr rather than
  guessed.

## The one place the proposal deliberately disagrees with `register`'s own writer

`scaffold.ts`'s `protectedPathsFor` **always** lists both `check.sh` and
`.inspector.json`. The proposal lists neither `.inspector.json` nor any CI
workflow file, by the Client's direct ruling on question 4: "the gate
already protects those on its own." So for a `./check.sh` project,
`register --check ... --image ...` writes `["check.sh", ".inspector.json"]`
while the proposal prints `["check.sh"]`. That is not a bug in either one;
it is two different authorities, and the stderr line for the field says
why the second is shorter. If the two should ever agree,
`protectedPathsFor` is the one to change, under a ruling.

## Why the image can be a loud placeholder

A repository almost never names a container image. The one in-repo
evidence of how to turn a declaration into an image name is this
repository's own `.inspector.json`, which pairs
`engines.node: "24.18.0"` with `image: "cimg/node:24.18.0"` — a live
config the real Inspector acts on. So an exactly-pinned `engines.node`
derives `cimg/node:<version>`, and nothing else derives anything:

- a *range* (`">=24"`, `"^24.1.0"`) names no single tag;
- `go.mod`'s `go 1.22` has no in-repo precedent for a Go image at all, and
  `cimg/go:1.22` could not be verified from a worker box (Docker Hub is
  unreachable there, like every other outside host — see the
  `fabrica register` note from 2026-10-17).

In those cases the proposal writes
`REPLACE-ME-with-an-image-that-ships-<what>` rather than a guess. The
uppercase makes it an **invalid** Docker reference — a Docker repository
name must be lowercase — so a proposal committed without reading it fails
loudly at the first pull instead of silently resolving to something
plausible. `register`'s own proving run pulls the image and refuses on a
bad one, which is the backstop either way.

## Facts worth keeping

- The proposal is a **refusal**: exit 1, nothing registered. Deliberate,
  so `fabrica register <path> && fabrica do ...` cannot read a proposal as
  a successful registration. The document goes to stdout through one
  `console.log`, so `fabrica register <path> > .inspector.json` yields the
  file with exactly one trailing newline.
- `RegisterErrorCode`'s `missing-check-or-image` is **gone**: the
  proposal replaced its only thrower, the same way `attempts-exhausted`
  was deleted from `src/foreman/errors.ts` when its thrower went. The new
  code is `proposed`.
- `network: true` has exactly **one** trigger: the check's own text names
  a dependency installer (`npm ci`, `pip install`, `go mod download`,
  ...), quoted back as the check spells it rather than as a label for it.
  Declared dependencies with no install step deliberately do **not** turn
  it on — network access does not conjure `node_modules`, so a bare
  `npm test` fails in a fresh box whether the network is there or not.
  That trap is named on the stderr line instead of papered over with a
  `true` that would not fix it.
- A `package.json` `"test"` script is searched for an installer too, not
  just the `npm test` that invokes it, so `"test": "npm ci && vitest"` is
  seen.
