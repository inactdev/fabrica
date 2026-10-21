# `fabrica doctor`'s inspector line reports installed versus origin main

Task: make a stale Inspector binary a real `fabrica doctor` FAIL with the fix printed.
Client clarifications: compare the module commit embedded in the installed binary (`go version -m`)
against `origin main`'s tip from `git ls-remote`; one `ls-remote` per run; unreachable remote passes
with a note; print exactly `go install github.com/inactdev/inspector/cmd/inspector@<main sha>` in the
fix slot; only *behind* main is a FAIL (ahead, or a local dev build, passes with its commit named);
a stale binary makes `doctor` exit non-zero, because `fabrica up` stops on it.

## Design decision, and the alternative rejected

Safest-first ordering put the comparison on facts already embedded in the artifact that will actually
run. The binary's own build record is read with `go version -m <resolved path>`, so the line describes
the executable Fabrica will hand work to, not a checkout that happens to be on the machine.

**Rejected: `inspector -version` (or any flag asking Inspector to report its own version).** It would
have been one cheap call instead of two, but it is a second source of truth Inspector would have to
keep honest, it does not exist on today's binary, and adding it would mean changing Inspector's side
first. `go version -m` reads what the Go toolchain already stamped, for every build, with nothing for
either side to maintain. Rejected secondarily: cloning Inspector to compute real ancestry (would make
"ahead vs behind" exact, but `doctor` must spend nothing and mutate nothing).

## Go facts, verified against a real toolchain rather than assumed

Checked by a real `go install github.com/inactdev/inspector/cmd/inspector@latest`, a real `go build`
in a clone of that repository (clean and dirty), and a real install of an older commit:

- `go version -m <binary>` prints a header line, then tab-indented, tab-separated records:
  `path`, one `mod` (the main module - later `mod`-shaped lines are `dep`s), then `build` settings.
- A module install's `mod` version is a pseudo-version, e.g. `v0.0.0-20261020120900-4f297d8be50e`,
  whose last field is the commit **abbreviated to 12 characters** - so comparing it against
  `ls-remote`'s 40-character sha is a prefix comparison, not equality.
- `go install <package>@<full 40-char sha>` is accepted, and resolves to that same pseudo-version.
  The printed fix was run against a real stale install and really did turn the line green.
- Go stamps `vcs=git` / `vcs.revision` (full sha) / `vcs.modified` only for a build from a VCS
  checkout, never for `go install <package>@<version>` - that presence is what distinguishes a dev
  build from an installed one. Note for Go >= 1.24: a local build's `mod` version is **not** `(devel)`
  any more, it is a VCS-derived pseudo-version (with `+dirty` when the tree is modified), so
  `(devel)` must not be the dev-build test.
- Go's pseudo-version pattern has three forms and they do **not** all separate the timestamp with
  `-` (`v1.2.4-0.<ts>-<rev>` and `v1.2.3-pre.0.<ts>-<rev>` use `.`). The regex is therefore copied
  from the toolchain's own source (`golang.org/x/mod/module`'s `pseudoVersionRE`, vendored at
  `$(go env GOROOT)/src/cmd/vendor/golang.org/x/mod/module/pseudo.go`) with the revision captured.
  An eyeballed `-\d{14}-([0-9a-f]{12})$` passes the common case and silently fails the other two.

## Testing a PATH-resolved external tool without the network

`src/inspector/doctor-checks.test.ts` already shimmed `gh`/`inspector` onto a throwaway `PATH` and
passed that `env` in. The same trick covers `go` and `git` here, which works because libuv replaces
the child's `environ` before `execvp`, so a command named bare is resolved against `options.env.PATH`
rather than the parent's. That keeps every test offline while still exercising the real spawn and the
real parser - worth preferring over injecting probe functions, which would have tested the wording
and skipped the parsing.

## The duplicated shape, named rather than merged

`git ls-remote <url> <ref>` with a 10s timeout, `null` on any failure, reported but never failed on,
now exists twice:

- `src/cli/doctor-command.ts`'s `fetchRemoteMasterCommit` - Fabrica's own upstream, branch `master`,
  URL hardcoded, no `env`.
- `src/inspector/doctor-checks.ts`'s `fetchInspectorMainCommit` - Inspector's repository, branch
  `main`, `env` passed through so tests can shim `git`.

Left as two on purpose: different repositories, different default branch names, and sharing one would
mean either `src/inspector/` owning a probe about Fabrica's own upstream or `src/cli/` exporting one
downward, which the layering rule (`src/cli/` reaches `src/` only through `src/index.ts`) forbids.
Worth folding into a neutral helper only if a third caller appears.
