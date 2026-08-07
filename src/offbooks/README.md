# The off-the-books net (detection half)

`src/offbooks/` is the detection net from SPEC.md's "Catching off-the-books work" (issue #13): on every `fabrica` command, it checks each registered project for changes no task explains and, when it finds one, appends an `unattributed-change` event (`contract/surface.ts`'s `FabricaEventName`) to the record. This is a courtesy, never a gate — see `check.ts`'s comment. The prevention half (a per-harness session config that disables file editing, plus a blocked-edit-attempt hook) lives under `skill/` at the repo root; this module is detection only.

## What "explained" means here

CONTRACT rule 1 ("it never touches your stuff") means Fabrica itself never writes to a registered project's own checkout — only to a disposable ProductionLine worktree. So from this net's point of view, **any** tracked-content change it observes in a registered project's checkout came from outside Fabrica: the Client's own hand, or an agent editing directly instead of going through a task. This net does not try to guess which — it isn't trying to adjudicate intent, only to make sure nothing that touched the checkout goes unrecorded (the issue's own framing: this must catch *both* "an agent editing outside a task" *and* "the Client editing by hand and forgetting").

The actual design problem, then, isn't attribution — it's **noise**. A working checkout looks different between two commands for lots of ordinary reasons that have nothing to do with either failure mode, and firing on those trains the Client to ignore the event exactly when a real one shows up. So the net is built around one baseline per registered project (`recordHome/offbooks/<project>.json`, one small JSON file, readable with bare hands like everything else under the record home) and three deliberate quiet rules:

1. **Ignored files never reach the comparison at all.** `readProjectGitState` (`git-state.ts`) uses plain `git status --porcelain=v1`, which already excludes anything matched by `.gitignore` (repo-level or the Client's own global excludes file) while still reporting both modified-tracked files and untracked-but-not-ignored ones. Build artifacts and the bulk of a `node_modules`/`vendor` dependency install fall out here for free, because that's what a normal `.gitignore` is for — this net doesn't special-case "looks like a lockfile" or "looks like a build dir"; it trusts the same ignore rules the Client's own `git add -A` would.
2. **A branch switch resets the baseline instead of comparing across it.** ("A branch the Client is using himself" — the issue's own example.) If the current branch differs from the one the last check saw, `detect.ts` just re-baselines to the new branch's current state and stays quiet. The tradeoff: a change made *during* a single visit to a branch the net never revisits is missed. Accepted deliberately — see "What this net still misses," below.
3. **A real change fires exactly once, then becomes the new baseline.** Otherwise every later command would re-report the same still-uncommitted edit forever, which is its own kind of noise.

Everything else — a tracked file edited, a new non-ignored file created, or a commit landing with nothing left dirty (an agent that edits *and* commits, leaving a clean working tree) — fires. `filesChangedBetween` (`git-state.ts`) diffs the old and new `HEAD` to name the files even when the working tree shows nothing dirty.

## Deliberately not special-cased

**Manifest/lockfile changes** (`package-lock.json` and the like) are not exempted. The issue lists "a dependency install" as an example of innocent noise, but in practice that noise is `node_modules/`'s content — already gitignored in virtually every real project, so rule 1 above already keeps it quiet. A lockfile itself changing is a real, tracked-content change, and it's exactly the shape of thing an off-books `npm install <package>` would produce — worth recording, not worth a carve-out. `detect.test.ts` proves this is the actual, deliberate behavior, not an oversight.

**A Client merging a Fabrica-delivered branch (`fabrica/<taskId>`) into his own working branch by hand** also fires. It's tempting to exempt this — the files came from a task that's fully on the record, delivery and verdict included — but this net compares a project's checkout across commands, not against Fabrica's own task history, and doing the latter would mean walking merge ancestry against every `fabrica/<id>` branch on every check, for a benefit (silencing a merge the Client just did on purpose, and therefore isn't going to forget) that's smaller than the cost and complexity of getting that walk right. `check.test.ts` documents this as an accepted, deliberate tradeoff rather than a bug.

## What this net still misses

Named here rather than hidden, per the issue's own instruction to defend the definition:

- **A change made and reverted between two checks on a branch the net never revisited in between.** The branch-switch reset (`quiet rule 2` above) means only the branch's state *when last observed* is remembered.
- **An editor scratch file not covered by any active `.gitignore`** (repo-level or global). Most real setups have one; a repo or machine that doesn't will see this net treat that file like any other untracked, non-ignored change — which is arguably correct (it's still an unrecorded write nobody explained), just noisier than intended.
- **Non-git projects.** `readProjectGitState` returns `null` for anything that isn't a usable git working tree, and the net stays silent rather than guessing at a non-git diff mechanism. Fabrica requires git for ProductionLines anyway (`src/line/`), so every registered project already has one.

All three are "misses quiet" failures, not "fires loud" ones — consistent with the issue's own preference: "a definition that is quiet and occasionally misses something over one that is loud."

## No model anywhere in this module

Every decision above — ignored vs. not, same branch vs. switched, changed vs. unchanged — is a plain comparison of git's own output, resolved once by `git status`/`git rev-parse`/`git diff` and adjudicated by ordinary code. Nothing here asks an AI to judge whether a change "looks innocent." CONTRACT rule 3 makes the same call for counting retries ("Counting is done by the Foreman... never by asking an AI to decide"); this module applies the identical reasoning to classification.
