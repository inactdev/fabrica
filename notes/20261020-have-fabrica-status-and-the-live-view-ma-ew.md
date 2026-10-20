# "behind origin/<branch>, a fix will rebase" on a delivered task

Task: have `fabrica status` and the live view mark a delivered task whose
branch no longer contains origin's default tip as "behind
origin/<branch>, a fix will rebase", from a host-side git check that
writes nothing. Client's clarifications: local refs only; resolve the
default branch from `origin/HEAD`'s symref, never assumed; label only
(the rebase it promises is issue #235's existing fix-round rebase); a
distinct `base unknown: <reason>` marker when the check can't answer,
never a silent fallback; the label may say how old the last fetch is.

## The design, and the alternatives rejected before starting

Chosen: one read-only git query, `src/foreman/base-standing.ts`'s
`baseStandingOf(project, branch, now)`, plus one label renderer,
`describeBaseStanding`, both exported from `src/index.ts` so
`fabrica status` and the live view render the identical string and
cannot drift. Four local reads, no network, no refs written:
`git symbolic-ref --short refs/remotes/origin/HEAD` (origin's default
branch), `git rev-parse --verify` on `refs/remotes/origin/<base>` and
`refs/heads/<branch>`, `git merge-base --is-ancestor` between them, and
`stat` on the path `git rev-parse --git-path FETCH_HEAD` names for the
freshness clause.

Safest first: every call is a read. The marker is a report, so it must
not be able to change what it reports on, and a delivered task's branch
is history a reviewer has already looked at.

Rejected alternatives:

1. **Fetch first, then compare.** The most *accurate* answer - origin's
   real tip rather than the last fetched one - and rejected anyway: a
   fetch writes the project's remote-tracking refs (and `FETCH_HEAD`)
   from a command the Client reads 20 times an hour, costs network on
   every poll of a 2Hz page, and turns a reporting surface into one that
   mutates his repository. The Client ruled local-only for exactly this
   reason, and `src/line/cut.ts`/`rebase.ts` already fetch at the two
   moments that matter (cutting a line, and every fix round), so the
   marker is never more stale than the work it describes. The label names
   the fetch's age so the reading is never presented as fresher than it
   is.
2. **Resolve the default branch the way `cut.ts` does**
   (`git ls-remote --symref origin HEAD`). Same objection: it is a
   network call per delivered task per poll. The local
   `refs/remotes/origin/HEAD` symref is the same fact written down -
   verified on git 2.54.0 that `git clone` sets it and that
   `git fetch origin` sets it when it is missing - so Fabrica's own
   fetches keep it populated, and when it genuinely isn't set the marker
   says `base unknown: ...` instead of guessing "master".
3. **Record the standing as an event when the task delivers**, so both
   surfaces only read the record. Rejected: it answers a different
   question. "Was the branch behind at delivery time?" goes stale the
   moment someone else merges, which is precisely the case this marker
   exists to catch; and it would mean writing to the record from a read
   path.

## Durable facts worth keeping

- `refs/remotes/origin/HEAD` is a real local symref, not a guess:
  verified on git 2.54.0 that `git clone` writes it and that
  `git fetch origin` writes it when absent (it is left alone when
  already set, so `git remote set-head origin -a` is the fix for a
  checkout whose remote default has since moved). `git symbolic-ref
  --short refs/remotes/origin/HEAD` is the local-only answer to "which
  branch does origin call default" - the counterpart to `cut.ts`'s
  network `git ls-remote --symref origin HEAD`.
- `git fetch` rewrites `FETCH_HEAD` on every run, even when nothing
  changed (verified: its mtime advances on a second fetch with no new
  commits upstream), so that file's mtime is the only local record of
  "when did this checkout last fetch". Ask git for its path
  (`git rev-parse --git-path FETCH_HEAD`) rather than assuming
  `.git/FETCH_HEAD`: from a *linked* worktree the per-worktree path is
  returned instead, and `src/line`'s own fetches all run in the
  project's main checkout.
- `git merge-base --is-ancestor` reports its answer as an exit status -
  0 contains, 1 behind - so a caller must tell exit 1 apart from a real
  failure (`err.status === 1`) or every broken repository reads as
  "behind".
- `formatAge` moved from `src/cli/render.ts` to `src/foreman/age.ts`
  (re-exported from both `src/index.ts` and `render.ts`, so every
  existing import still resolves): a label shared by the CLI and the
  live view cannot live under `src/cli/`, which the live view never
  imports from.
- The live view caches base standings for 15s per project+branch
  (`BASE_STANDING_CACHE_MS`): its pages poll at 2Hz, and these facts can
  only change when something fetches or commits. `fabrica status` is
  one-shot and caches nothing.
