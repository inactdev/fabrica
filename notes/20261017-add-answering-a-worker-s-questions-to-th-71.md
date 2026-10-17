# Answering a worker's questions from the live view's /review page

## What this added

`POST /api/review/tasks/<id>/answer` (`integrations/live-view/server.ts`)
— the live view's second write, alongside issue #202's verdict route.
Same `Tailscale-User-Login` gate (403 without it, checked before the
body is read), same "record in the foreground, run the round detached"
split, calling the exact `recordAnswerDecision` +
`spawnDetachedResume({ kind: "answer" })` pair `src/cli/answer-command.ts`
calls. `getReviewRows` grew a fourth row kind, `"asking"`, carrying the
worker's own questions off the latest `"questions-asked"` event.

## The durable facts worth keeping

- **The review page's row set is now wider than "awaiting a verdict."**
  `state-agreement.test.ts`'s premise used to be that
  `getReviewRows` lists exactly the tasks `fabrica status` flags with
  `AWAITING YOUR VERDICT`/`` `wrong` closes it ``. An asking row has
  neither: `src/cli/render.ts`'s `formatStatusLine` has never given the
  "asking" state a waiting-on-you marker — only `fabrica await` does
  ("answer with fabrica answer `<id>`"). So the asking fixture's
  agreement is asserted against `await`'s notice plus the recorded
  questions themselves. Anyone adding a fifth row kind has to decide the
  same thing: which existing surface is this kind's ground truth?
- **Nothing new on `src/index.ts`.** Everything this route needed was
  already exported — `recordAnswerDecision` since issue #123 — and the
  questions come from events the page's follower cache already reads.
  The CLI-layer imports (`loadConfigOrDefault`, `spawnDetachedResume`)
  were already in this file for the verdict route.
- **One answer box per task, not one per question.** `fabrica answer`
  takes a single `-m "<text>"` per clarification round and
  `renderAnswerRound` files it against the whole numbered list, so the
  page numbers the questions for reading only and posts one string. A
  per-question UI would have to invent a joining format the record has
  no notion of.
- **The JSON body cap applies to answers too.** `readJsonBody`'s 8 KiB
  ceiling was written for a one-line verdict note; a typed answer is
  well inside it, but a pasted essay would be refused with "request body
  too large" rather than truncated. Raise the cap, don't trim the text,
  if that ever bites.

## Sharp edge: this box could not run `npm test` as written

The worker box had no `node_modules` and no npm registry access
(`403 Forbidden` on every fetch, `tsc` and `tsx` both absent). The suite
was run instead with Node 24's own type stripping
(`node --test $(find contract src integrations -name '*.test.ts')`) plus
local stand-ins for the two missing packages — a minimal `smol-toml`
parser and a `tsx/esm` no-op (Node strips types natively, so the
bootstrap's loader has nothing left to do) — created under
`node_modules/` (gitignored) and **deleted again** before finishing.
Result: 1002 pass, 0 fail, 51 skipped (the Docker-gated tests;
`docker info` is unavailable here, which `.github/workflows/docker-tests.yml`
exists to cover). `npm run typecheck` could not be run at all — no
TypeScript install is reachable from this box — so the types in this
change are reviewed by hand only.

Two cautions for the next agent tempted to do the same: `check.sh` skips
`npm ci` whenever `node_modules` exists (`[ -d node_modules ] || npm ci`),
so a half-populated `node_modules` left behind would make the real check
run against stub packages and fail confusingly — remove it. And a stub
TOML parser silently changes what `src/config`/`src/register`'s own
tests prove; those four tests pass here only because the stub was
extended (escapes, `inf`/`nan`, datetimes, null-prototype tables) until
they did, which is evidence about the stub, not about real smol-toml.
