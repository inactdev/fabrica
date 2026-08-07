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
5. **Waits, bounded, to see whether the task asks or proceeds**
   (`wait-for-ask-outcome.ts`, issue #8): the detached process is still
   running `doTask` (`src/foreman/do.ts`), which now does register ->
   ask -> maybe isolate/work in one call (SPEC.md step 2, "Clarify-or-
   proceed" - see `src/foreman/README.md`'s "The ask-first seam"). This
   polls that task's own record for whichever of `"questions-asked"` or
   `"work-started"` lands first:
   - **Materially ambiguous** → prints the task id, then the numbered
     questions and how to answer them (`fabrica answer <id> -m "<text>"`),
     and stops. No Worker ever ran; nothing keeps running in the
     background for this task until answered.
   - **Otherwise, or if the wait times out** → prints just the task id,
     exactly as before issue #8. This process then exits; the task keeps
     running in the background. See "Why detached execution needs its
     own file" below for the spawn mechanism.

   The wait is bounded, not indefinite, on purpose: `ask()` is a real
   call to whichever brain is wired in, and a slow or already-failed
   call (e.g. a missing check command, which fails before ever reaching
   `"work-started"`) must never hang the terminal - timing out just falls
   back to printing the id, the same as if this step didn't exist. The
   task itself is never affected by what this observes; it keeps running
   (or having already stopped) regardless.

A refusal at steps 1-3 exits non-zero with the message on stderr - safe
to use in a script (`id=$(fabrica do "..." --project foo) || exit 1`).
Once step 4 starts, this process's own exit code no longer reflects the
task's eventual outcome for the "proceeds" case, which is the nature of
detachment: by design, nothing is left waiting around to report delivery
or failure here (see `fabrica status`/`log`/`watch`, issue #12 - not
built yet). The "asks" case is the one exception: this process already
knows and reports that outcome directly, since nothing was ever spawned
to detach from.

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
file: a second `fabrica answer` on the same task refuses with
`ForemanError("already-answered")`.

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
outside (the same append-only record any future `fabrica status`/`log`/
`watch` will read) for a new folder whose `request.md` matches the task
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
| `bin.mjs` | The installed executable. Two lines of real work - see above. |
| `tsx-bootstrap.mjs` | What the detached child actually runs; loads an arbitrary entry script with tsx support taught to it fresh. |
| `main.ts` | `fabrica <command> [args]` dispatch and top-level `--help`. A new subcommand (#12: status/log/watch) adds one more branch here, the way #8's `answer` did. |
| `help.ts` | Top-level help text and the list of known commands. |
| `do-args.ts` | Parses `fabrica do`'s arguments. |
| `do-command.ts` | Ties config, project resolution, the detached spawn, and the ask-outcome wait together for `fabrica do`; `DO_HELP` is `do --help`'s text. |
| `answer-args.ts` | Parses `fabrica answer`'s arguments. |
| `answer-command.ts` | Resolves the record home and calls `Foreman.answer` for `fabrica answer`; `ANSWER_HELP` is `answer --help`'s text. |
| `verdict-args.ts` | Parses `fabrica verdict`'s arguments. |
| `verdict-command.ts` | Resolves the record home and calls `Foreman.verdict` for `fabrica verdict`; `VERDICT_HELP` is `verdict --help`'s text. |
| `record-home.ts` | `resolveRecordHome()` - `FABRICA_HOME` or `~/.fabrica`. |
| `resolve-project.ts` | `--project <path-or-name>` resolution. |
| `spawn-detached.ts` | The backgrounding mechanism and the id handshake. |
| `watch-for-task-id.ts` | The filesystem watch that learns a new task's id without `doTask` reporting it. |
| `wait-for-ask-outcome.ts` | Polls a task's own record (issue #8) for `"questions-asked"` or `"work-started"`, bounded, so `fabrica do` knows whether to print questions and stop or just the id. |
| `run-task.ts` | The one call the detached child makes - pure, brain passed in, unit-tested directly. |
| `run-task-entry.ts` | The detached child's real entry point: picks the default adapter, calls `run-task.ts`. |
| `errors.ts` | `CliError`, with codes `bad-usage`, `unknown-command`, `project-not-found`, `spawn-failed`, `registration-timeout`. |
| `helpers/fake-run-task-entry.ts` | Test-only stand-in for `run-task-entry.ts`, using `fakeBrain()` instead of the real adapter - lets `spawn-detached.test.ts` and `do-command.test.ts` exercise the real spawn-and-discover mechanism as a real separate process, without ever invoking a real coding agent. A taskText containing `ASK_ME_SOMETHING` makes its fake brain ask a clarifying question (issue #8) instead of proceeding, since there's no other channel to configure a fake running in a separate process. |
