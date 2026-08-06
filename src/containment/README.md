# containment

`runContained` runs one command as a real OS-level sandboxed process: its
reads and writes are confined to a single directory, and it cannot reach
the network unless told to. It exists to close a specific gap (issue
#44): CONTRACT rule 1 proves the Client's own checkout is never touched,
but that says nothing about the Worker's *process* - today, a Worker
(via `src/brain/adapters/`'s reference CLI adapter) runs with the full
access of the OS account it's launched as, and could in principle read
or write anywhere that account can reach, or talk to anywhere on the
network. `runContained` is a real, working answer to that - not a
description of one.

## Why Docker

Docker is the only mechanism this module implements - there is no
platform-specific fallback, and there never was meant to be one. Three
reasons, in order of how much they matter going forward:

- **Portability.** Fabrica isn't committed to staying macOS-only, and a
  containment scheme wired to one OS's own kernel sandboxing primitive
  makes moving to Linux or Windows harder, not easier. Docker Desktop
  and Docker Engine both run on all three.
- **One mechanism for both isolation problems.** The Client had already
  chosen a per-task container stack (its own services, volumes,
  network) as the direction for keeping parallel tasks from colliding
  at runtime. Worker containment is the same shape of problem - this
  module is that same direction, applied here.
- **Not building on something already retired.** An earlier version of
  this module used macOS's `sandbox-exec`. Its own `man` page opens with
  the word `DEPRECATED`. Docker is an actively maintained mechanism;
  `sandbox-exec` is not.

### What was tried and replaced: macOS's `sandbox-exec`

Worth recording plainly, since it was real, verified work, not a
discarded guess: `sandbox-exec` (Seatbelt) genuinely did confine a
process's reads, writes, and network - proven live against the real
binary before it was replaced. What it could not do, also verified
live: run the reference CLI adapter's actual authentication path.
That binary reads its credential from macOS Keychain, and Keychain
access for a sandboxed process is gated by sandbox-container
entitlements Apple grants its own signed apps - an ad-hoc `sandbox-exec`
profile cannot restore that, no matter how permissive the rest of the
profile is (verified: even with every file-read and mach-lookup rule
wide open, the Keychain query itself failed with `SecKeychainSearch
CreateFromAttributes: A Module Directory Service error`, checked
without ever reading the credential's actual value). Docker replaces it
entirely - see "What's still not solved" below for how the *equivalent*
gap shows up under Docker, and why it's a smaller, more ordinary one.

## What the container actually does, and why

Every call runs a fresh, throwaway container (`docker run --rm`):

- **Writes** are confined to `workdir` because it is the *only* writable
  thing bind-mounted into the container
  (`--mount type=bind,source=<workdir>,target=/workdir -w /workdir` -
  the long form on purpose: unlike `-v`, its key=value fields don't
  split on a `:` appearing in the workdir path, and `recordHome` is
  caller-configurable). There is no allow/deny rule to get right here,
  unlike a host-process sandbox - the container's filesystem view simply
  doesn't contain anything else writable from the host at all.
- **Reads** are confined the same way (plus `readOnlyMounts`, below),
  and this is a strictly stronger guarantee than the `sandbox-exec`
  version's was: that version had to carve out one exclusion (the home
  directory) from an otherwise-broad read allowance, because a
  host-process sandbox still has to let the OS's own files through. A
  container has no such tension - nothing outside `workdir` (and
  whatever's explicitly listed in `readOnlyMounts`) is visible, full
  stop.
- **Network** is denied by passing `--network none` (verified: DNS
  resolution itself fails under it, and so does a plain TCP connect to
  a real listener) and allowed by omitting it (the container gets
  Docker's normal default bridge network).
- **Environment** needs no filtering the way a host-process sandbox
  does: Docker never auto-inherits the host's environment into a
  container (verified) - only what's passed via `-e` reaches the
  contained process, so "the worker has what it needs, not the
  Foreman's whole environment" holds by construction, not by a base
  case this module has to build itself.
- **Ownership**: the container runs as the invoking host process's own
  UID/GID (`--user`, from `process.getuid()`/`process.getgid()`), not as
  root (verified: files created in the bind-mounted workdir come out
  owned by the invoking host user, and the reference adapter's installed
  CLI still runs under it). This matters most on native Linux - the
  portability direction that motivated choosing Docker in the first
  place - where a root container's writes into the bind mount would come
  out root-owned on the host, breaking host-side git operations and
  `destroyProductionLine`'s teardown. Docker Desktop for macOS already
  maps ownership transparently, so nothing changes there. On platforms
  where those process getters don't exist (non-POSIX), the flag is
  simply omitted rather than passing an invalid value. One consequence,
  also verified live: a UID with no matching `/etc/passwd` entry (the
  normal case here) makes `$HOME` resolve to `/` unless `homeDir` names
  something better - see below.
- **Resource caps** are always applied - `--memory`, `--cpus`, and
  `--pids-limit`, each with a conservative default, overridable per
  call. Verified live, not just documented: `--memory=256m` sets the
  real cgroup limit (`cat /sys/fs/cgroup/memory.max` inside the
  container reads back exactly `268435456`), and `--pids-limit=5`
  genuinely blocks forking past it (`sh: can't fork: Resource
  temporarily unavailable`), not merely a ceiling nobody enforces. A
  runaway or compromised Worker hits a wall - out-of-memory kill,
  refused fork - instead of the host machine.
- **The Docker socket is never mounted.** Nothing in this module (or
  the reference adapter) passes `/var/run/docker.sock` or any
  equivalent into a container. A contained process has no way to talk
  to the Docker daemon itself, start sibling containers, or otherwise
  escape the one container it's actually running in.

### Per-task isolation

Every call is its own throwaway container, torn down (`--rm`) the
moment the command exits. Nothing is shared or reused across calls or
across concurrently-running tasks, so two Workers running at once
cannot collide with each other through this mechanism.

## `runContained(command, args, opts)`

```ts
const result = await runContained("echo", ["hi"], {
  workdir: line.workdir,  // bind-mounted at /workdir - the only writable host path
  network: "denied",      // or "allowed" - no default; state it
  image: "alpine",        // required - which image the command runs inside
});
// result: { stdout: "hi\n", stderr: "", exitCode: 0 }
```

- **`workdir`** - the only writable host path bind-mounted into the
  container, at `/workdir` (also the container's working directory).
  Resolved with `realpathSync` internally, so a path through a symlink
  (macOS's `/tmp` -> `/private/tmp`, same sharp edge `src/line/README.md`
  documents) still matches what actually gets mounted.
- **`network`** - `"denied"` or `"allowed"`, required with no default.
  There's no silent choice here on purpose: the issue's own requirement
  is "not the network unless deliberately allowed," and a required
  field is what makes every call site actually state that choice.
- **`env`** - the exact environment variables the contained process
  receives. Written to a throwaway `--env-file` per call rather than
  passed as `-e` flags at all, for two reasons verified live: neither
  the keys nor the values ever appear in host `ps` listings of the
  docker command (a plain `-e KEY=value` puts the value there; even a
  name-only `-e KEY` still puts the key there and requires merging
  `opts.env` into the spawned `docker` client's own process environment,
  where a key that collides with something the docker CLI itself reads
  - `DOCKER_HOST`, `DOCKER_CONFIG`, `PATH` - would change the client's
  own behavior, not just the container's). Omit it and the container
  gets only what its own image defines - Docker's own default behavior
  already matches "the worker has what it needs," not the caller's
  whole environment.
- **`image`** - the Docker image the command runs inside, required with
  no default for the same reason `network` has none: a generic command
  (`sh`, `cat`) can run in any small stock image, but a caller whose
  command is a specific tool needs an image that actually has that tool
  installed, and this module won't guess which one that is.
- **`readOnlyMounts`** - extra host paths made visible read-only, each
  at its own resolved absolute path (not remapped under `/workdir`).
  A `{ source, target }` entry mounts `source`'s content at `target`
  instead - the shadow-mount form, for the one case where what's
  visible at a path must differ from what the host has there. See "Git
  under containment" below for the two cases this exists for. Omit when
  the command needs nothing outside `workdir`.
- **`memory`**, **`cpus`**, **`pidsLimit`** - override the resource cap
  defaults (`DEFAULT_MEMORY` = `"2g"`, `DEFAULT_CPUS` = `"2"`,
  `DEFAULT_PIDS_LIMIT` = `512`). These are always applied - there's no
  way to run a call with no cap at all.
- **`homeDir`** - a host path mounted read-write as the container's
  `HOME` (verified live: without this, a `--user`-run container's `HOME`
  resolves to `/`, which is neither writable nor a sensible home
  directory). See "Session persistence" below for why the reference
  adapter always sets this.

Returns `{ stdout, stderr, exitCode }` - identical in shape to a plain
`child_process.spawn` wrapped in a promise, so an adapter that already
does that (see the reference CLI adapter) can switch to this without
reshaping how it reads the result.

## Git under containment

A ProductionLine `workdir` is a `git worktree` (`src/line/README.md`),
so its `.git` is a one-line pointer file naming the real project's
shared `.git` by absolute host path - a path outside `workdir` entirely.
Mounting only `workdir` therefore leaves git unable to find its own
repository at all inside the container (verified: `fatal: not a git
repository`), which would make `git status`, `git log`, and `git diff`
- all things a real coding-agent Worker needs constantly - fail
outright.

Two designs were tried; the second is what shipped:

- **A self-contained copy** (build a standalone `.git` per call by
  copying the shared object database and overlaying the worktree's own
  `HEAD`/`index`) was verified to work for reads, but rejected: copying
  a real repository's object database on every call is slow and
  disk-heavy, fights "container spin-up stays in the low seconds," and
  a commit made inside that copy would need syncing back out - a
  correctness-sensitive step this design doesn't need at all.
- **Mounting the real common `.git`, read-only, at its own physical
  path** (`src/line/worktree-git.ts`'s `resolveCommonGitDir(workdir)`
  reads the worktree's pointer file to find it) - what shipped. Verified
  live: `git status` and `git log` work normally, reading the project's
  real history; `git commit` fails with `fatal: ... Read-only file
  system`.

One file in that mount gets special treatment: the shared `.git`'s own
`config`, the one file in a git directory that can carry a credential.
Mounting it as-is would hand that credential to a Worker that also has
network allowed - enough to push to the Client's remote directly,
sidestepping the read-only-commit enforcement below. So the real
`config` is never visible inside the container:
`src/line/worktree-git.ts`'s `writeSanitizedGitConfig` writes a
throwaway copy that copies forward **only the `[core]` section and
individually allowlisted `[extensions]` keys** of the real config and
drops every other section by default, and the caller
shadow-mounts that copy over the real config's path (a `{ source,
target }` entry in `readOnlyMounts` - Docker layers a file mount over
an already-mounted directory's sub-path correctly, verified live). A
`[core]`-only config is enough: excluding `config` entirely breaks
git's repository detection outright (`fatal: not a git repository:
(null)`, verified live), while `git status`/`log`/`diff` all work with
only `[core]` present and `git config --get remote.origin.url` returns
nothing inside the container.

The allowlist shape is deliberate, and the stronger, fail-safe framing
versus the denylist it replaced (strip `[remote "..."]` sections,
forward everything else). A denylist fails open the moment an
unanticipated form shows up, and review found two immediately: git's
deprecated dotted section syntax (`[remote.origin]`, honored by git but
not matched by a quoted-form-only strip), and config-based credential
mechanisms living outside remote sections entirely
(`http.<url>.extraheader` - exactly what CI systems write into a repo
config - `url.<base>.insteadOf` rewrites with an embedded credential,
`[credential]` helper settings, `[include]`/`[includeIf]` directives
pulling any of those in). Under the allowlist, anything not explicitly
forwarded - those forms, and any future config-based credential
mechanism nobody has thought of yet - is invisible by construction, not
because it was individually identified and blocked.

`[extensions]` gets one deliberate refinement rather than a blanket
drop: its keys are structural (hash algorithm, ref storage backend,
relative worktree paths), so a repo that declares them is misread
outright by a git that can't see them - `status`/`log`/`diff` would
fail or misbehave, breaking git-under-containment for exactly those
repos. Each key documented by the installed git that is credential-free
by construction (`compatObjectFormat`, `noop`, `noop-v1`,
`objectFormat`, `partialClone`, `preciousObjects`, `refStorage`,
`relativeWorktrees`, `submodulePathConfig`) is forwarded individually.
Any other `[extensions]` key fails the run with a clear error naming it
- never silently dropped (which would misread the repo), never passed
through (a future key's value may not be credential-free:
`refStorage` already accepts a URI payload, and git's manual
anticipates backends like `postgres://` whose URI could carry a
password). A URI-form `refStorage` value (`<format>://<payload>`) fails
for the same reason - its payload names a host location the container
can't see - while a bare format name (`files`, `reftable`) forwards
normally. Anything else the sanitizer can't read as a plain key of that
section fails the same way rather than being guessed at: a subsectioned
header (`[extensions "..."]` or `[extensions.foo]`, which no documented
extension key uses) and a line it can't parse as `key = value` both
refuse the run. `worktreeConfig` is deliberately off the allowlist:
forwarding it would make git honor an unsanitized `config.worktree`
file inside the mount, reopening the exact config-borne credential
channel this sanitizer closes.

One known limitation this leaves: `extensions.partialClone` names a
promisor remote, and `remote.*` is deliberately never forwarded - so in
a partially-cloned repo, a contained git command that needs an object
the partial clone omitted cannot fetch it, because the promisor remote
isn't visible inside the container at all (a feature: no remote URL is,
credential-bearing or not). Reads of already-present objects work
normally; the
gap only shows on objects the partial clone deliberately left out.

Stated plainly, what a Worker can and cannot read from `.git` under
this design: it **can** read commit history, reflogs, and dangling or
unreferenced objects - all inherently readable once the object
database is mounted at all, and no more than added context on a
project whose every file it already has checked out in `workdir`. It
**cannot** read anything from the project's git configuration beyond
`[core]` and the allowlisted structural `[extensions]` keys above - not
a remote URL or a credential embedded in one, not a
credential helper, not a header or URL-rewrite setting.

That last result is a feature, not a limitation. It enforces the
Client's architecture in the filesystem itself: merges and commits are
orchestrated outside the Worker, never by the Worker, and a contained
process cannot commit even if it tries - which also structurally closes
a rule-9-shaped loophole where a Worker could otherwise commit its own
tampered work to keep it reachable after the container exits. It's not
new exposure either: the Worker already has every file of that project
checked out and in front of it inside `workdir`; read-only history adds
context (why a line looks the way it does), not reach it didn't already
have some form of.

macOS's `/var` -> `/private/var` symlink is the exact trap here too (as
it is for `workdir`): a worktree's `.git` pointer file records the
*physical* path, so mounting an unresolved one leaves git looking
somewhere nothing is actually mounted, with the misleading error `fatal:
not a git repository: (null)`. `runContained` resolves every
`readOnlyMounts` entry with `realpathSync` for exactly this reason.

## Session persistence

Every `runContained` call is its own fresh, throwaway container - which
means, without `homeDir`, a warm `--resume` can never work: the CLI's
session state lives under `$HOME`, and a second call for the same task
would find a brand-new, empty one. SPEC.md is explicit that a retry is
"a correction into the same session, never a cold restart," so losing
this was not an acceptable cost of containment.

`homeDir` closes it: a host path mounted read-write at a fixed internal
path, with `HOME` set to match, so whatever a tool writes under `$HOME`
- the reference adapter's own session directory among it - survives
across every call that's given the *same* `homeDir`, while staying
completely isolated from other tasks' own `homeDir`s and from the real
host's actual home directory. Verified live: writing a file to `$HOME`
in one call and reading it back in a second, entirely separate `--rm`
container, with nothing else shared between them, succeeds.

The reference adapter derives its `homeDir` from `workdir` alone
(`` `${workdir}.fabrica-session` ``, created on demand) - see that
adapter's own doc file for why, and for the one honest gap this leaves:
nothing yet deletes that directory when a task's `ProductionLine` is
torn down, since `destroyProductionLine` doesn't know this sibling
exists. A real, non-urgent, documented cleanup gap - not a silent one.

## Errors: `ContainmentError`

- **`invalid-path`** - `workdir`, a `readOnlyMounts` entry, or `homeDir`
  doesn't resolve to a real, existing path - or resolves to one
  containing a comma, which docker's `--mount` flag cannot represent
  (refused here with a clear message rather than surfacing docker's own
  confusing parse error). Also raised for an `env` key containing `=`
  or a newline, or an `env` value containing a newline - the same class
  of unrepresentable input, since the `--env-file` format has no
  escaping and a newlined value would be silently truncated with its
  remaining lines injected as extra variables.
- **`spawn-failed`** - `docker` itself couldn't be launched (not
  installed, daemon down in a way that prevents even starting the CLI).
  Distinct from the *contained command* failing to run, or the daemon
  refusing the request once `docker` did start - both of those come back
  as a normal result with a non-zero `exitCode` and Docker's own error
  text in `stderr`, exactly like any other command failure.

## What's still not solved: the reference CLI adapter's own credential

Docker changes *what kind* of gap remains for the reference adapter, not
whether one does. Verified on the real machine: the host's installed
CLI is a native macOS binary and can never run inside any Linux
container - but installing that same tool's own Linux build via its
public npm package, inside a container, works (confirmed: it starts,
parses arguments, and reports a version). The only thing that doesn't
work is authentication - a fresh container has no credential configured
at all, the same as any brand-new install of any authenticated CLI would
need one before it does real work. That's a far more ordinary,
better-understood gap than `sandbox-exec`'s Keychain failure was, and
closing it (e.g. the CLI's own long-lived-token mechanism for headless
use) is a live-credential decision for whoever configures Fabrica, not
something this module decides on its own. See the reference CLI
adapter's own doc file, "Process containment," for the exact,
up-to-date status.
