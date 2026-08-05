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

## Why macOS's Seatbelt, and not the container stack the Client chose

The Client's stated direction for this general problem is a per-task
container stack (own services, volumes, network). That's the right
answer for workloads that can run in a Linux container. It is not the
right answer for the one real `Brain` adapter this project has: running
`file` on that adapter's installed binary shows a Mach-O 64-bit arm64
executable - native macOS code, not Linux. There is no container runtime
on this machine (or any Mac) that executes it, because a Linux container
is still a Linux kernel underneath. This is exactly the case the
Client's own architecture note carved out an exception for: "native
macOS work, isolated host-side instead, per task." `runContained` is
that host-side mechanism, chosen and verified for that reason - not
because containers were rejected in general.

macOS's own sandboxing primitive, `sandbox-exec`, is what's used. Its
`man` page marks the *command* deprecated in favor of the App Sandbox
entitlement system - but App Sandbox requires a code-signed app bundle
built with Xcode, which cannot wrap an arbitrary third-party binary at
runtime. The underlying kernel mechanism it drives (Seatbelt) is not
going anywhere: `/System/Library/Sandbox/Profiles/` ships dozens of
`.sb` profiles that real macOS system daemons are still confined by
today. `sandbox-exec` is the only way to point that same mechanism at an
arbitrary command, so that's what this module uses - verified against
the real, installed `sandbox-exec` on the real machine, not assumed from
its man page.

## What the profile actually does, and why

Every process gets a freshly generated Seatbelt profile (see
`profile.ts`), written to its own throwaway temp file per call:

- **Writes** are denied everywhere except `workdir`.
- **Reads** are allowed everywhere *except* `homeDir` - with `workdir`
  re-opened as an explicit exception, because `workdir` usually lives
  inside `homeDir` (Fabrica's own `recordHome` defaults to `~/.fabrica`).
- **Network** is denied unless `network: "allowed"` is passed.

### What was tried and rejected: an allowlist of system directories

The obvious-looking design is "deny reads everywhere except a short list
of system directories the OS needs (`/usr`, `/bin`, `/System`,
`/Library`, ...) plus `workdir`." That was built first, and it broke:
even `/usr/bin/true` aborted with no error output under it. The cause,
found by checking `mount` and `/System/Volumes/Preboot/Cryptexes` on the
real machine: modern macOS's system volume is sealed and read-only, with
its actual libraries served through cryptex overlays mounted at paths
like `/System/Volumes/Preboot/Cryptexes/OS/...` - not simply under
`/System`. There is no small, stable, enumerable set of paths a process
needs just to start up. Trying to hand-pick one is fragile by
construction and was proven so on this exact machine.

The design that's actually in `profile.ts` inverts this: allow reads
everywhere, and carve out one specific exclusion (`homeDir`) rather than
trying to enumerate an allowlist. This sidesteps the sealed-volume
problem entirely (the OS's own paths are never touched by the
exclusion, whatever they happen to be on a given macOS version) while
still closing the concrete thing the issue asks for - a Worker reading
files "in the home directory" it has no business seeing.

### Per-task isolation

Every call generates its own profile file, referencing only that
particular `workdir`. Nothing is shared or reused across calls or across
concurrently-running tasks, so two Workers running at once cannot
collide with each other through this mechanism - each one's profile
only ever grants access to its own task's workdir.

## `runContained(command, args, opts)`

```ts
const result = await runContained("/bin/echo", ["hi"], {
  workdir: line.workdir,       // the ProductionLine's throwaway worktree
  homeDir: os.homedir(),       // excluded from the broad read allowance
  network: "denied",           // or "allowed" - no default; state it
});
// result: { stdout: "hi\n", stderr: "", exitCode: 0 }
```

- **`workdir`** - reads and writes are confined here. Resolved with
  `realpathSync` internally, so a path through a symlink (macOS's
  `/tmp` -> `/private/tmp`, same sharp edge `src/line/README.md`
  documents) still matches what the sandbox actually sees.
- **`homeDir`** - the directory excluded from the broad read allowance.
  Not read from `os.homedir()` internally - the caller passes it in, the
  same discipline this project already applies to `recordHome`, so a
  test can point it at a throwaway fixture and prove the exclusion
  without touching the real machine's real home directory.
- **`network`** - `"denied"` or `"allowed"`, required with no default.
  There's no silent choice here on purpose: the issue's own requirement
  is "not the network unless deliberately allowed," and a required field
  is what makes every call site actually state that choice.
- **`env`** - the exact environment variables the contained process
  receives: "the worker has what it needs," not the Foreman's whole
  environment. Whatever is passed here is merged over a PATH-only base
  (`PATH` alone is needed to resolve the command at all); nothing else
  from this process's environment - API keys, tokens, anything a secret
  might live in - reaches the child by inheritance. Omit it and the
  child gets just `PATH`.

Returns `{ stdout, stderr, exitCode }` - identical in shape to a plain
`child_process.spawn` wrapped in a promise, so an adapter that already
does that (see the reference CLI adapter) can switch to this without
reshaping how it reads the result.

## Errors: `ContainmentError`

- **`unsupported-platform`** - thrown immediately if
  `process.platform !== "darwin"`. This module only implements macOS's
  Seatbelt; it does not silently no-op or fall back to running
  uncontained on another OS.
- **`spawn-failed`** - `sandbox-exec` itself couldn't be launched (not
  installed, or some other OS-level failure starting it). Distinct from
  the *contained command* failing, which just comes back as a normal
  result with a non-zero `exitCode` - `runContained` doesn't try to
  guess why a command failed once it actually ran.

