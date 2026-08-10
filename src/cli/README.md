# The `fabrica` command

`src/cli/` is the terminal program: the only thing in this repository a
Client actually types at. Everything else in `src/` is a library that,
until this module existed, nothing but the contract tests ever called
(issue #47). This module's whole job is turning `createForeman`'s
programmatic seam into `fabrica do "<task text>" --project
<path-or-name>` - argument parsing, config, project resolution, and the
detached-process mechanism SPEC.md requires - without changing anything
about how the loop itself works.

## Installing it

```
npm install
npm link
```

`npm link` reads `package.json`'s `"bin": { "fabrica": "./src/cli/bin.mjs" }`
and makes `fabrica` resolve on your `PATH` from any directory. There is
no build step - `bin.mjs` loads `src/`'s TypeScript directly at runtime
(see "Why `bin.mjs` isn't a shebang'd `.ts` file" below), the same way
`npm test` already does via `tsx --test`.

## `fabrica do "<task text>" --project <path-or-name>`

The one command this issue builds. What it does, in order:

1. **Parses arguments** (`do-args.ts`). Exactly one positional (the task
   text - quote it if it has spaces) and one required `--project`
   (`--project <value>` or `--project=<value>`, either order). Anything
   else - missing task text, missing `--project`, an unrecognized flag,
   two positionals - refuses with the exact usage line, exit 1, nothing
   spawned.
2. **Reads config** (`loadConfig`, from `src/index.ts`) for the record
   home's project registry and caps. A record home with no
   `projects.toml` at all yet (a brand-new install) is not an error -
   treated as an empty registry, so a first-ever `fabrica do` against a
   plain `--project <path>` still works. A `projects.toml` that exists
   but is malformed still refuses, with the same message `loadConfig`
   already produces.
3. **Resolves the project** (`resolve-project.ts`): a `--project` value
   that matches a name in `projects.toml` resolves to that project's
   configured path (and refuses up front, exact instructions, if that
   project has no `check` command yet - CONTRACT rule 2). Anything else
   is treated as a literal filesystem path, resolved against the current
   directory, and must exist as a directory or this refuses too. This is
   the "-or-name" half `foreman/README.md` calls out as explicitly a
   CLI-layer concern - `doTask` itself only ever sees a resolved path.
4. **Spawns the loop, detached** (`spawn-detached.ts`), and learns the
   new task's id the moment it's registered (`watch-for-task-id.ts`).
5. **Waits, bounded, to see whether the task asks, proceeds, or fails**
   (`wait-for-ask-outcome.ts`, issue #8): the detached process is still
   running `doTask` (`src/foreman/do.ts`), which now does register ->
   ask -> maybe isolate/work in one call (SPEC.md step 2, "Clarify-or-
   proceed" - see `src/foreman/README.md`'s "The ask-first seam"). This
   polls that task's own record for whichever of `"questions-asked"`,
   `"ask-failed"`, or `"work-started"` lands first:
   - **Materially ambiguous** → stops, printing the numbered questions
     and how to answer them (`fabrica answer <id> -m "<text>"`) to
     **stderr**. No Worker ever ran; nothing keeps running in the
     background for this task until answered.
   - **`brain.ask()` itself threw** (the reference adapter's documented
     credential gap is today's live path) → stops, printing the real
     reason to **stderr** and exiting **non-zero** (Client ruling, issue
     #8 follow-up: "a failed task must never look like a started one").
     `ask.ts`'s `registerAndAsk` already wrote this to the record as
     `"ask-failed"` before this process ever sees it.
   - **Otherwise, or if the wait times out** → nothing further to print;
     this process then exits, and the task keeps running in the
     background. See "Why detached execution needs its own file" below
     for the spawn mechanism.

   The wait is bounded, not indefinite, on purpose - but the timeout is
   for the genuinely-slow-brain case only, not a stand-in for "the task
   failed": a brain that throws is detected directly, above, the moment
   `"ask-failed"` lands, not left to exhaust the clock. Only a brain
   that is simply slow, or a task that fails for an unrelated reason
   before ever reaching `"work-started"` (e.g. a missing check command -
   a known, separate gap this doesn't close), falls through to the
   timeout, which still resolves as "proceeding" - the task itself is
   never affected by what this observes; it keeps running (or, in that
   separate gap's case, has already failed silently upstream of what
   this can see).

**stdout is always exactly the task id, one line, nothing else, in
every outcome including the failed one** - Client ruling (issue #8
follow-up): an earlier version also put the asking case's explanation
and questions on stdout, which broke the documented contract below by
putting prose ahead of `$id` in the output a script reads. Explanations,
questions, and failure reasons are all for the Client's own screen, not
data - they go to stderr. There is no separate exit code for the asking
case (restoring the plain stdout contract already covers scripting -
`fabrica answer` and the task's own `"questions-asked"` event carry the
real content regardless of what the terminal still shows), but the
failed case does exit non-zero - the one outcome this contract actually
has to distinguish, since a script's `id=$(fabrica do "...") || exit 1`
depends on that exit code alone to know whether `$id` is worth trusting.

A refusal at steps 1-3 exits non-zero with the message on stderr - safe
to use in a script (`id=$(fabrica do "..." --project foo) || exit 1`).
Once step 4 starts, this process's own exit code no longer reflects the
task's eventual outcome for the "proceeds" case, which is the nature of
detachment: by design, nothing is left waiting around to report delivery
or failure here - `fabrica status`/`log`/`watch` (below) are how you
find out what happened. The "asks" and "`ask()` threw" cases are the
exceptions: this process already knows and reports those outcomes
directly (the failed one non-zero), since no work was ever started to
detach from.

## `fabrica answer <taskId> -m "<text>"`

Answers the clarifying questions `fabrica do` printed and stopped on
(issue #8), and resumes the task. Like `fabrica verdict`, this never
detaches: resuming runs the task's isolate/work/verify/deliver pipeline
synchronously (`src/foreman/answer.ts`'s `answerTask`, the same
`runProductionRound` `do()` itself uses once it decides to proceed), so
the command can report the outcome directly.

`answer-args.ts` parses one positional (the taskId) plus a required
`-m "<text>"`, mirroring `verdict-args.ts` - Client ruling: the two
commands where the Client types free prose should behave identically,
in `git commit -m`'s already-familiar shape, and a flag (unlike a bare
positional) takes an answer that starts with a dash, e.g. `-1 means
unlimited`, without mistaking it for a flag of its own.
`answer-command.ts` resolves the record
home the same way `do-command.ts`/`verdict-command.ts` do and calls
`createForeman({ recordHome }).answer(taskId, text)` - no brain override
in real use, so this always uses `defaultBrainAdapter()` unless the same
process already ran the `do()` call that asked (there is no such case for
the real CLI, where `fabrica do` and `fabrica answer` are always separate
invocations - see `src/foreman/README.md`'s "The ask-first seam" for the
per-instance brain memory this falls back from). SPEC.md's "one
clarification round by default" is enforced by the Foreman, not this
file: once a round has actually *delivered*, a second `fabrica answer`
on the same task refuses with `ForemanError("already-answered")`. A
round that threw before delivering does not spend the clarification
round - the command can be run again, and reports whatever the retry
does (see `src/foreman/README.md`'s "The ask-first seam" for why the
guard keys on a delivered round rather than on the answer being
recorded).

### `FABRICA_HOME`

Overrides the record home (`record-home.ts`). Omit it and the record
home is `~/.fabrica`, matching SPEC.md's default; the environment
variable is what SPEC.md calls "path configurable." Mainly useful for
scripting against a throwaway record home instead of the real one.

## `fabrica verdict <taskId> <accept|fix|wrong> [-m "<note>"]`

CONTRACT rule 6 - the Client's ruling on a delivered task, described in
full in `src/foreman/README.md`. Unlike `fabrica do`, this never
detaches: `accept` and `wrong` are instant (they only append a record
event), and a `fix` runs its one worker round synchronously so the
command can print that round's number and outcome directly rather than
making the Client separately poll for it. There is no limit on how many
`fix` rounds a task can have; the number in the printed line comes from
`fixRoundOf`.

`verdict-args.ts` parses the two positionals plus `-m "<note>"` (`fix`
requires the note, since it is the correction itself). The note has
exactly one spelling, the one SPEC.md documents and `git commit -m`
already taught every Client - a bare positional note is refused with a
message naming the flag, rather than quietly accepted as a second way to
say the same thing (Client ruling). `verdict-command.ts`
resolves the record home the same way `do-command.ts` does and calls
`createForeman({ recordHome }).verdict(...)` - no brain override, so a
`fix` here always uses `defaultBrainAdapter()` (there is no
same-process `do()` call for this command to remember a brain from,
unlike the contract tests - see `src/foreman/README.md`'s "What a fix
costs" section).

## `fabrica status`, `fabrica log <id>`, `fabrica watch <id>`

Issue #12 - the Client's eyes on a detached task, without reading record
files himself. All three are strictly read-only over the record; none of
them can reach a running worker.

- **`status`** lists every open task, one line each: id, project, state,
  age. A `delivered` task is flagged as awaiting the Client's verdict -
  nothing else in the tool says a task is waiting on him. A `working`
  task with no recorded activity for longer than `QUIET_THRESHOLD_MS` is
  flagged "quiet" rather than left looking identical to progress; a
  `checking` task instead says so with its real elapsed time and is
  exempt from the quiet alarm below `CHECKING_QUIET_CEILING_MS` (4
  hours), since that silence has a known, honest explanation; past that
  ceiling `isQuietTooLong` returns true for it too and the alarm takes
  over the line, because a check still running after that long is the one
  case a live-elapsed reading can't explain (a killed worker, or a check
  hung inside `runCheck`'s `execSync`). The pre-work `brain.ask()`
  window is exempt for the same reason - `stateOf` already reads
  "working" from `task-received` onward, so `isQuietTooLong` also waits
  for a `"work-started"` event before it will raise the alarm. It takes
  no arguments at all, and refuses any it is given (`parseStatusArgs`)
  instead of ignoring them.
- **`log <id>`** prints one task's event history in order, each event
  rendered as prose judged per event name rather than its stored
  `details` dumped raw, and a consecutive run of heartbeats collapsed
  into one "14 heartbeats over 3m" line (a lone heartbeat still
  reads as an ordinary one). `--transcript` adds the worker's raw
  transcript entries.
- **`watch <id>`** polls the record and prints new transcript entries and
  heartbeats as they land, plus the same quiet and mid-check notices
  `status` uses. A backlog of heartbeats found on the first poll - normal
  when attaching to a task that has been running a while - collapses into
  the one "N heartbeats over 3m" line `log` uses, so catching up never
  buries the transcript entries printed just above it. When the task
  reaches a state nothing further is expected from, it prints a terminal
  notice (`formatTerminalNotice`) instead of polling on in a silence
  indistinguishable from a hang: `delivered`, and a `failed` task that
  reached a real delivery, say a `fix` verdict can still wake the worker;
  `asking` points at `fabrica answer`; and a `failed` task that never
  delivered says so plainly - `recordVerdict` would refuse a ruling on
  it. The loop ends by itself for the two states that provably cannot
  change again: `closed`, and that same never-delivered `failed` task
  (`fabrica verdict ... fix` refuses it with `not-delivered`, `fabrica
  answer` with `no-questions-pending`, so nothing can move it). Every
  other terminal state keeps polling, and the notice re-fires whenever
  the state genuinely changes, so a second delivery after a `fix` still
  announces itself. **Stopping the watch never stops the
  work**: this command only ever *reads* `events.jsonl` and
  `transcript.log`, so Ctrl-C ends the polling loop and nothing else.
  Never add anything here that reaches toward the detached process
  `fabrica do` spawned.

`render.ts` is why all three agree on wording: age (`formatAge`), the
quiet sentence (`formatQuietNotice`), the terminal notice
(`formatTerminalNotice`), the collapsed heartbeat run
(`summarizeHeartbeatRun`, shared by `log`'s history and `watch`'s
catch-up), the status line, the event line, and the transcript line each
have exactly one definition, so an edit to any of them can't drift
between commands.

Both `status` and `watch` read the record once per render, then derive
everything else from the events already in hand: `status` takes
`eventsByTask(recordHome)` (one pass over the whole log, grouped by task
id) instead of re-reading it per task, and both call `stateOf(events)`
(the same derivation `foreman.status()` runs) rather than asking the
record again - heartbeats make `events.jsonl` grow steadily while a task
runs, so a per-task or per-poll re-read gets expensive fast.

`watch` goes one step further, because once per render is still twice a
second for as long as the Client watches: it holds one `followTask`
follower (`src/foreman/follow.ts`, over `src/record/tail.ts`'s byte-offset
line reader) for the whole run, so each line of `transcript.log` and
`events.jsonl` is read and parsed exactly once no matter how long the
watch lasts, and a poll costs the bytes that landed since the last one
rather than the whole file. It still gets the task's *full* history back
every poll - `stateOf`, `isQuietTooLong` and the terminal notice are all
derived from the whole event list - the follower just doesn't re-read the
part it already has.

The record home comes from `FABRICA_HOME` for these too, and per this
module's layering rule they reach the record only through
`src/index.ts`'s re-exports (`readTranscript`, `followTask`,
`eventsByTask`, `stateOf`, and `foreman.events`), never `src/record`
directly.

## Why `bin.mjs` isn't a shebang'd `.ts` file

The obvious shebang, `#!/usr/bin/env -S node --import tsx/esm`, works
when you run the script from its own directory - and silently breaks
the moment `fabrica` runs from anywhere else, which is every directory
it's actually meant to run from once installed. Verified against the
real runtime, not assumed: `--import <specifier>` resolves a *bare*
specifier like `tsx/esm` relative to the process's current working
directory, not relative to the script that named it. Run `fabrica` from
`~/inkling-umbrella/spending-app` and Node goes looking for a `tsx`
package under *that* project's `node_modules`, finds nothing, and dies
with `ERR_MODULE_NOT_FOUND`.

`bin.mjs` sidesteps this by never asking `--import` to resolve anything.
It's plain JavaScript (nothing has taught Node to load `.ts` yet at this
point, so it can't be `.ts` itself), and its first line is a real
`import "tsx/esm"` - resolved by normal ES module resolution against
*this file's own location* (`import.meta.url`, which Node resolves to
the file's real path even when reached through the `npm link` symlink),
regardless of where the caller's shell happened to be sitting. Once that
import registers tsx's loader hooks, `main.ts` loads normally.

## Why nothing here ever `import()`s a raw filesystem path

The sibling sharp edge to the one above, and it has already bitten twice.
`import()` parses its argument as a **URL**, not as a path - so a path
containing a literal `#` or `?` is truncated at that character before
resolution, and the import fails on a file name that doesn't exist. It is
not hypothetical here: workers run out of generated worktree paths, which
can contain either character. Both places that load a module by a path
computed at runtime therefore convert it first with `node:url`'s
`pathToFileURL(p).href`, which percent-encodes those characters:

- `tsx-bootstrap.mjs`, importing the entry script it was handed
  (`spawn-detached.ts` builds that path with `fileURLToPath`, i.e. already
  decoded) - otherwise every `fabrica do` from such a checkout dies with
  `ERR_MODULE_NOT_FOUND` on the truncated path before the task ever starts.
- `verify-hook-command.ts`, importing the `skill/<harness>/verify.ts` it
  discovered - otherwise `fabrica verify-hook` reports no usable harness
  while one is sitting right there.

**This closes the bug for `#` completely, and for `?` only at the Node
level.** `pathToFileURL` fixes Node's own `import()`-parses-a-path-as-a-URL
truncation for both characters equally - proven end to end for `#`,
including against a real `.ts` file using genuine TypeScript syntax (a
type cast, matching `run-task-entry.ts`'s own shape). `?` looks fixed by
the same measure, but isn't: tsx's own TypeScript transform has a second,
separate bug that only survives for `#`. See the next section - it is why
this checkout's path can never contain a literal `?`, no matter what
`pathToFileURL` does.

## Why a checkout path can never contain a literal `?`

Not something this project can fix - a bug in tsx's own module resolution,
kept here in enough detail to file upstream. `pathToFileURL` correctly
percent-encodes a `?` before handing the URL to `import()`, so Node's own
resolution is fine with it. But tsx registers its own resolve hook ahead
of Node's default one (to transform `.ts` syntax on the fly), and that
hook independently re-derives a path from the URL - and for a `?`
specifically, it derives the wrong one. Observed directly against this
project's pinned tsx (`node_modules/tsx`, esbuild-backed): given an entry
whose real path is `.../worktree?7-dirty/inner/entry.ts`, tsx's transform
target resolves to a synthetic `.../worktree.js` - the `#` case has no
equivalent problem; the same shape of path with `#` instead of `?`
transforms correctly, cache path and all.

At that broken path, plain JavaScript loads by accident (nothing about it
needs the transform, so the bug never bites), but real TypeScript syntax
fails outright:

```
Error: Transform failed with 1 error:
/…/worktree.js:5:32: ERROR: Expected ")" but found "as"
    at failureErrorWithLog (…/node_modules/esbuild/lib/main.js:…)
```

(That specific line came from a fixture containing `(err as Error)` - any
TypeScript-only syntax triggers it the same way.) Since `run-task-entry.ts`
and `main.ts` are both real TypeScript, a checkout at a `?` path can't run
`fabrica` at all once tsx tries to load either one - not a `fabrica`
crash, a `tsx` one, and not something `pathToFileURL` or any other change
in this codebase can close. `bin.mjs` and `tsx-bootstrap.mjs` therefore
each check for a literal `?` in the relevant resolved path *before*
importing anything real, and refuse with a plain explanation instead of
letting tsx's own confusing transform error be the first thing anyone
sees - the same principle `src/containment/`'s comma-in-a-path check
applies to a path docker's `--mount` flag can't represent. Both refusals
are covered by tests that run the real file as a separate process and
assert on the refusal text, proven to fail against the pre-refusal
version. `#` is unaffected and still works.

## Why detached execution needs its own file

SPEC.md requires `fabrica do` to print the task id and return
immediately while the work continues in the background - but `doTask`
(what `createForeman(...).do()` calls) deliberately runs to completion
before resolving, so every contract test can `await` it and inspect the
delivery synchronously (`foreman/README.md`, "Why `do()` doesn't return
early"). Detachment has to be a property of *how this module calls
`do()`*, not of `do()` itself - and this module never reshapes it: the
library call inside the child process is exactly `foreman.do(taskText,
{ project, brain })`, same as any contract test makes.

**The mechanism** (`spawn-detached.ts`, verified against the real Node
runtime on this project's target OS - see the commit history for what
was actually tried): `child_process.spawn(..., { detached: true, stdio:
[...] })` followed by `child.unref()`. On POSIX, `detached: true` makes
the child the leader of a new session (`setsid`), which is what
disconnects it from the invoking terminal - a closed terminal sends
`SIGHUP` to its own session, and a process in a different session never
receives it. `unref()` is what lets the *parent* process exit without
Node waiting for the child.

**The hard part isn't backgrounding a process - it's learning the task
id without waiting for it to finish.** `doTask`'s very first act, before
any Worker runs, is `registerTask`: it claims
`<recordHome>/tasks/<id>/` and writes `request.md` verbatim
(`src/record/tasks.ts`) - synchronous, milliseconds, long before any
real work starts. `watch-for-task-id.ts` watches that directory from
outside (the same append-only record `fabrica status`/`log`/`watch`
read) for a new folder whose `request.md` matches the task
text just submitted, and resolves with its name. This is deliberately
an outside observer, not a change to `doTask` - it costs nothing at the
library layer and means detachment can be built, and later removed or
changed, without ever touching `src/foreman/do.ts`.

*Known v1 limitation:* two `fabrica do` invocations with byte-identical
task text, against the same record home, registered in the same narrow
window, aren't disambiguated - whichever matching directory this
observes first wins. Narrow enough in practice to accept rather than
invent a correlation mechanism, which would have to smuggle a marker
into `request.md` - and `request.md` is the Client's words, verbatim,
with nothing added (SPEC.md "The record").

**The child needs tsx taught to it all over again**, in a brand new
process that shares none of the parent's state - `tsx-bootstrap.mjs` is
`bin.mjs`'s trick (import `tsx/esm` relative to itself, never via
`--import`) generalized to take whichever entry script it's told to run
(`node tsx-bootstrap.mjs <entryScript> [...args]`), because the child
loads a different file (`run-task-entry.ts`) than `bin.mjs` does
(`main.ts`).

**The child's own stdout/stderr** are redirected to
`<recordHome>/cli.log` (append mode) rather than truly discarded. Ordinary
runs should never write anything there - `doTask` and the shipped adapter
communicate through the record and the transcript, not their own
process's stdio - but an unexpected crash in this process, as opposed to
a normal task failure (which is `do()`'s own concern, already visible
through the delivery), would otherwise vanish with no one watching.

## `run-task.ts` vs. `run-task-entry.ts`

Split the same way `src/foreman/do.ts` separates orchestration from
`src/foreman/foreman.ts`'s thin assembly. `run-task.ts` exports
`runTask(recordHome, projectPath, taskText, brain)` - a plain async
function, `brain` passed in rather than chosen inside it, so tests hand
it `fakeBrain()` (`src/brain/helpers/fake-brain.ts`) and prove the whole
wiring without a real coding agent. `run-task-entry.ts` is what the
detached child actually runs: thin, untested glue that reads
`process.argv`, calls `defaultBrainAdapter()` (the one real adapter v1
ships - CONTRACT rule 8 means nothing outside `src/brain/adapters/` may
*choose* which adapter, but wiring in "the default one" is fine), and
calls `runTask`.

## Files

| File | Holds |
| --- | --- |
| `bin.mjs` | The installed executable. Refuses a checkout path containing `?` before importing `main.ts` (see above), then two lines of real work. |
| `tsx-bootstrap.mjs` | What the detached child actually runs; loads an arbitrary entry script with tsx support taught to it fresh, via `pathToFileURL` - except a `?` in the entry's path, refused outright rather than attempted (see above). |
| `main.ts` | `fabrica <command> [args]` dispatch and top-level `--help`. A new subcommand adds one more branch here, the way `answer` (#8) and `status`/`log`/`watch` (#12) each did. |
| `help.ts` | Top-level help text and the list of known commands. |
| `do-args.ts` | Parses `fabrica do`'s arguments. |
| `do-command.ts` | Ties config, project resolution, the detached spawn, and the ask-outcome wait together for `fabrica do`; `DO_HELP` is `do --help`'s text. |
| `answer-args.ts` | Parses `fabrica answer`'s arguments. |
| `answer-command.ts` | Resolves the record home and calls `Foreman.answer` for `fabrica answer`; `ANSWER_HELP` is `answer --help`'s text. |
| `verdict-args.ts` | Parses `fabrica verdict`'s arguments. |
| `verdict-command.ts` | Resolves the record home and calls `Foreman.verdict` for `fabrica verdict`; `VERDICT_HELP` is `verdict --help`'s text. |
| `status-command.ts` | The whole of `fabrica status` - it takes no arguments, so `parseStatusArgs` (the refusal) lives here rather than in its own file; `STATUS_HELP` is `status --help`'s text. |
| `log-args.ts` | Parses `fabrica log`'s arguments (`<taskId>`, `--transcript`). |
| `log-command.ts` | Prints one task's event history, and its transcript with `--transcript`; `LOG_HELP` is `log --help`'s text. |
| `watch-args.ts` | Parses `fabrica watch`'s arguments (`<taskId>`). |
| `watch-command.ts` | The read-only poll loop behind `fabrica watch`, its terminal notices and its two exit-by-itself states (`closed`, and a `failed` task that never delivered), and the SIGINT handling that stops only the watching; `WATCH_HELP` is `watch --help`'s text. |
| `render.ts` | The one definition of every line `status`/`log`/`watch` print - including per-event-name prose and heartbeat-run collapsing (`summarizeHeartbeatRun`, shared by `log`'s history and `watch`'s catch-up) - plus `formatAge`, `formatTerminalNotice`, `isQuietTooLong`, `checkStartedAt`, `QUIET_THRESHOLD_MS`, and `CHECKING_QUIET_CEILING_MS`. |
| `delay.ts` | An abortable `setTimeout` for `watch`'s poll interval; removes its own abort listener each tick, so a long watch can't accumulate them on one signal. |
| `deny-and-log-edit-command.ts` | Reads a `PreToolUse` payload from stdin, denies it, and records `edit-attempt-blocked` - what a harness's session config runs, not something typed by hand (issue #13's prevention half; see that harness's own README under `skill/`). Deliberately the one command that does *not* refuse stray arguments: it promises to always deny and always exit 0 whatever it is handed, and a refusal would turn that fail-closed guarantee into a non-zero exit `PreToolUse` doesn't block on. |
| `verify-hook-command.ts` | `fabrica verify-hook`: proves a session config actually denies-and-logs by running a real attempt, instead of assuming it. Takes no arguments and refuses any it is given (`parseVerifyHookArgs`, the same convention as `parseStatusArgs`) rather than ignoring them. Loads its harness-specific spawn by scanning `skill/` at runtime (never a hardcoded import - see `AGENTS.md`'s rule 8 note), reporting a `verify.ts` that throws or exports only half a verifier by name instead of skipping it silently. |
| `record-home.ts` | `resolveRecordHome()` - `FABRICA_HOME` or `~/.fabrica`. |
| `resolve-project.ts` | `--project <path-or-name>` resolution. |
| `spawn-detached.ts` | The backgrounding mechanism and the id handshake. |
| `watch-for-task-id.ts` | The filesystem watch that learns a new task's id without `doTask` reporting it. |
| `wait-for-ask-outcome.ts` | Polls a task's own record (issue #8) for `"questions-asked"`, `"ask-failed"`, or `"work-started"`, bounded, so `fabrica do` knows whether the task asked, failed before it started, or is proceeding. |
| `run-task.ts` | The one call the detached child makes - pure, brain passed in, unit-tested directly. |
| `run-task-entry.ts` | The detached child's real entry point: picks the default adapter, calls `run-task.ts`. |
| `errors.ts` | `CliError`, with codes `bad-usage`, `unknown-command`, `unknown-task`, `project-not-found`, `spawn-failed`, `registration-timeout`. |
| `helpers/fake-run-task-entry.ts` | Test-only stand-in for `run-task-entry.ts`, using `fakeBrain()` instead of the real adapter - lets `spawn-detached.test.ts` and `do-command.test.ts` exercise the real spawn-and-discover mechanism as a real separate process, without ever invoking a real coding agent. A taskText containing `ASK_ME_SOMETHING` makes its fake brain ask a clarifying question (issue #8) instead of proceeding, and one containing `ASK_FAILS_SOMETHING` makes its `ask()` throw, since there's no other channel to configure a fake running in a separate process. |
