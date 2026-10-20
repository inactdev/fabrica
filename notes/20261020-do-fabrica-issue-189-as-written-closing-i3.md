# The two subscription meters: where they actually live (issue #189)

Issue #189 asked for every receipt to record "the two subscription
meters Claude Code reports, the 5-hour and 7-day used percentages, read
from the CLI's own output the way the Client's status line reads
`rate_limits.five_hour.used_percentage`", and said: if the CLI's
non-interactive output does not carry those numbers, find where it does
and say so rather than estimating.

It does not. Here is what was checked, and where the numbers really are.

## The CLI's non-interactive output carries neither number

Run for real against the installed binary (2.1.222) in a worker box:

```
claude -p "Reply with exactly: ok" --output-format stream-json --verbose
```

emitted exactly three lines - `system`/`init`, `assistant`, and the
terminal `result` - and none of them carries a rate-limit field of any
kind. The `result` line carries `total_cost_usd`, `usage`, `modelUsage`,
`session_id`, `duration_ms`, `permission_denials`; that is all the
adapter has ever had to read, and it is all there is.

There IS a `rate_limit_event` stream-json line type (this project's own
adapter already drops it as harness chatter), but two facts rule it out
as the source:

- it never appeared in a real `-p` run, and
- its payload is one window at a time, not both: the embedded schema is
  `{ type: "rate_limit_event", rate_limit_info: { status, resetsAt?,
  rateLimitType?: "five_hour" | "seven_day" | ..., utilization?, ... } }`,
  "emitted when rate limit info changes". One `rateLimitType` and one
  `utilization` per event - whichever claim is representative at that
  moment - so even where it is emitted it cannot report both meters.

## Where the numbers do live: the provider's response headers

The status line's `rate_limits.five_hour.used_percentage` is not read
from any output stream. The CLI builds it in-process from the HTTP
response headers of every API call, keeps the latest in a module-level
store, and renders `used_percentage = utilization * 100`.

The headers themselves, read live through Fabrica's own relay (the
worker box's traffic already passes through it, so it already sees them):

```
anthropic-ratelimit-unified-5h-utilization: 0.07
anthropic-ratelimit-unified-5h-reset: 1792515000
anthropic-ratelimit-unified-5h-status: allowed
anthropic-ratelimit-unified-7d-utilization: 0.64
anthropic-ratelimit-unified-7d-reset: 1792566000
anthropic-ratelimit-unified-7d-status: allowed
anthropic-ratelimit-unified-representative-claim: five_hour
```

`utilization` is a fraction of 1, which is why the CLI multiplies by
100: `0.64` is 64% of the week. So the numbers Fabrica records are the
same numbers the Client's status line shows, from the same source,
one step earlier in the path - not an estimate and not a second
derivation of anything.

This is also why the relay is the right reader: it is the only
host-side component that sees the provider's responses at all, it is
already in the path for every attempt, and reading two header values
costs nothing (no extra API call, no interactive session, no polling
some other endpoint to ask "how much is left").

## Rejected alternatives

- **Parse the CLI's own output** - the thing the issue asked for first.
  Not possible: see above.
- **Shell out to a second `claude` invocation per attempt purely to
  read the meters.** That makes a reading a billable API call of its
  own, and the numbers still only reach an interactive status line.
- **Add a `"paused"` member to `FabricaTask["state"]`.** A paused round
  is waiting on the Client's `fix` verdict, which is exactly what the
  existing `"delivered"` state means; a new state would have to be
  threaded through `stateOf`, `fabrica status`, `fabrica await`,
  `src/foreman/stop.ts`'s running-states set, the live view's own state
  labels and the state-agreement test, for no fact that
  `"delivered"` plus the delivery's own outcome does not already carry.
  The pause reason is shown on the status line instead.
- **Change `contract/surface.ts`.** The two new receipt fields and the
  new `"paused-by-meter"` outcome are widened in
  `src/inspector/types.ts` instead - the file this project already
  designates as "the one place that widening happens", and which
  already widens `Delivery["outcome"]`, `FabricaTask["state"]` and
  `FabricaEventName` for exactly this reason (the contract is a
  CI-protected path, and none of this is a new promise about a seam).

## Rule 8 and the header names

`contract/rule8.no-favorite-brain.test.ts` fails on the word
"anthropic" anywhere under `src/` outside `adapters/`, so the header
names can only be named in `src/brain/adapters/claude-code.ts`. The
relay therefore observes *caller-named* response headers
(`RelayOptions.observedResponseHeaders`) and reports their raw values;
converting `0.64` to 64 is the adapter's job too, since the 0..1
convention is the provider's, not Fabrica's. Everything host-side of
that speaks only of a 5-hour and a 7-day percentage.

## The pause rule

`[pause]` in projects.toml, defaults `sevenDayRefusePercent = 70`,
`sevenDayStopPercent = 90`, `fiveHourRefusePercent = 90`. The 7-day
meter refuses new starts at 70 and stops in-flight work at 90; the
5-hour meter refuses new starts at 90 and never stops in-flight work,
since it resets within hours (Client's clarification). Fails open: a
reading that is missing, unparseable or older than
`METER_READING_MAX_AGE_MS` (one hour) is unknown, warns on stderr, and
refuses nothing. The dollar caps are untouched and still bind on
metered spend only. `src/foreman/README.md`'s "The pause rule" owns the
semantics from here on; this file is only the where-do-the-numbers-come-
from record.

A reading reaches the host within about a second of an API response
(the relay's log watcher's own interval), so the in-flight stop at 90
really is mid-attempt, not only at attempt boundaries - which is what
the Client's fifth clarification asked to have reported either way.

## Two things worth knowing before changing this

- **A reading is never 0 by accident.** `Number("")` is `0`, so an
  empty header value would have read as a completely empty quota - the
  exact opposite of "the provider sent nothing readable". Every
  conversion checks for that before converting
  (`percentFromUtilization`), and `null` means "nobody knows"
  everywhere downstream.
- **The word "claude" cannot appear in `src/` outside `adapters/`** -
  including in a README under `src/`, which `contract/rule8`'s scan
  reads like any other file. Writing "see `adapters/claude-code.md`" in
  `src/brain/README.md` fails the suite; "the reference CLI adapter's
  own document under `adapters/`" is the way to say it.
