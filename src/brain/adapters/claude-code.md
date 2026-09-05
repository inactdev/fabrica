# claude-code.ts

`claude-code.ts` is the `Brain` adapter that drives the Client's own
daily coding agent - the `claude` command-line tool - in its
non-interactive mode. It is a CLI adapter (see `README.md` in this
folder for what that family means): the `claude` binary already reads
files, edits them, and runs commands inside `workdir` on its own: this
file's whole job is building the right command line, handing it
`brief`, and turning what it prints back into the shapes `Brain`
promises. Every flag and behavior documented here was run against the
real installed binary (version 2.1.222, 2026-08-04) - see
`claude-code.test.ts`'s last test for the live proof, which creates a
real file in a real throwaway worktree and checks it exists.

## `claudeCodeAdapter(opts?)`

Call this once to get a `Brain`. Every call always runs through
`../../containment/`'s `runContained` (Docker) - there is no toggle for
this and no uncontained path; see "Process containment" below for what
that guarantees and the one thing it doesn't yet. Four optional fields:

- **`model`** - the value passed straight to `claude --model`, e.g.
  `"claude-opus-5"` or the alias `"sonnet"`. Leave it out and the call
  omits `--model` entirely, so whatever model the `claude` binary is
  already configured to use by default runs. In that case `Brain.model`
  reports the string `"default"` rather than guessing which model that
  resolves to - the adapter would have to make an extra real call just
  to find out, and `"default"` is the honest answer to "which model is
  this adapter using" when no override was given.
- **`binPath`** - the command to run inside the container instead of
  `"claude"`. Exists so `claude-code.test.ts`'s fast tests can point
  this at a copy of `helpers/fake-claude-cli.mjs` placed inside
  `workdir` (the only path the container can see), instead of paying
  for a real call on every test run. Leave it out in real use; it
  resolves `"claude"` via the image's own `PATH`.
- **`image`** - the Docker image `binPath` runs inside. Defaults to
  `DEFAULT_IMAGE` (`"fabrica-claude-code:latest"`, built from
  `docker/Dockerfile` in this directory - see "Process containment"
  below for what it installs). Overridable for tests that need a
  different image, e.g. one with Node to run a fake CLI script.
- **`env`** - the exact environment variables the contained process
  receives, passed straight through to `runContained`'s allowlist. Leave
  it out and the container gets only what its own image defines -
  nothing from this process's own environment (API keys, tokens) leaks
  in.

## `ask(brief)` — SPEC.md step 2 (issue #8)

Judges whether `brief` is materially ambiguous, before any ProductionLine
exists. Since there's no `workdir` at this point in the loop (`Brain.ask`
takes none - see `../README.md`), this can't reuse `work()`'s containment
setup, which mounts a real ProductionLine's git history back in
(`resolveGitMounts`). Instead:

```
claude -p "<ask prompt>" --output-format stream-json --verbose
```

run inside a fresh, empty scratch directory (`mkdtempSync`, deleted again
after the call), mounted alongside an equally throwaway `homeDir` - no
git, no
`readOnlyMounts`, no `--permission-mode bypassPermissions` (this call is
never asked to edit anything, so it needs none of the tool access that
flag exists to unlock), no `--resume` (every call is a cold, throwaway
session; see below for why one never carries into `work()`). `--model` is
still forwarded when configured, same as `work()`. The home directory is
not optional even for a call this short: a `--user <uid>` container with
no mounted home resolves `$HOME` to the read-only `/`
(`../../containment/README.md`), and the CLI writes startup config/state
under `$HOME` before it does anything else. `work()` keeps its home
across calls so `--resume` can find the last session; `ask()` never
resumes, so its home is minted and deleted per call.

