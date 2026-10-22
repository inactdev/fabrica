# Keeping the installed Inspector current (`fabrica update` / `fabrica doctor`)

## Landing this on top of the doctor line that shipped first (#261)

Issue #261 landed `fabrica doctor`'s inspector line before this work
merged, so everything about *reading* a build (`go version -m` parsing,
the pseudo-version grammar, `git ls-remote` for main's tip, the one
`go install` spelling) already exists in `doctor-checks.ts`. The chosen
resolution keeps that side whole and adds exactly two things on top of
it:

1. **One classifier, not two.** `inspectorVersionCheck` gains a
   `state` field alongside its `ok`/`note`/`fix`, and gains the ancestry
   answer as a third parameter. `fabrica update` switches on that same
   `state`, so the command that *installs* and the line that *FAILs* can
   never disagree about what "behind" means.
2. **Ancestry only where master decided on inequality.** The single
   place master called a differing commit "behind" is now the only place
   that asks `commitAncestry`; every other branch of that function
   (unreadable, no commit, no main, a build from a checkout, a commit
   equal to the tip) keeps master's behavior and master's exact wording.

**Rejected: keeping my own parallel `inspectorFreshness` classifier
beside master's `inspectorVersionCheck`.** It was the smaller edit - no
master code touched at all - but the two would have had to agree, by
hand, forever: master's version passes any build stamped from a
checkout, mine refused to install over one for a different reason, and
the first divergence would have had `doctor` printing OK about a binary
`update` had just replaced (or the reverse). Two classifiers for one
question is the defect, not the duplication.

A second, narrower judgment inside that: a build Go stamped from a
*clean* checkout keeps master's automatic pass rather than being
ancestry-checked. It carries a real commit, so ordering it is possible -
but it is a binary someone deliberately built from a tree on this
machine, the Client's clarification names a local build as a state that
"passes with a note naming what it is", and master already decided it.
`fabrica update` leaves it alone for the same reason.

## The public entry point is where this work meets every other task

`src/index.ts` is a single flat list of re-exports, so two tasks that
each add a capability the CLI needs land on the same line of the same
file and conflict there every time - this one has now met that twice
(once against the doctor line that shipped first, once against the
reviewer resolution). The resolution is always the same and is worth
stating plainly: **keep every export from both sides**, leave each
side's own comment block with its own exports, and do not reorder or
re-group the other side's lines while you are in there. Dropping one
side's export does not fail the typecheck of this file - it fails
somewhere under `src/cli/` instead, far from the edit that caused it.

## Where it lives

- `src/inspector/doctor-checks.ts` - reads a build (`readInspectorBuild`
  / `parseGoBuildInfo` / `pseudoVersionCommit`), reads main's tip
  (`fetchInspectorMainCommit`), spells the install once
  (`inspectorInstallCommand` for printing, `inspectorInstallArgs` for
  running), and classifies the two against each other
  (`inspectorVersionCheck` -> `{ ok, state, note, fix? }`).
  `inspectorBranchStatus` is doctor's line on top of that.
- `src/inspector/ancestry.ts` - `commitAncestry`, the only thing here
  that costs real bytes. Takes `repoUrl`/`ref` as options rather than
  importing Inspector's constants, so there is no cycle with
  `doctor-checks.ts`.
- `src/inspector/version.ts` - `fabrica update`'s seam only: the three
  facts as `InspectorVersionProbes`, and `goInstallInspector`, the one
  action only that command takes. It reads nothing itself.

`inspectorVersionCheck` takes the ancestry answer as a *parameter*
(required there, defaulted in `inspectorBranchStatus`), so the default
`npm test` run classifies every state without fetching anything, and the
fetch happens lazily only on the one branch that needs ordering.

## A stale Inspector refuses with a flag error, and that is this work's own case

A refusal reading `flag provided but not defined: -expected-tip` (or any
other flag `src/inspector/run.ts` passes) is **not** a problem in this
repository: it means the Inspector binary installed on the machine
predates the flag Fabrica's own ratified
`src/inspector/consumer-contract.json` already names. The two sides are
kept in step by `.github/workflows/sync-inspector-contract.yml`, but
nothing in that loop reinstalls the binary - so a merged contract change
reaches every checkout immediately and the installed binary only when
somebody reinstalls it, and in between, every publish refuses.

That gap is exactly what the Inspector step added here closes: once
`fabrica update` carries the binary forward with Fabrica, and `fabrica
doctor` FAILs on one behind `main`, a binary too old for the flags
Fabrica passes is caught by the health check before a publish ever
refuses on it. The fix for an already-stale binary is the same
`go install` line both of those print.

## The design chosen, and the one rejected

