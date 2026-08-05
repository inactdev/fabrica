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

- **Writes** are confined to `workdir` because it is the *only* thing
  bind-mounted into the container
  (`--mount type=bind,source=<workdir>,target=/workdir -w /workdir` -
  the long form on purpose: unlike `-v`, its key=value fields don't
  split on a `:` appearing in the workdir path, and `recordHome` is
  caller-configurable). There is no allow/deny rule to get right here,
  unlike a host-process sandbox - the container's filesystem view simply
  doesn't contain anything else from the host at all.
- **Reads** are confined the same way, and this is a strictly stronger
  guarantee than the `sandbox-exec` version's was: that version had to
  carve out one exclusion (the home directory) from an otherwise-broad
  read allowance, because a host-process sandbox still has to let the
  OS's own files through. A container has no such tension - nothing
  outside `workdir` is visible, full stop, not just "the home
  directory."
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
  simply omitted rather than passing an invalid value.

### Per-task isolation

Every call is its own throwaway container, torn down (`--rm`) the
moment the command exits. Nothing is shared or reused across calls or
across concurrently-running tasks, so two Workers running at once
cannot collide with each other through this mechanism.

## `runContained(command, args, opts)`

```ts
const result = await runContained("echo", ["hi"], {
  workdir: line.workdir,  // bind-mounted at /workdir - the only host path visible
  network: "denied",      // or "allowed" - no default; state it
  image: "alpine",        // required - which image the command runs inside
});
// result: { stdout: "hi\n", stderr: "", exitCode: 0 }
```

- **`workdir`** - the only host path bind-mounted into the container, at
  `/workdir` (also the container's working directory). Resolved with
  `realpathSync` internally, so a path through a symlink (macOS's
  `/tmp` -> `/private/tmp`, same sharp edge `src/line/README.md`
  documents) still matches what actually gets mounted.
- **`network`** - `"denied"` or `"allowed"`, required with no default.
  There's no silent choice here on purpose: the issue's own requirement
  is "not the network unless deliberately allowed," and a required
  field is what makes every call site actually state that choice.
- **`env`** - the exact environment variables the contained process
  receives, as `-e KEY=VALUE` flags. Omit it and the container gets only
  what its own image defines - Docker's own default behavior already
  matches "the worker has what it needs," not the caller's whole
  environment.
- **`image`** - the Docker image the command runs inside, required with
  no default for the same reason `network` has none: a generic command
  (`sh`, `cat`) can run in any small stock image, but a caller whose
  command is a specific tool needs an image that actually has that tool
  installed, and this module won't guess which one that is.

Returns `{ stdout, stderr, exitCode }` - identical in shape to a plain
`child_process.spawn` wrapped in a promise, so an adapter that already
does that (see the reference CLI adapter) can switch to this without
reshaping how it reads the result.

## Errors: `ContainmentError`

- **`invalid-path`** - `workdir` doesn't resolve to a real, existing
  path.
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
