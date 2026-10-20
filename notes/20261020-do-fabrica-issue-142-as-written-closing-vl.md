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

## `registeredProject` had two copies and now has one

`resolve-check.ts` and `network-policy.ts` each carried their own
"which projects.toml entry is this path" lookup. The second one moved to
`src/foreman/registered-project.ts` and is shared with
`touched-tests.ts`. `resolve-check.ts`'s copy is deliberately still its
own: it rethrows a malformed-config `ConfigError` instead of answering
"unregistered", because it runs first in every round and is where that
error should surface loudly. A setting with a sane default must never be
the thing that reports a broken registry.
