# Issue #353: a `fix` verdict when the warm worker is gone

## The plan, and the alternative rejected before writing any of it

Issue #353 is four written expectations, not one bug, so each got its own
narrow change. Safest first, then most accurate, then fastest:

1. **A warm worker that cannot be resumed is restarted cold, inside the
   same attempt** (the Client's clarification: "start a fresh worker with
   the task's history and the note"). An allowlist classifier decides
   whether a failed `work()` call failed *because the session is gone*,
   and only then is the call made once more with no session at all. The
   restart lands on the record as its own event.
2. **Every verdict attempt that fails records why**, as a
   `"verdict-failed"` event on the task's own log, with the real error.
3. **A fix round's host-side rebase that fails says plainly that the
   branch was left exactly as it was**, rather than only quoting git.
4. **An exit code nobody could read always names its process** and says a
   signal ended it, instead of rendering the literal `null`.

**Rejected: making the reference adapter drop `--resume` by itself**
whenever the session cannot be resumed. It is fewer lines and needs no
event, and that is exactly the problem - the Client paid for a warm
worker and silently got a cold one, with nothing on the record to say so,
and the behaviour would exist only in whichever adapter happened to
implement it. Deciding whether a failed model call is worth making again
is the Foreman's policy, which `src/foreman/transport-retry.ts` already
settled for the identical shape of problem (issue #199) - this follows
it rather than inventing a second home for the same decision.

**Rejected: refusing the ruling when the session is gone** (option 2 on
the issue's own clarification). The Client chose the fresh worker.

## Why a cold restart loses nothing

`src/foreman/verdict.ts`'s `buildFixBrief` already composes the task's
*original* brief - the request, the issue's own words, the attached
files, the project's knowledge notes - with the Client's note, on every
pass of every fix round. The warm session was never the only copy of the
task's history; it was an optimisation on top of a brief that already
carried it, and the branch carries every prior round's commits besides.
So a cold restart is a worker with the same brief and the same tree,
minus the previous round's conversation. That is worth saying out loud,
because it is the whole reason the fresh-worker option is cheap here and
would not be in a design where the brief were only the note.

## `warm-worker.ts` is an allowlist, like `transport-retry.ts`

`sessionGoneReason(err)` recognises only wordings that mean "the session
named by `--resume` is not there": no conversation/session with that id,
an unknown or expired session, a session file that cannot be read. An
error it does not recognise is NOT a dead session and fails at once. The
asymmetry points the same way it does for transport retries: a wording
wrongly left out costs one honest failure the Client can re-rule on,
while a wording wrongly let in re-runs a whole worker call cold - real
money, and a worker that throws away context it still had.

Ordering matters and is deliberate: the cold-start fallback wraps
`withTransportRetry`, not the other way round. A dropped connection is
retried *warm* first (nothing about the session is wrong), and only a
genuine session refusal falls back to cold. A cold restart is never
retried a second time.

## Two event names, and why they are not in the contract

`"verdict-failed"` and `"warm-worker-restarted"` are declared in
`src/inspector/types.ts`'s widening of `FabricaEventName`, not in
`contract/surface.ts`. Both are Fabrica's own bookkeeping rather than a
new promise about a seam, and the contract is a path `rule9-gate.yml`
protects - the same reasoning the file's own comment already gives for
`stopped-by-owner`, `transport-retry` and `meter-refused`.

Neither moves `stateOf`: it has a `default: break;`, so a task that was
`"delivered"` and awaiting a verdict still reads that way after a failed
ruling. That is the point - a ruling that never took effect must not make
the task look ruled on, closed, or failed.

## What a null exit code used to look like

`src/containment/run.ts` read docker's exit code off `child.on("close")`
and dropped the signal argument, so a worker box killed by a signal came
back as `exitCode: null` and was rendered into an adapter's error as the
literal string `exit code null`, naming no process. `describeExit`
(`src/containment/exit-code.ts`) is the one renderer for all of it now,
and `runContained` carries the signal through.

## The error in the report could not be attributed to anything here

The issue quotes `error: Can't read exit code from process. Maybe the
process was killed using a signal?`. That exact string is in neither this
repository nor any installed dependency (grepped both, `npm ci` first),
and a web search for it turns up no tool emitting it - the closest match
is an unrelated bug report about the same *shape* of problem in a
different runtime. It is also not a wording any Fabrica error produces:
every foreground step of `fabrica verdict <id> fix` is a record read, a
config read and two record writes, and none of them spawns a process. So
it most likely came from whatever ran `fabrica`, not from `fabrica`.

That did not block the work - the issue's four Expected items are each a
real gap in this repository, found and fixed on their own merits - but it
does mean **requirement 4 was read as "wherever Fabrica reports an exit
code it could not read, name the process", not as a fix to one specific
message**. If the string turns up again, the thing to establish next is
which program printed it; `<recordHome>/cli.log` is where a detached
round's own output goes, and `fabrica log <id>` now carries a
`"verdict-failed"` event for the foreground half.

## The same shape elsewhere, and the one deliberately left standing

`describeExit` is now used everywhere a possibly-null exit code reaches a
sentence: both reference CLI adapter calls, the OpenAI-compatible
worker's result line, the diff reader's two failures, the adapter's
doctor check, and `fabrica up`'s `open -a Docker` (where `spawnSync`'s
30-second timeout really does produce a null status and a SIGTERM).

**Left standing, on purpose:** `src/brain/check-box.ts`'s
`BoxCheckResult.exitCode` is a non-null `number`, because the reference
adapter's check box collapses a signalled run to `exitCode ?? -1`. So
`src/foreman/judge.ts`'s `${check} -> exit ${result.exitCode}` and
`src/register/register.ts`'s `(exit ${result.exitCode})` can print `-1`
for a check killed by a signal - misleading, but not `null`, and both
already name the command. Closing it properly means widening
`BoxCheckResult` to carry a signal, which touches both of those plus the
adapter, `src/register/tools.ts` and two fakes - a wider seam change for
a message rather than a bug, so it is written down here instead of done.
