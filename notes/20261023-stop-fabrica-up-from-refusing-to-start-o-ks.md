# A doctor finding now has a severity, and `fabrica up` reads it

Client ruling 2026-10-23. `fabrica up` used to stop on `fabrica
doctor`'s exit code, which cannot tell one kind of `FAIL` from another,
so a finding that stopped no task from running still cost the Client a
whole session.

## The mechanism, and the one rule that matters about it

`DoctorCheck` (`src/cli/doctor-command.ts`) gained two optional fields:

- `blocking?: boolean` - **absent means blocking.** Read in exactly one
  place, `stopsATask(check)`. The default is deliberately the strict one:
  a check added later keeps stopping `up` until somebody decides
  otherwise, instead of slipping in as advisory because nobody thought
  about it.
- `note?: string` - something worth saying about a check that *passes*.
  Only "behind origin/master" uses it today. `up` would otherwise
  swallow that fact entirely, since it prints doctor's own output only
  when it stops.

`advisoryLine(check)` renders the one `WARN` line `up` prints for either
shape, and `stopsATask`/`advisoryLine` are the only readers of both
fields. `fabrica doctor` itself is untouched: every `FAIL` is still a
`FAIL` and still exits 1. **This is a severity, not a downgrade** - if a
future change makes one of these advisory findings print `OK`, that is a
different (and wrong) thing.

Two checks opt out today, both about which copy of `fabrica` is on this
disk and how it got there: every `checkout` failure, and a leftover `npm
link` symlink (by the time it is called leftover it stands at a prefix
the running copy did not come from, so it breaks the next `npm install
-g` and nothing else).

## This closes a bug that was not a corner case

`notes/20261022-change-fabrica-update-s-installed-copy-p-ne.md` recorded
that a global `github:` install on today's npm always writes
`build-info.json` = `{"commit":null}`, so `checkoutCheck` failed for
*every* installed copy and - its words - "`fabrica up` stops on any FAIL
- so an installed copy cannot start a session on this npm." That
sentence is now out of date in two respects, one from each side. The
install side was answered by the clone-then-pack procedure (issue #171's
follow-up, `notes/20261023-make-an-installed-copy-always-know-its-c-y0.md`):
a copy installed that way knows its own commit, and one that still
cannot now says why in `build-info.json`'s own words rather than
reporting a bare unknown. The session side is this change: a copy that
cannot name its commit - the one-step GitHub-spec install still cannot -
is a `FAIL` with the real install procedure as its fix, and no longer a
refusal. The two are independent: fixing how a copy is installed does
not decide whether the finding should cost a session, and this one does
not decide how anything is installed.

## Findings deliberately left blocking

Judgment calls, listed so they are known rather than missed. All still
stop a session, because each one either makes a task impossible or was
deliberately made blocking by an earlier ruling: docker, worker image,
relay image, worker CLI version, worker token, GitHub token, inspector
(the stale-Inspector `FAIL` was built to stop `up` on purpose -
`src/inspector/doctor-checks.ts`), an unparseable `projects.toml`, no
projects registered, each project's own line, `SPEND UNKNOWN`, and
`caps` not being set. The last two are the arguable ones: an unset cap
makes no task impossible, but it is about money rather than plumbing, so
it was left alone for the Client to rule on.

## Starting Docker on a Mac

`src/cli/docker-daemon.ts`'s `ensureDockerDaemon` is step 0 of `fabrica
up`: daemon down and `process.platform === "darwin"` → `open -a Docker`,
then poll `docker info` for up to two minutes, printing elapsed-vs-ceiling
lines while it waits.

- macOS-only, gated before any process is spawned - same gate and same
  reasoning as `src/containment/caffeinate.ts` (`open` is a macOS
  binary; this project's own tests and CI run on Linux).
- It can never fail the command. `open` failing, or the daemon never
  answering, just leaves doctor's own docker check to fail as it always
  did. A daemon already up prints nothing, so the common case reads
  exactly as before.
- Whether Docker Desktop is installed is never inferred - `open`'s own
  failure output ("Unable to find application named 'Docker'") is passed
  straight through. A `docker`-CLI-on-PATH precheck was considered and
  rejected: Docker Desktop installs its CLI symlinks on first run, so a
  freshly installed, never-launched Docker would have looked
  "not installed" and never been started.
- `dockerDaemonUp()` lives here now and `realProbes.docker` calls it, so
  "the daemon answers" has one definition shared by the check and the
  starter.

## Reading doctor from another command

`collectDoctorChecks({ recordHome, probes, live })` returns the checks as
objects; `formatDoctorLine(check)` renders the one line doctor prints.
`runDoctorCommand` is now those two plus the exit code, and `fabrica up`
uses the same pair - so the two commands can never disagree about which
checks ran, in what order, or how a line reads. Anything else that needs
doctor's findings should go through them rather than a third list.
