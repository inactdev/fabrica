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

Call this once to get a `Brain`. Four optional fields:

- **`model`** - the value passed straight to `claude --model`, e.g.
  `"claude-opus-5"` or the alias `"sonnet"`. Leave it out and the call
  omits `--model` entirely, so whatever model the `claude` binary is
  already configured to use by default runs. In that case `Brain.model`
  reports the string `"default"` rather than guessing which model that
  resolves to - the adapter would have to make an extra real call just
  to find out, and `"default"` is the honest answer to "which model is
  this adapter using" when no override was given.
- **`binPath`** - the executable to spawn instead of `"claude"`.
  Exists so `claude-code.test.ts`'s fast tests can point this at
  `helpers/fake-claude-cli.mjs`, a script that prints canned responses,
  instead of paying for a real call on every test run. Leave it out in
  real use; it resolves `"claude"` via `PATH`, same as typing it at a
  shell.
- **`contained`** - route the call through `../../containment/`'s real
  OS-level sandbox instead of a raw host spawn. Defaults to `false` - see
  "Process containment" below for exactly why, and what has to change
  before it can default to `true`.
- **`homeDir`** - only used when `contained` is set: the directory the
  sandbox excludes from its read allowance. Defaults to `os.homedir()`;
  overridable so tests can point it at a throwaway fixture instead of the
  real machine's real home directory.

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
approval step entirely - and the cost of that must be stated plainly:
for the duration of a call, the worker has the full access of the OS
account this adapter runs as. `Bash`/`Write`/`Edit` are **not** scoped
to `workdir` by this flag alone. The `ProductionLine` worktree protects
the Client's real project files from modification (CONTRACT rule 1,
`src/line/README.md`), but it provides no process-level containment on
its own. `opts.contained` (see "Process containment" below) is the real
fix for that - not yet the default, for one specific, verified reason.

### Process containment

Passing `contained: true` runs the CLI through `../../containment/`'s
`runContained` instead of a raw host spawn: reads and writes confined to
`workdir`, network deliberately allowed (this CLI needs it to reach its
own API - see that module's README for why filesystem is what's
actually enforced here). That mechanism is real and verified on the
real machine, not a description of one - see
`../../containment/README.md` for what was tried, what broke, and what's
actually proven.

It is **not** the default for this adapter yet, and that's a deliberate,
documented gap rather than an oversight. Verified live: the real
`claude` binary authenticates through macOS Keychain (`claude auth
status` reads a Keychain item, not a file or an env var), and Keychain
access for a sandboxed process is gated by sandbox-container entitlements
Apple grants its own signed apps - not something an ad-hoc `sandbox-exec`
profile can restore. Running the real binary with `contained: true`,
even with every read and mach-lookup rule wide open, comes back `"Not
logged in · Please run /login"`; the underlying keychain query itself
fails with `SecKeychainSearchCreateFromAttributes: A Module Directory
Service error` (checked without ever reading the credential's actual
value).

So flipping the default to `true` today would break the one real,
currently-working adapter's ability to authenticate at all. Fixing that
means moving this adapter to a non-Keychain credential - `claude
setup-token` generates a long-lived token meant for exactly this kind of
headless use - which is a live-credential decision for whoever
configures Fabrica, not something this file decides on its own.

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

Every failure this file raises is a `ClaudeCodeError` with a `code`:

- **`spawn-failed`** - the binary itself couldn't be started (wrong
  `binPath`, `workdir` doesn't exist). Verified: spawning into a
  nonexistent directory fails at the Node `child_process` layer with
  `ENOENT` before `claude` ever runs - this adapter surfaces that
  directly rather than confusing it with a tool-level failure.
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