## An accepted gap: mach-lookup is not restricted

The profile leaves `(allow mach-lookup)` unrestricted: a contained
process can still talk to any Mach/XPC service on the host. That is a
deliberate, accepted, non-urgent gap - documented here so nobody
mistakes the verified guarantees for more than they are.

Why it's acceptable: the Client's two real requirements are that his
filesystem stays intact and that no change reaches his project without
his approval - and both are already met independent of mach-lookup.
Rule 1 is proven by a byte-for-byte fingerprint test, and v1 never
pushes, so work only ever lands on a branch he reviews and merges by
hand.

Why it isn't narrowed: restricting mach-lookup to a named allowlist of
services would mean guessing which Mach/XPC services the real binary
needs and breaking it repeatedly to find out - exactly what already
happened once in this module's own discovery process, when a
hand-picked system-read-path allowlist starved `dyld` under macOS's
sealed, cryptex-based system volume (see "What was tried and rejected"
above).

Stated plainly: this is a smaller room than before, not a walk-away
guarantee. A contained process can still reach system services that
could in principle proxy around the `network: "denied"` boundary (a
background transfer daemon, the pasteboard), even though direct sockets
are verified blocked. Also stated plainly: the Client's own crewmates
run today with no sandbox at all, so this - even with the mach-lookup
gap - is already meaningfully stricter than the status quo.

## What this does NOT solve yet: the reference CLI adapter isn't wired to use it by default

This module is not currently the default execution path for that
adapter's factory function, and that's a deliberate, documented gap -
not an oversight. Verified live on this machine: the real binary
authenticates through macOS Keychain (its own auth-status subcommand
reads a Keychain item, not a file or env var), and Keychain access for a
sandboxed process is gated by sandbox-container entitlements Apple
grants its own signed apps - not something an ad-hoc `sandbox-exec`
profile can restore. Running the real binary under this sandbox, even
with every read/mach-lookup rule wide open, reports back "not logged
in"; the underlying keychain query itself fails with
`SecKeychainSearchCreateFromAttributes: A Module Directory Service
error` (checked without ever reading the credential's actual value).

So enabling this for that adapter today would break the one real,
currently-working adapter's ability to authenticate at all. That's a
live-credential decision (moving to a non-Keychain, long-lived token the
CLI itself can generate for headless use) reserved for whoever
configures Fabrica, not something this module decides on its own. See
that adapter's own doc file, "Process containment" section, for the
exact, up-to-date status of that decision.
