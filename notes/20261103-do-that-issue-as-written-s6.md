# Installing Inspector where PATH actually resolves it (issue #339)

## The bug, in one sentence

`go install <pkg>@<rev>` puts the binary in Go's own GOBIN
(`$GOBIN`, else `$(go env GOPATH)/bin`, else `~/go/bin`), which has
nothing to do with which `inspector` the shell - and therefore every
Fabrica task - actually runs. On a host whose PATH prefers
`~/.local/bin` (dotfiles' work host pins `GOBIN` there in
`work/bootstrap.sh` because `work/zshrc` is what puts it on PATH),
`fabrica update` installed a fresh Inspector into `~/go/bin`, exited 0,
and reported `inspector <sha> -> <same sha>` - reading the *unchanged*
binary PATH still resolved. Silent no-op, reported as an ordinary
result.

## The design chosen (safest first, then most accurate)

1. **Point the install at the directory PATH already resolves.**
   `goInstallInspector` resolves `inspector` on PATH exactly the way
   `fabrica doctor`'s own inspector line does (`resolveCommandPath`),
   takes that binary's directory, and runs the install with `GOBIN` set
   to it. Go's documented precedence is GOBIN first, so this is a
   documented knob, not a trick - and the `pkg@version` form honours it
   like every other (`go help install`: "Executables are installed in
   the directory named by the GOBIN environment variable, which defaults
   to $GOPATH/bin or $HOME/go/bin if the GOPATH environment variable is
   not set"). Only when no `inspector` is on PATH at all does it fall
   back to Go's own GOBIN, read with `go env GOBIN GOPATH` (`go env`
   prints each named variable on its own line; GOBIN prints *empty* when
   unset - its `$GOPATH/bin` default is resolved internally and never
   reported as GOBIN's value, so an empty first line means "use the
   second line plus /bin").
2. **Verify, don't assume.** After a successful install, the round-trip
   check re-reads the build of the inspector *PATH resolves* and compares
   it against the commit that was asked for, using the same
   prefix-aware `sameCommit` the freshness classifier uses (a
   pseudo-version carries a 12-hex abbreviation; the target is a full
   40-hex sha, so string equality is wrong here). Not reaching the
   target is its own loud outcome naming both directories - never an
   "unchanged" version.
3. **Doctor's fix line names `fabrica update`.** The raw `go install`
   has the exact flaw this issue is about, so printing it as the fix on
   this kind of host tells the Client to run something that cannot work.

### Alternative rejected: keep installing into Go's GOBIN and only *warn* when that directory isn't on PATH

Strictly smaller (no GOBIN override, no round-trip read) and it would
have made the work-Mac failure visible. Rejected because visible is not
fixed: the Client would still have to install Inspector by hand on that
host, every single time, which is exactly the "every hand command is a
smell" the standing rulings name. Setting GOBIN to a directory the
machine has already demonstrated is both writable and on PATH - it is
where the binary being replaced lives - is the safer of the two, because
a wrong guess fails loudly (`go install` refuses a GOBIN it cannot write)
instead of succeeding into a directory nobody reads.

A second, narrower judgment: the install directory is
`dirname(<the path PATH resolved>)` with **no** `realpath`. If
`~/.local/bin/inspector` is a symlink into `~/go/bin`, installing into
`~/.local/bin` replaces the symlink with a real binary - which is the
state the issue asks for ("the directory holding the inspector that PATH
resolves today") and is self-healing afterwards. Following the symlink
would reintroduce the bug on precisely the host that symlinked around
it.

## Sharp edges

- `go env GOBIN` is empty when unset, and `go env` is the *only* honest
  reader of it: `GOPATH` may itself be set in Go's own config file
  (`go env -w`, reported via `GOENV`) rather than in the process
  environment, so reading `process.env.GOPATH` would miss it. That is
  why the fallback shells out to `go env GOBIN GOPATH` instead of
  reading the environment directly.
- `go install` with a GOBIN that does not exist or is not writable fails
  with `go install: no install location for directory` / a permission
  error. That is reported, never swallowed - and it can still never fail
  `fabrica update` as a whole (standing ruling), only read as a failure
  in its summary line.
- The same "installed somewhere, ran from somewhere else" shape exists
  for Fabrica's own global npm install, and is already handled the other
  way round there: `npm-prefix.ts`'s `prefixOfGlobalInstall` derives the
  prefix from the *running* copy's own path rather than npm's default,
  for the same reason. Nothing else in this repository shells out to an
  installer whose destination it does not pin: `machine-image.ts` and
  `global-reinstall.ts` both name their target explicitly.
