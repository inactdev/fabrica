# Terms that pass a real Inspector run (issue #337)

What `fabrica register --terms` wrote could not pass Inspector, for four
reasons. All four are now fixed in `src/register/`, and the facts each
fix rests on were read out of Inspector's own documentation rather than
assumed. The per-field reasoning lives in `src/register/README.md`; what
follows is what a future task would otherwise have to rediscover.

## The four facts about Inspector's check box this depends on

Read from Inspector's README and `internal/container/user.go` on
2026-11-03, main at `6b8ce49e`:

- A terms folder is mounted **read-only at `/terms`**, a fixed path with
  no configuration key. The repository is at `/workspace`, and
  `/workspace` is the check command's working directory. So a terms
  check is named `sh /terms/check.sh` and must never `cd` to its own
  folder.
- The `docker build` context **follows the Dockerfile into the terms
  folder**. A `COPY Gemfile ...` there copies from the terms folder,
  which holds no Gemfile. The repository is reachable only through the
  named build context `repo` (inspector#83, merged), as
  `COPY --from=repo`.
- The check runs as `docker run --user <host uid>:<host gid>` - the uid
  of whoever invoked Inspector, which has **no `/etc/passwd` entry** in
  the image. Root happens only under a rootless Docker daemon, where
  `ResolveUser` returns `0:0` because the daemon's own user namespace
  has already remapped it.
- **Every top-level path git tracks is mounted read-only**, and a
  read-only mount covers its whole subtree - so a new file in a tracked
  directory fails exactly as a modified one does. For a Rails
  application that means `log/` and `tmp/` (both tracked, via
  `log/.keep` and `tmp/.keep`) cannot be written at all.

## Giving the check's own uid a passwd entry (the decision, written first)

The first real end-to-end run proved the fix above incomplete. `initdb`
does not merely *prefer* a user name, it resolves one unconditionally:
`get_id` -> `get_user_name_or_exit` -> `pg_get_user_name` ->
`getpwuid_r`, with no flag anywhere that skips it. `--username` names
the *role* it creates, not the OS user it looks itself up as. So a uid
with no `/etc/passwd` entry cannot run `initdb` at all, and the run
failed with exactly that: `initdb: could not look up effective user ID
1001: user does not exist`.

The chosen fix is to give that uid an entry, at check time, in the
check's own box:

- `Dockerfile.inspector` leaves `/etc/passwd` and `/etc/group` writable
  (`RUN chmod a+w`, under the `USER root` the package install already
  needs). It cannot write the entry itself, because the uid the check
  will run as is unknowable at build time.
- `check.sh` appends an entry for `$(id -u)` when `getent passwd` finds
  none, and refuses loudly - naming the `chmod` line - when those files
  are not writable.

Why this one, safest first: it needs no new dependency, no new binary
and no library interposition, and every fact it rests on is a POSIX or
OS fact that can be read here (the `/etc/passwd` field format, `getent`,
append redirection). It is also general rather than PostgreSQL-shaped -
*anything* in that box that looks the user up now finds one, which is
what issue #337 asks for. Its cost is named rather than hidden: a
world-writable `/etc/passwd` next to a setuid `su` is a container-root
escalation path, bounded here by `--network none`, no credential of any
kind in the box, a read-only `/workspace`, and every write discarded
with the container.

**The alternative rejected: nss_wrapper** (`LD_PRELOAD` plus
`NSS_WRAPPER_PASSWD`/`NSS_WRAPPER_GROUP`). It is purpose-built for
exactly this, and it would leave the image's own permissions untouched,
which is strictly safer. It was rejected on a hard rule, not on
preference: its documentation is not reachable from here, and a call to
an outside tool whose current shape cannot be read is a guess. A second
alternative - running `initdb` at build time into `/deps` and copying
the cluster at check time - was rejected twice over: it rests on an
unverified claim that the `postgres` server itself needs no passwd
lookup, and it puts initialization back into the image, which is the
exact thing issue #337's first finding removed.

## What the uid with no passwd entry rules out

Everything the old shape did at build time. `service postgresql start`,
`createuser -s root` and a cluster in the image are all unusable at
check time, because PostgreSQL refuses a data directory it does not own
and the check-time uid is unknown at build time. There is no way to
hand it over afterwards either: `chown` needs root, and the data
directory must be mode 0700.

So the cluster is created **at check time**, by whoever is running:
`initdb --auth=trust` into the run's own scratch directory. Three
details are load-bearing:

- Debian keeps `initdb`/`postgres`/`pg_ctl` **out of `/usr/bin`** - only
  client tools get `pg_wrapper` symlinks there. They live in
  `/usr/lib/postgresql/<major>/bin`, which the script discovers rather
  than pins, and fails loudly when it finds nothing.
- `pg_isready` is called from that same directory, not from `/usr/bin`.
  The `/usr/bin` one is `pg_wrapper`, which wants a Debian cluster
  config to read a port out of, and this cluster is not one.
- `trust` over the socket, not `peer`. `peer` asks the kernel which uid
  opened the socket and then wants a role of **that user's name** -
  which is the OS name the section above gives it, and no cluster has a
  role of that. `PGUSER` is exported for the same reason: libpq's
  default user name also comes from `getpwuid`.

The root branch is still needed (rootless Docker) and is one shell
function, `pg_as`: `initdb` and `postgres` both refuse to run as root,
so under root it `chown`s the scratch directory to the `postgres` system
user and `su`s to it. Redis needs neither branch - it drops nothing and
writes nowhere outside the scratch directory.

## Rails writing into a read-only log/ and tmp/

Two different mechanisms, and only one of them needed solving:

- **Bootsnap stops a boot dead** when `tmp/cache` is unwritable. It
  takes `BOOTSNAP_CACHE_DIR`, which `check.sh` points into the scratch
  directory.
- **Rails' own logger does not.** `initialize_logger` wraps the open in
  a `rescue StandardError` and falls back to `STDERR` with a warning
  about an inaccessible log file. Nothing has to be done about `log/`,
  and nothing is - a `log/test.log` that cannot be opened is a warning
  on stderr, not a red check.

`TMPDIR` is pointed there too, for anything that reaches for the
system temporary directory.

## Why `register`'s own proving run still cannot prove this shape

It could not before because starting the servers needed root; it still
cannot, for a different reason, and the message had to change with it.
The proving run runs the check inside the image `--image` names - the
`FROM` line - and never builds `Dockerfile.inspector`, which is the file
that installs the servers. So the check fails there with "no PostgreSQL
server binaries", which is honest and loud. The `--terms` route has no
proving run at all.

## The end-to-end tests

`src/register/inspector-e2e.test.ts` runs the real `inspector` against a
real Rails application fixture, both routes. Three things about it worth
knowing before touching it:

- **It skips only when Docker is absent**, and fails loudly for anything
  else - a missing `inspector`, a build failure, a red check. The pin in
  `.github/workflows/docker-tests.yml` carries the named build context
  (inspector#83), so both routes are expected green; a red one is a
  regression, not a version skew to wait out. That pin is written once,
  in the install command, and moves only when the Client names a commit.
- **The verdict is read from Inspector's own report**, not from its exit
  code. `inspector` cannot run a check without publishing: `-branch` is
  required and a missing `GITHUB_TOKEN` is a refusal with exit 2. But
  `Run` writes `.inspector/latest.json` before any of that, so
  `outcome: "green"` is the fact to read, and publication never happens.
- **`Gemfile.lock` is generated by a real `bundle lock`** in the fixture
  before the repository is committed, not hand-written. A hand-written
  lockfile bundler decided to re-resolve would mean the image installed
  something other than what the test says it pins.

## A scratch directory makes a failing check unexplainable

The scratch directory above is the only writable place a generated check
has, so every server's log is in it - and the `EXIT` trap that removes it
runs on the failing path too. A red check whose PostgreSQL never
initialized therefore reported "PostgreSQL did not answer within 60
seconds" and nothing whatsoever about why: `initdb.log` and `server.log`
were deleted by the same cleanup, a second after they were written.

So `fabrica_cleanup` reads `$?` as its first act and, on any non-zero
exit only, prints every `$FABRICA_STATE/*/*.log` to stderr before the
`rm -rf`. Inspector's own report is the Client's whole view of a failed
check, so a diagnosis that is not in the check's own output is not
anywhere. Three details that are not arbitrary:

- **`fabrica_status=$?` has to be the trap's first line.** The stop lines
  below it overwrite `$?`.
- **Nothing in the dump may fail under `set -e`.** A glob matching
  nothing stays literal, so the `[ -f ] || continue` is load-bearing, and
  the `cat` carries its own `|| true`.
- **Green checks print none of it.** A passing check's output is read by
  people; a server's startup chatter there is noise.

The general rule, for any other throwaway directory a generated script
is given: whatever diagnoses a failure has to leave the directory before
the directory does.

## A generated script's test may never touch the machine's own files

The check now appends to `/etc/passwd`. That is right inside Inspector's
throwaway container and catastrophic anywhere else - and
`scaffold.test.ts` runs the generated script for real, under `/bin/sh`,
sometimes as root in a container. So its harness rewrites both file paths
to a throwaway pair per run, with **no option to use the real ones**, and
stubs `getent` to answer from that pair and nothing else.

The same rule caught a test that was already wrong in a quieter way: "a
box with no PostgreSQL in it" aimed the generated guard at the real
`/usr/lib/postgresql`, so it proved something different depending on what
the machine had installed - green here, exit 127 on a CI host that has
PostgreSQL but no Redis, because the guard was satisfied and the script
went on to the next server. It globs an empty directory of the test's own
now. The generalization: a test that runs generated code has to supply
every absolute path that code names, or it is a test about the machine.

## What the end-to-end test can and cannot prove about the uid

`register`'s own tests stub `id -u`, so both branches of `pg_as` really
run locally. The end-to-end test cannot choose: Inspector resolves the
check's user from the daemon it finds, so a rootless one gives root and
exercises the other branch. The probe test therefore *reports* the box's
uid and whether it has a passwd entry, out of the check's own output, and
only asserts the no-passwd-entry premise when the uid is not 0. A test
that silently proved the root branch while claiming to prove the other
would be worse than no test.
