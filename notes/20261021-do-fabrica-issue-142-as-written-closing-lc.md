# A per-project setting that reaches the worker's brief (issue #142)

The first project setting whose whole job is to change what a Worker is
*told*, rather than what it may reach or which command checks it. Two
things about how that landed are worth keeping.

## There is now exactly one place a worker's brief is built

Before this, three files each called `withStandingQuestion` themselves:
`do.ts`'s round (via `attempts.ts`), `answer.ts`'s resumed round, and
`verdict.ts`'s fix round. That was fine while the prefix was a constant.
The moment any part of it became conditional, three independent
resolutions of the same condition were three places to get it wrong —
and the failure mode is silent, since a brief missing a line still
works.

`src/foreman/touched-tests.ts`'s `workerBrief(recordHome, projectPath,
briefText)` is now the single funnel: `do.ts`'s `productionRound` calls
it for both the first and the resumed round (`answer.ts` hands over the
task's own words and no longer prefixes anything), and `verdict.ts`
calls it for the fix round, where `buildFixBrief` now returns only that
round's own words. Add a conditional line to a brief by giving
`withStandingQuestion` an option and resolving it in `touched-tests.ts`
— not by prefixing at a fourth call site.

That funnel sits *outside* each round's own brief builder, not inside
it: `verdict.ts`'s fix round calls `workerBrief(...)` around
`buildFixBrief(...)`, and `buildFixBrief`'s `extra` parameter is where
that round's situational parts go — an Inspector refusal's reason, a
rebase conflict's instructions, joined when both apply. Keeping the two
layers separate is what makes them composable: a new situational part is
added to the join, and a new standing notice is added to
`touched-tests.ts`, and neither has to know about the other. Both have
now been edited in the same expression by separate tasks, so expect this
spot to conflict; resolve it by keeping the join intact and the wrapper
around it, never by flattening one into the other.

`attempts.ts` still re-applies `withStandingQuestion` to its correction
brief. That stays a no-op by construction: the doubling guard keys on
the fixed `STANDING_PREFIX`, and every conditional notice is appended
*after* it, so an already-prefixed brief comes back byte-identical
whatever the re-application asks for. Keep new conditional notices after
the fixed prefix for that reason.

## A `ProjectConfig` default belongs in the loader, not in its readers

`onlyTouchedTests` is declared **required** on `ProjectConfig` and
filled in by `src/config/load.ts` for every entry that omits it. That
is what makes "existing entries get the default" true at the one point
it can be true for every reader at once, and the compiler then refuses
any hand-built `FabricaConfig` that forgets it. A reader's own `??
true` would have had to be repeated at each reader and would quietly
disagree the first time one was missed. The only `?? true` left is in
`onlyTouchedTestsFor`, and it means a genuinely different thing:
*unregistered* project, not *unset* field.

## Every new project setting touches the same two lines

`parseProject` (`src/config/load.ts`) names each recognized field twice —
once in its destructure, once in the "Only path, check, ... are
recognized" message — and `ProjectConfig` (`src/config/types.ts`) adds
the field at the end of the interface. Three one-line additions at three
fixed spots, which is why two tasks adding a setting in parallel conflict
on all three, every time (this one did, against `[projects.<name>.reviewer]`).
They are *additions*, never alternatives: resolve by keeping both fields
in the destructure, naming both in the message, and emitting both blocks
in the interface. Taking either side wholesale silently deletes the
other's setting — and the loader's own "unknown field(s)" refusal then
turns that into a malformed-config error for anyone whose `projects.toml`
still carries it.

## `registeredProject` had two copies and now has one

`resolve-check.ts` and `network-policy.ts` each carried their own
"which projects.toml entry is this path" lookup. The second one moved to
`src/foreman/registered-project.ts` and is shared with
`touched-tests.ts`. `resolve-check.ts`'s copy is deliberately still its
own: it rethrows a malformed-config `ConfigError` instead of answering
"unregistered", because it runs first in every round and is where that
error should surface loudly. A setting with a sane default must never be
the thing that reports a broken registry.

## An Inspector binary older than a flag Fabrica passes refuses, it does not fail red

Unrelated to this change, learned while landing it, and worth knowing
before anyone chases a phantom bug in their own branch. The flags
Fabrica passes Inspector are ratified in
`src/inspector/consumer-contract.json`; when the *installed* Inspector
predates one of them, Go's flag package rejects the whole invocation
(`flag provided but not defined: -<name>`, then its usage text) and the
round comes back as a **refusal** — no verdict, nothing about the work
judged, the branch untouched.

Read that shape carefully: the refusal quotes an error about a flag, so
it reads like something in the tree is wrong, but the only fix is on the
machine — update the installed Inspector. Removing the flag from
Fabrica's call to make the refusal stop would be exactly backwards: that
file is Fabrica's ratified side of the contract and syncs to Inspector's
own test data, so matching an old binary breaks the real agreement.