`buildAskPrompt` (`claude-code.ts`) states the same "materially
ambiguous" line this codebase draws everywhere else - an ambiguity that
would change what gets built, not something a reasonable person would
fill in the same way every time - and instructs the model to answer with
nothing but a JSON object: `{"questions": [...]}`, empty array meaning
proceed. `parseAskResult` reads the terminal `result` line's `result`
field (the same field `work()`'s error path already reads), stripping a
fenced code block if the model wrapped its JSON in one despite the
instruction. Entries that aren't non-blank strings are dropped from the
list rather than voiding it, so one stray element can't lose a real
question (`registerAndAsk` filters the same way). Anything that still
isn't parseable, or has no usable question left, is treated as
"nothing to ask" rather than
failing the task - a formatting slip from the model shouldn't block work
that was actually clear, matching this issue's own stated bias toward not
over-asking. A genuine infrastructure failure (docker unreachable, a
non-zero exit, no `result` line at all) still throws `ClaudeCodeError`
exactly like `work()`'s equivalent failures - the defensive fallback
covers unparseable *content*, never a broken call.

**Why no session carries between `ask()` and `work()`.** A session can
only be resumed from the `cwd` it was created in (see "Warm sessions"
below) - `ask()`'s scratch directory and `work()`'s ProductionLine
`workdir` are never the same path, so a session id from one could never
be resumed by the other even if this adapter tried to thread one through.
`Brain.ask`'s own contract (`../README.md`) reflects this: no session
parameter, no session on the way back.

**Testing this without a real call.** `ask()` mints its own scratch
directory per call (there being no ProductionLine to run inside yet), so
unlike `work()`'s tests - which copy the fake CLI into a real
`makeFixtureRepo` worktree's `workdir` before calling it - a test has
nowhere to seed the fake binary ahead of time. `askScratchDir` on
`ClaudeCodeAdapterOptions` exists for exactly this: the same purpose as
`binPath`/`image` above, a test-only override so `claude-code.test.ts`
can point `ask()` at a directory it already copied `fake-claude-cli.mjs`
into. The fake CLI matches ask() scenarios by substring on the full
prompt (`ASK_SCENARIO_QUESTIONS`, `_NONE`, `_FENCED`, `_GARBLED`) rather
than the exact-string switch its other scenarios use, since `brief` here
is the caller's marker wrapped inside `buildAskPrompt`'s fixed template,
never the marker alone.

## The command it runs

For a cold call with no options:

```
claude -p "<brief>" --output-format stream-json --verbose --permission-mode bypassPermissions
```

run with `cwd` set to `workdir`. `--resume <opts.session>` is appended
when a prior session is passed in, `--model <opts.model>` when one was
configured, and `--effort <opts.reasoningEffort>` when one was
requested. Nothing else varies.

### Why `--permission-mode bypassPermissions` is always there

Verified directly: run `claude -p "create hello.txt" --output-format json`
with no permission mode set, in a directory it hasn't seen before, and
every `Write`/`Edit`/`Bash` attempt comes back permission-denied - the
real response includes lines like `"tool_name":"Write"` in a
`permission_denials` array, because non-interactive mode has no TTY to
answer an approval prompt, so the only thing it can do is refuse. Reads
still work; nothing that changes `workdir` does.

That would make the adapter unable to do the one thing `Brain.work()`
promises: that the work is genuinely done inside `workdir` by the time
it resolves. `--permission-mode bypassPermissions` removes the
approval step entirely - and the cost of that would have to be stated
plainly if nothing else confined it: for the duration of a call, the
worker would have the full access of the OS account this adapter runs
as. It doesn't, because `work()` always runs the call through
`../../containment/`'s `runContained` (Docker) - see "Process
containment" below for what that guarantees and the one thing it
doesn't yet.

### Process containment

Every call runs inside a fresh, throwaway Docker container: the only
writable mounts are `workdir` and this adapter's own per-task session
home (below), the project's git history is mounted read-only, network
deliberately allowed (this CLI needs it to reach its own API - see
`../../containment/README.md` for why filesystem is what's actually
enforced here, and why Docker's own bind-mount model makes that
guarantee stronger than a host-process sandbox's could be). This isn't
a description of a mechanism - it's real and verified on the real
machine; see that README for what was tried before (macOS's
`sandbox-exec`, replaced), what broke, and what's actually proven.

Two things a real coding-agent Worker needs would otherwise break under
that same containment, both closed:

- **Git.** `workdir` is a git worktree, whose `.git` names the real
  project's shared history by an absolute host path outside `workdir` -
  mounting only `workdir` leaves git unable to find its own repository
  at all. `work()` resolves that real path itself
  (`resolveCommonGitDir`, `src/line/worktree-git.ts`) and mounts it
  back in, read-only. Verified live: `git status`/`git log` work
  normally; `git commit` fails with "Read-only file system" - a
  deliberate result, not a bug, since it structurally prevents a
  contained Worker from committing its own work at all (merges and
  commits happen outside the Worker). One file in that mount is never
  the real one: the shared `.git`'s `config` can carry a push
  credential in several forms (a remote URL, an `extraheader` line, an
  `insteadOf` rewrite, a credential-helper setting), so `work()`
  shadow-mounts a throwaway sanitized copy (`writeSanitizedGitConfig`,
  deleted again after the call) over the real config's path. That copy
  forwards only the real config's `[core]` section plus individually
  allowlisted, credential-free `[extensions]` keys - an allowlist, so
  anything not explicitly forwarded is invisible by construction; an
  `[extensions]` key off the allowlist fails the run with a clear
  error naming it, never silently dropped or passed through - and the
  Worker keeps history, reflogs, and the object database (read-only
  context on a project it already has fully checked out), but nothing
  from the project's git configuration beyond `[core]` and those
  structural extension keys is readable inside the container. There is
  no no-git fallback: a `workdir` whose git mounts can't be resolved -
  no git repository at all, a corrupted worktree, an unsanitizable
  config - refuses the run with an error saying what to fix (for the
  no-git case: initialize git in the project first), instead of running
  the Worker with git silently unavailable.
  See `../../containment/README.md`'s "Git under containment" for the
  full reasoning, the exact read-boundary, the known `partialClone`
  limitation, and the design that was tried and rejected first.
- **Warm sessions.** Every call is a fresh, throwaway container, so
  without something persisted across calls, a second attempt's
  `--resume` would find no session at all. `work()` derives a per-task
  home directory from `workdir` (`` `${workdir}.fabrica-session` ``,
  created on demand) and mounts it as the container's `$HOME` on every
  call for that `workdir` - see `../../containment/README.md`'s
  "Session persistence" for what's verified and the one honest gap
  (nothing yet deletes that directory when the task's line is torn
  down).

One real thing still doesn't work end to end: authentication. The
host's installed `claude` binary is a native macOS executable and can
never run inside a Linux container - verified via `file` on it. What
does work, also verified: installing that same tool's own Linux build
via its public npm package inside a container (`docker/Dockerfile` in
this directory, built once as `DEFAULT_IMAGE`) - it starts, parses
arguments, and reports a version. What it can't do yet is log in: a
fresh container has no credential configured at all, verified live
(`claude auth status` inside the built image reports "Not logged in").
That's an ordinary bootstrap requirement for any brand-new install of
an authenticated CLI, not a special containment-caused breakage the way
`sandbox-exec`'s Keychain failure was.

Closing it means giving this adapter's container a non-Keychain
credential - `claude setup-token` generates a long-lived token meant for
exactly this kind of headless use - which is a live-credential decision
for whoever configures Fabrica, not something this file decides on its
own. Until that's done, real tasks routed through this adapter fail at
the authentication step; `claude-code.test.ts`'s capability-spike test
checks the built image's own auth status before attempting real work,
and skips (does not fail) rather than lie about proving this when it
isn't true. That skip is deliberately loud rather than silent - the same
file's `after()` hook prints a banner naming the reason whenever the
spike didn't run - and a fixture-parity test covers the fake in the
meantime; see `README.md`'s "Guarding a fake against drift from the real
thing" for both and why they exist. One caveat on that guard, noted in
the test itself: it probes auth as the image's own default user and
`$HOME`, not the `--user`/mounted-home combination `work()` actually
runs with - equivalent while the credential arrives via the
environment, but the guard needs realigning if the gap is ever closed by
baking a credential into the image instead.

### The worker image, and rebuilding it after a toolchain change

`docker/Dockerfile` in this directory builds `DEFAULT_IMAGE`
(`fabrica-claude-code:latest`). It is not built automatically by
anything - `runContained` expects to find it already there - so build it
once before any contained call, and rebuild it whenever that file
changes, from the repository root:

    docker build -t fabrica-claude-code:latest -f src/brain/adapters/docker/Dockerfile .

Everything in it is digest- or version-pinned, so a rebuild that changed
nothing installs exactly what the last one did.

Besides the CLI itself the image carries the toolchains a Worker needs
to run a project's own check command inside its container (issue #86) -
a Worker that cannot run the checks writes blind and burns fix rounds.
Today that is git (for the read-only `.git` mount) and Go, copied from
the official Go image rather than `apk add go`, which on this base is
1.25.10 and older than a real project pins. Verified on the real machine
after a rebuild:

    docker run --rm fabrica-claude-code:latest go version
    go version go1.26.8 linux/arm64

and, under the shape `work()` actually runs with - an unprivileged
`--user`, a bind-mounted `$HOME`, and a mounted `workdir` - `go test
./...` passes in a small module there, so the toolchain is usable and
not merely present. One image carrying every toolchain is the short-term
answer; per-project worker images are a separate, later issue.

### Why `--output-format stream-json --verbose`, not `json`

`--output-format json` prints one object after the whole call finishes:
useful for cost and session id, useless for `transcript`, which is
supposed to be the structured record of what the worker actually did.
`stream-json` prints one JSON object per line as the call runs - the
same terminal summary object is still the last line, so nothing is
lost, and every turn along the way becomes something `toTranscript()`
can map into its own entry. `--verbose` is required alongside it:
omitting it fails immediately with `Error: When using --print,
--output-format=stream-json requires --verbose` (verified) before any
work happens at all.

## Warm sessions: `opts.session` and `--resume`

Passing `opts.session` appends `--resume <that id>` and the returned
`session` is the same id back - confirmed live: resuming a session and
asking for a second file produced it while the session id in the result
stayed byte-for-byte identical to the first call's.

One real constraint worth knowing: **a session can only be resumed from
the same working directory it was created in.** Resuming a real session
id from a different `cwd` fails with `No conversation found with
session ID: <id>`, exit code 1 - verified by resuming a session from a
second, unrelated directory. This is never a problem in Fabrica's own
use: one task gets one `ProductionLine` worktree for its whole life
(`src/line/README.md`), so every `work()` call for that task already
runs in the same `workdir` by construction. It would only bite a caller
that tried to resume a session against a workdir other than the one
that started it - not something this adapter does.

That verification predates containment, where a second constraint joins
it: the session data itself lives under `$HOME`, and every contained
call is its own fresh, throwaway container. "Process containment" above
covers the fix - a per-`workdir` home directory, mounted on every call
for that task - without which this whole section would describe
behavior that stopped being true the moment `work()` started running
through Docker.

## `opts.reasoningEffort` and `--effort`

Passed straight through as `--effort <value>`, with no extra validation
in this file - the CLI's own `--effort` flag already implements the
Brain contract's "ignore what you don't recognize, don't fail" rule
before this adapter ever sees the outcome. Verified: `--effort "reasoning:
max"` (not one of the CLI's five recognized levels) printed `Warning:
Unknown --effort value 'reasoning: max' — ignoring it and using the
default effort` to stderr and still exited 0 with the call completing
normally. Passing one of the tool's real levels (`low`, `medium`,
`high`, `xhigh`, `max`) has the effect you'd expect.

## `transcript`

Each `stream-json` line becomes zero or more `TranscriptEntry` items:

| stream-json shape | `TranscriptEntry.kind` |
| --- | --- |
| assistant message, `thinking` block | `"reasoning"` |
| assistant message, `text` block | `"text"` |
| assistant message, `tool_use` block | `"tool-call"`, text is `name(JSON-encoded input)` |
| user message, `tool_result` block, `is_error: false` | `"tool-result"` |
| user message, `tool_result` block, `is_error: true` | `"tool-error"` |
| everything else (`system`, `rate_limit_event`) | dropped |

`system` lines (session init, and this environment's own `SessionStart`
hook chatter - real output included lines calling out `gh-axi` and
`lavish-axi`, tools of the *harness this binary happened to run inside*,
not of the worker's actual task) and `rate_limit_event` lines are
dropped rather than mapped, because `transcript` is what a person
reviewing the worker sees (`src/brain/README.md`), and neither is part
of the work done on `brief`.

## Cost, duration, and token usage: the `"usage"` entry

`Brain.work()`'s return type has no field for cost (`contract/surface.ts`
declares it as exactly `{ transcript, gateChanges?, session? }`, and
this adapter satisfies that shape exactly) - but the real binary's
terminal `result` line hands back everything a `Receipt` will eventually
want in one place: `total_cost_usd`, `duration_ms`, and a per-token
`usage` breakdown, alongside the `session_id` already covered by the
`session` field. A real example from the spike:

```json
{"totalCostUsd":0.065871,"durationMs":5337,"usage":{"input_tokens":4,"cache_creation_input_tokens":274,"cache_read_input_tokens":52806,"output_tokens":192}}
```

Rather than drop that data because the interface has no dedicated slot
for it, this adapter appends it as one more `TranscriptEntry`, `kind:
"usage"`, `text` the JSON string above, always last. The Foreman
(`src/foreman/`, issue #7) now assembles `Receipt`s but still records
`costUsd: null` - reading this entry back out of the transcript is issue
#11's job - and either way the data sits there without this adapter
having reshaped the `Brain` seam to fit its own tool, which is the thing
`adapters/README.md` asks every adapter to guard against.

This account is a flat-rate subscription (`claude auth status` reports
`"subscriptionType": "max"`), so the dollar figure above is notional -
real to compute, but it doesn't move a bill the way a metered API call
would (see issue #6's design comments). It's recorded anyway, faithfully,
in whatever unit the tool itself reports it in; deciding what a receipt
does with a notional figure is issue #11's job, not this file's.

## `gateChanges`

Always omitted. There is no established way for this adapter to learn
that the worker changed a ratified test or check setting - `claude`'s
own output has no field for it, and inventing an ad hoc text convention
inside `brief` or `result` isn't something this issue decided. Omitting
the field means exactly what `src/brain/README.md` says it means: the
gate was left alone, as far as this adapter can tell. If a future issue
needs a real signal here, it has to come from somewhere this adapter
doesn't currently have - not from guessing.

## Errors: `ClaudeCodeError`

Every failure this file raises is a `ClaudeCodeError` with a `code`.
One failure a caller can see from `work()` isn't one of them: resolving
the git mounts runs first, before the container starts, and its
`LineError` (`not-a-worktree`, `unsanitizable-config`) surfaces
unwrapped - that's the upfront refusal "Process containment" above
describes instead of a no-git fallback, and its message already says
what to fix.

- **`spawn-failed`** - `../../containment/`'s `runContained` threw a
  `ContainmentError` (`docker` itself couldn't be launched, or a path it
  was handed can't be resolved or represented as a mount) - this adapter
  catches that one type and re-wraps it rather than confusing it with a
  tool-level failure. An unusable `workdir` never reaches it: resolving
  the git mounts runs first and refuses that as the `LineError` above.
  A wrong `binPath` that simply doesn't exist *inside* the container is
  different: Docker starts fine and the command fails with a normal
  non-zero exit, which surfaces as `cli-error` below, not this.
- **`cli-error`** - the binary ran but the call failed. Two real shapes
  were verified, and this adapter reads whichever one shows up:
  - Exit code 1, **no** JSON on stdout at all, a one-line plain-text
    message on stderr - verified for a bad `--resume` id:
    `No conversation found with session ID: <id>`.
  - Exit code 1, stdout **is** valid JSON with `is_error: true` and an
    `api_error_status` - verified both for an unrecognized `--model`
    (`api_error_status: 404`, message `"There's an issue with the
    selected model..."`) and for a bad API key
    (`api_error_status: 401`, message `"Invalid API key · Fix external
    API key"`). This is why the adapter always tries to parse stdout as
    `stream-json` first regardless of exit code, and only falls back to
    stderr's plain text when there's no JSON to read a real message
    from.
- **`unparseable-output`** - exit code 0, but no `type: "result"` line
  ever appeared. Defensive: not observed against the real binary, but
  if it ever happened there would be no session id or cost to recover,
  so this adapter refuses rather than returning a `BrainWorkResult`
  with silently-missing data.
