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

`buildAskPrompt` (`claude-code.ts`, exported for its own direct test) states
the same "materially ambiguous" line this codebase draws everywhere else -
an ambiguity that would change what gets built, not something a reasonable
person would fill in the same way every time - and instructs the model to
answer with nothing but a JSON object: `{"questions": [...]}`, empty array
meaning proceed. It also states plainly that the empty scratch dir is
deliberate - the project's files are not present at this step on purpose
and will be there once work starts - so a worker asks only about what the
Client wants, never "where is the code?" (that question kept coming back
before this sentence was added); this is specific to the clarify step and
must never leak into the work brief (`src/foreman/standing-question.ts`'s
`withStandingQuestion`), where the project genuinely is present and the
sentence would mislead. `parseAskResult` reads the terminal `result` line's `result`
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
claude -p "<brief>" --output-format stream-json --verbose --permission-mode bypassPermissions --json-schema '<WRITEUP_JSON_SCHEMA>'
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
home (below), the project's git history is mounted read-only, and
network reaches only what the call actually needs - this CLI has to
reach its own API to do anything at all, so network is never `"denied"`
outright, but (issue #186's second half, see below) a real call's own
network is a fresh isolated Docker network with a relay as its only
route out, not the open internet (`"allowed"` is still what a caller
with nothing to protect, e.g. this file's own fast tests, gets). See
`../../containment/README.md` for why filesystem is what's actually
enforced here, and why Docker's own bind-mount model makes that
guarantee stronger than a host-process sandbox's could be. This isn't
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

Authentication now works end to end, and it took one deliberate
decision to get there. The host's installed `claude` binary is a native
macOS executable and can never run inside a Linux container - verified
via `file` on it. What does work, also verified: installing that same
tool's own Linux build via its public npm package inside a container
(`docker/Dockerfile` in this directory, built once as `DEFAULT_IMAGE`).
A fresh container has no credential of its own, which is the ordinary
bootstrap requirement for any brand-new install of an authenticated CLI,
not a containment-caused breakage the way `sandbox-exec`'s Keychain
failure was.

The gap is closed (issue #85) by forwarding a credential from the host's
environment, never by baking one into the image. `claude setup-token`
mints a long-lived token meant for exactly this kind of headless use.
`index.ts`'s `defaultBrainAdapter(recordHome)` reads exactly one
variable, `CLAUDE_CODE_OAUTH_TOKEN` (`HOST_TOKEN_VAR` in this file), into
`ClaudeCodeAdapterOptions.env`: from this process's environment when it
is set there, otherwise from `<recordHome>/brain.env`, which Fabrica
reads itself (Client ruling 2026-10-10). No shell profile has to export
it. That file must be mode 600 (otherwise refused, naming `chmod 600`)
and hold exactly one `CLAUDE_CODE_OAUTH_TOKEN=...` line, optionally
written `export CLAUDE_CODE_OAUTH_TOKEN=...` so a shell can source the
same file. Every other line is ignored, never forwarded; no token line,
an empty one, or two of them is refused, naming the file. Nothing else
from the host environment crosses the container wall - that option is an
explicit allowlist, not a pass-through. With neither source, the
adapter's first call (the clarifying step, before any worker starts)
refuses with a message naming `claude setup-token` and the file path,
and the task records it as `ask-failed`. The token is looked up at that
first call, not when the adapter is built, so a command that never needs
a worker (an `accept` verdict) never needs a token.

**The token stops there now - it never reaches the container itself.**
Issue #186's second half (scoped down: no `projects.toml`, no `fabrica
doctor`) put a relay between this credential and the box. `work()`/
`ask()` both run every call's `env` through `prepareNetwork`: when
`HOST_TOKEN_VAR` is present (every real call), `connectThroughRelay`
spins up a fresh, internet-less Docker network
(`../../containment/isolated-network.ts`'s `createIsolatedNetwork`,
issue #186's own "the worker box having no direct network") and starts
`../../relay/`'s relay bound to that network's own gateway address, with
`tunnelAllowlist: GITHUB_HOSTS` and a `gateway` pointed at the real
`ANTHROPIC_HOST`, credential-swapping a freshly minted, per-call
placeholder for the real token. The container is then run with
`network: { isolatedNetwork }` instead of `"allowed"`, and its env drops
`CLAUDE_CODE_OAUTH_TOKEN` entirely in favor of `ANTHROPIC_BASE_URL`
(pointed at the relay) and `ANTHROPIC_AUTH_TOKEN` (the placeholder) -
verified against Claude Code's current documentation
(`code.claude.com/docs/en/llm-gateway-connect`,
`.../authentication#authentication-precedence`) as the officially
supported gateway-routing pair: `ANTHROPIC_BASE_URL` overrides the API
endpoint, and `ANTHROPIC_AUTH_TOKEN` is "sent as the `Authorization:
Bearer` header... when routing through an LLM gateway or proxy that
authenticates with bearer tokens" - `CLAUDE_CODE_OAUTH_TOKEN` itself has
no documented gateway-routing support, so it is never the variable that
reaches the box. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and both
cases of `HTTP(S)_PROXY` are set alongside it (the first so Claude
Code's own telemetry/version-check traffic, which bypasses
`ANTHROPIC_BASE_URL` and would otherwise hang trying to reach a host this
network has no route to, is turned off instead; the second so GitHub
reachability survives for anything in the box that honors the ordinary
proxy convention). The relay and network are torn down in the same
`finally` that already cleans up each call's sanitized git config/
scratch dirs - as throwaway as the container itself. **The one fact this
file cannot verify from documentation or on this machine** (no Docker,
no live credential, at the time this was written): that
`api.anthropic.com` actually accepts a subscription OAuth token as a
plain `Authorization: Bearer` value the same way it would via
`CLAUDE_CODE_OAUTH_TOKEN`'s own code path. It is the standard OAuth-bearer
wire format, but confirming it needs a real task to actually deliver -
see `claude-code.test.ts`'s "never forwards the real worker token"
tests for the mechanism proof (container never sees the real value,
only a placeholder), and `../../relay/README.md` for the relay/network
mechanism itself.

Because the token arrives by environment rather than being baked in, the
caveat on `claude-code.test.ts`'s capability-spike guard still holds as
written: it probes auth as the image's own default user and `$HOME`,
which is equivalent to the `--user`/mounted-home combination `work()`
really uses only while the credential travels this way. That guard runs
`docker run` without forwarding the variable, so it still skips unless
the image itself is authenticated; the skip is deliberately loud (the
same file's `after()` hook prints a banner naming the reason) and a
fixture-parity test covers the fake in the meantime - see `README.md`'s
"Guarding a fake against drift from the real thing" for both and why
they exist.

### The worker image, and rebuilding it after a toolchain change

`docker/Dockerfile` in this directory builds `DEFAULT_IMAGE`
(`fabrica-claude-code:latest`). It is not built automatically by
anything - `runContained` expects to find it already there - so build it
once before any contained call, and rebuild it whenever that file
changes, from the repository root:

    docker build --build-arg DOCKERFILE_SHA256=$(shasum -a 256 src/brain/adapters/docker/Dockerfile | cut -d' ' -f1) \
      -t fabrica-claude-code:latest -f src/brain/adapters/docker/Dockerfile .

The build arg stamps the image with the Dockerfile's hash (a LABEL,
`fabrica.dockerfile-sha256`), which is how `fabrica doctor` tells a
current image from one built before the Dockerfile last changed - it
prints this exact command, hash filled in, when they differ.

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
lost, and every turn along the way becomes something `mapLineToEntries()`
can map into its own entry, live, as that line's newline lands (see
"Mapped live, not batched at the end" below). `--verbose` is required alongside it:
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

**Mapped live, not batched at the end (issue #70).** `runContained`'s
`onStdout` option delivers each raw chunk of the container's stdout as
it arrives; `lineFeeder` (`claude-code.ts`) buffers that into complete
lines (holding a line split across a chunk boundary until its newline
lands, exactly as `parseLines` would see it from the whole buffered
output), and each complete line is mapped through the same
`mapLineToEntries` the table above describes - no separate "live"
mapping logic to drift from the batch one, because there is no batch
one any more: this is the only mapping pass now. Every entry produced
this way is pushed onto the same array `work()` eventually returns as
`transcript`, and also handed to `../live-transcript.ts`'s
`emitLiveTranscriptEntry(workdir, entry)` the instant it's produced -
`src/foreman/attempts.ts` registers a listener for that exact `workdir`
before calling `brain.work()`, so entries reach `transcript.log` while
the call is still running, not once it resolves. The `"usage"` and
`"budget-exhausted"` entries below are the one exception: both are
synthesized from the terminal `"result"` line, which by definition
isn't known until the process has already exited, so there is no
earlier "live" moment for them - they reach the record through
`runAttempts`' own catch-up delivery of whatever `transcript` carries
that wasn't already emitted live, not through
`emitLiveTranscriptEntry`. Nothing about `Brain.work()`'s contract
changes to make this work: `emitLiveTranscriptEntry` is this adapter's
own choice, reached through `workdir` (a value both sides already have
through the ordinary `Brain` interface), not a new parameter on
`BrainWorkOptions`.

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
"usage"`, `text` the JSON string above, always last. The Foreman reads
it back into `Receipt.costUsd` (issue #11; the `"usage"` kind and its
`totalCostUsd` field are now documented on `contract/surface.ts`'s
`TranscriptEntry`), without this adapter having reshaped the `Brain` seam
to fit its own tool, which is the thing `adapters/README.md` asks every
adapter to guard against.

`BrainWorkOptions.maxSpendUsd` (rule 10's remaining per-task budget) is
passed as `--max-budget-usd`. Verified against the real 2.1.295 binary:
when the budget runs out, the CLI exits 1 with a result line carrying
`is_error: true`, `subtype: "error_max_budget_usd"`, no `result` text,
and the real `total_cost_usd`, which can already be well past the budget
(one turn cost $0.14 against a $0.0001 budget), since the CLI checks
after a turn, not during one. That is the cap working, not the brain
failing, so this adapter returns normally in that one case. It adds a
`kind: "budget-exhausted"` entry plus the usual `"usage"` entry, so the
spend reaches the receipt and the Foreman stops the task honestly,
instead of a thrown error losing the money on the record.

This account is a flat-rate subscription (`claude auth status` reports
`"subscriptionType": "max"`), so the dollar figure above is notional -
real to compute, but it doesn't move a bill the way a metered API call
would (see issue #6's design comments). It's recorded anyway, faithfully,
in whatever unit the tool itself reports it in, and marked
`costBasis: "subscription-estimate"` on that same usage entry (issue
#188) - so once a metered adapter arrives, the two kinds of dollar never
mix in one total. `fabrica status` and the live view show it with a "~"
and it never refuses work on its own; only real, metered spend binds the
caps. This is hardcoded for this adapter, not detected from `claude auth
status` at runtime - v1 only ever runs this adapter against the Client's
own subscription (ROADMAP.md), so there is no live case to detect yet.

## `writeup` and `--json-schema`

Every `work()` call passes `--json-schema` with `WRITEUP_JSON_SCHEMA`: an
object of eight required fields, no other keys - seven non-empty strings
(`title` at most 60 characters, `what`, `why`, `how`, `assumptions`,
`expectedOutcomes`, `deviations`) plus one number, `confidence`, from 0
to 100 (issues #185/#194). Verified on 2.1.222 with a real call: the
result line then carries the answer as an object on `structured_output`
(with `subtype: "success"`), and `work()`
returns it as `writeup`. Nothing is ever parsed out of the worker's text;
a result line without a well-shaped `structured_output` returns no
`writeup`, and the Foreman makes that attempt red. A result line with
`subtype: "error_max_structured_output_retries"` (the CLI giving up on
the schema) is treated the same way rather than thrown, so the attempt's
work and spend are kept - that subtype's exact shape is taken from the
binary's own strings, not from a recorded run.

`structured_output` is not on `stream-json-shape.ts`'s parity allowlist
yet: the recorded fixture predates `--json-schema` and would need a
real re-recording to cover it.

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