**Chosen (safest first, then most accurate):** Fabrica reads the
installed Inspector's own module commit out of the binary (`go version
-m`), reads `inactdev/inspector`'s `main` tip with `git ls-remote`, and
- only when those two differ - establishes a *real ancestry* answer by
fetching `main`'s commit graph into a throwaway temp directory
(`git fetch --filter=blob:none`, commits and trees but no blobs: ~250 KB
for this repo, measured) and asking `git merge-base --is-ancestor`.
Behind main is the only state that is stale; ahead of main, on a branch,
or a local build is left alone, named, and never clobbered.

**Rejected: GitHub's compare API** (`GET
/repos/inactdev/inspector/compare/<installed>...<main>`, whose `status`
field answers ahead/behind/identical/diverged in one request). It is
fewer bytes, but it needs a credential to have a usable rate limit (60
requests/hour unauthenticated, per IP - and `fabrica doctor` runs on
every `fabrica up`), it makes a read-only health check depend on an
authenticated third-party API rather than on the same `git` every other
part of this check already uses, and it would be a second way of asking
"how does this commit relate to that one" alongside `git ls-remote`,
which the task names explicitly. The filtered fetch costs one quarter of
a megabyte, only on the path where something is already wrong, and needs
no token at all.

**Also rejected: comparing hash equality alone** (what `fabrica
doctor`'s own "checkout" line does for Fabrica itself). It cannot tell
"behind" from "ahead" or "on a branch", so it would report a
deliberately hand-built Inspector as stale and - in `fabrica update` -
reinstall main's tip over it, silently downgrading it.

## What `go version -m` really prints (measured on this machine, go1.26.8)

Four shapes, all four seen for real, not inferred:

| How the binary was built | the `mod` line's version |
| --- | --- |
| `go install <pkg>@<commit>` | `v0.0.0-20261020120900-4f297d8be50e` |
| `go build` in a *clean* git checkout | `v0.0.0-20261021125757-8783916e454a` (a real commit - Go stamps the local VCS revision) |
| `go build` in a *dirty* git checkout | `v0.0.0-20261021125757-8783916e454a+dirty`, plus a `build vcs.modified=true` setting |
| `go build` with no VCS directory at all | `(devel)` |

So "a local build" is **not** reliably `(devel)` on a current Go
toolchain: a clean local build is indistinguishable from a proxy install
by the version string alone, and the only local-build tell is the
`+dirty` build tag / `vcs.modified=true` setting. This is why the parser
keys "left it alone" on those two signals rather than on `(devel)` only.

Output shape: tab-separated, each line indented by one tab -
`\tmod\t<module path>\t<version>\t<sum>` and `\tbuild\t<key>=<value>`.
`go version -m` exits 1 with `could not read Go build info from <file>:
not a Go executable` for a non-Go binary, and `stat <file>: no such file
or directory` for a missing one. (`go version -json -m` prints the same
`runtime/debug.BuildInfo` as JSON and would be sturdier to parse, but it
is a recent flag; the tab format is ancient and stable, and is what the
task names.)

The pseudo-version grammar is ported from the Go toolchain's own source
rather than from prose: `golang.org/x/mod/module`'s `pseudoVersionRE`
(vendored at `/usr/local/go/src/cmd/vendor/golang.org/x/mod/module/pseudo.go`),
whose comment documents all five forms and whose `parsePseudoVersion`
takes the revision as the segment after the last `-`, with any `+build`
suffix stripped first. The revision is "usually a 12-byte commit hash
prefix" - which is why comparing it against a `git ls-remote` tip has to
be a prefix comparison, never string equality.

## Sharp edges worth keeping

- `proxy.golang.org` answers `403 Forbidden` from inside a worker box
  (the relay's allowlist is GitHub-only), so `go install <pkg>@<commit>`
  only works there with `GOPROXY=direct GOSUMDB=off`. Fabrica runs the
  plain documented command - this matters only for anyone trying to
  reproduce the install from inside a task's box.
- `git ls-remote <url> main` prints the tip of `refs/heads/main` as its
  first whitespace-separated field; `inactdev/inspector` carries no tags
  at all today, so `go install ...@latest` resolves to a pseudo-version
  (a commit) rather than a release version. If it ever gains tags, an
  `@latest` install reports `v1.2.3`, which names no commit, and
  Fabrica reports that it cannot compare it - it does not resolve tags
  to commits.
- An abbreviated 12-character commit resolves fine inside the fetched
  temp repo (`git rev-parse --verify <prefix>^{commit}`), which is what
  makes an ancestry answer possible from a pseudo-version at all. A
  commit that is not in `main`'s history does not resolve there, and
  that failure is itself the "not behind" answer.
