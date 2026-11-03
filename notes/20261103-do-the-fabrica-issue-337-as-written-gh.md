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
  named build context `repo` (inspector#81), as `COPY --from=repo`.
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
  opened the socket and then wants a role of **that user's name** - and
  a uid with no passwd entry has no name, on either side of the socket.
  `PGUSER` is exported for the same reason: libpq's default user name
  also comes from `getpwuid`.

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
  else - a missing `inspector`, a build failure, a red check. Until
  inspector#81's named build context is in the pinned commit, the terms
  route genuinely fails there, by Client ruling.
- **The verdict is read from Inspector's own report**, not from its exit
  code. `inspector` cannot run a check without publishing: `-branch` is
  required and a missing `GITHUB_TOKEN` is a refusal with exit 2. But
  `Run` writes `.inspector/latest.json` before any of that, so
  `outcome: "green"` is the fact to read, and publication never happens.
- **`Gemfile.lock` is generated by a real `bundle lock`** in the fixture
  before the repository is committed, not hand-written. A hand-written
  lockfile bundler decided to re-resolve would mean the image installed
  something other than what the test says it pins.
