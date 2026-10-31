# A third dependency shape: Ruby, with servers inside the check box (issue #324)

`fabrica register` now recognizes a `Gemfile.lock` alongside
`package-lock.json` and `go.sum`. The mechanics and the per-field
reasoning are in `src/register/README.md`'s "The Ruby shape" section;
what follows is only what a future task would otherwise have to
rediscover.

## `Gemfile.lock` is the one lockfile read in full, and that is the point

The other two shapes are decided by a lockfile's *presence*
(`package-lock.json` is routinely a megabyte, and nothing cared what was
inside). This one cannot be: whether the check box has to run PostgreSQL
and Redis is written inside the lockfile and nowhere else. So
`ProposalSignals.gemfileLock` carries contents, and `gemsIn` parses it —
four-space `specs:` entries only, never the six-space requirement lines
under them (those say what a gem *asked for*; reading them would call
`pg` installed because something merely supports Postgres).

## Three traps, each verified rather than assumed

- **`register`'s own proving run cannot prove this shape.**
  `src/containment/run.ts` runs every container as the *host*
  `uid:gid`, and starting PostgreSQL or Redis on Debian needs root
  (which the official Ruby image itself runs as, so Inspector's box is
  fine). The `--check`/`--image` route therefore refuses on a permission
  error for a perfectly good check — named in the proposal's notes and
  in the `check-failed` refusal itself, rather than left to be puzzled
  over. The same README already documented the sibling case ("a check
  that installs a system package cannot pass the proving run").
- **A preamble can contain an `exit` that is never taken.**
  `helpers/fake-register-tools.ts`'s `scriptedExit` read `exit N` from
  *any* line of the written `check.sh`, so the service-waiting loop's
  own `exit 1` made every Rails registration read as red. It now reads
  the script's **last** line only. Anything else generating a `check.sh`
  preamble will hit this again.
- **A generated shell script is worth executing, not just asserting
  on.** `scaffold.test.ts` writes the generated `check.sh` into a temp
  dir, stubs every outside command (`service`, `pg_isready`,
  `redis-server`, `redis-cli`, `bin/rails`, `bundle`) onto `PATH` with a
  log, and runs it under `/bin/sh`. That is what actually proves the
  order, that the wait loop waits, that the `EXIT` trap stops both
  servers after a *failing* suite, and that the suite's exit status
  survives the trap. Substring assertions would have passed on a script
  with any of those wrong. Reuse the pattern for any other generated
  script.

## What the check box's "no network" does *not* mean

The box has no network at check time, but the image is **built** from
the repository's own `Dockerfile.inspector` at the task's own commit,
with a network. So a task that adds a gem is fine: `bundle install` runs
at build time and picks up the branch's own `Gemfile.lock`. There is no
"a new dependency can never be installed" problem to warn about here —
only the build-context one (bundler sees just the files the `COPY` line
names, so a `gemspec`/`eval_gemfile`/`path:` gem needs its own `COPY`,
and a committed `.bundle/config` with a path of its own would point
bundler at the checkout instead of at the baked gems).

## Documentation that had to be read, not remembered

No network is reachable from a worker box, but `WebSearch` is — which is
how the facts this change leans on were read rather than guessed: the
official Ruby image's `GEM_HOME=/usr/local/bundle` and root default
user, that it no longer sets `BUNDLE_PATH`, its `<major>.<minor>.<patch>`
tag format, `service postgresql start` being the SysV wrapper that works
in a container with no systemd, Debian's `peer` authentication wanting a
role named after the OS user, `libpq-dev` being the package that ships
`libpq-fe.h` for the `pg` gem, `redis-cli ping`/`shutdown nosave`, and
`bin/rails db:test:prepare` being Rails' own "rebuild the test database"
task. `WebFetch` failed outright on every URL; `WebSearch` worked.
