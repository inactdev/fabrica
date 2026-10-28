# The publish token's granted permissions are checked before a task runs (issue #304)

## The failure this closes

2026-10-27: four tasks reached Inspector, went green, and ended as incomplete
publications. The GitHub App's installation token lacked `statuses: write`, so
posting the `inspector` commit status answered 403. `fabrica doctor`'s "github
app" check only proved two things — the private key signs a JWT GitHub accepts
(`GET /app`) and the installation covers each registered project's repository
(`GET /repos/{owner}/{repo}/installation`) — neither of which says anything
about what a token minted off that installation would actually be allowed to
do.

## The design, and the alternatives rejected

**Chosen (safest, then most accurate, then fastest):** mint a real publish
token (`PUBLISH_PERMISSIONS`: contents, pull_requests, statuses — all write)
and compare the `permissions` map GitHub hands back on it against the set that
was asked for. GitHub narrows an installation token to what the App holds *and
the installation has accepted*, so a shortfall is visible on the minted
token's own granted list with no write attempted anywhere. The token is read
for its `permissions` field and discarded; it is never returned, logged or
recorded.

**Rejected: attempt the real write** (post a commit status to a throwaway ref,
or open and close a scratch pull request). It is the strongest possible
evidence, and it is the wrong trade: a preflight would be writing into the
Client's own repository, on every `fabrica doctor` run and at the start of
every task. The issue forbids it in as many words ("no real write is
attempted"), and the granted list is sufficient evidence for the one question
being asked.

**Rejected: read the App's own declared permissions** from `GET /app`'s
`permissions` object. One fewer call, no token minted at all — and wrong in
exactly the way that produced this bug. That object is what the App *asks
for*; an installation that was never prompted to accept a widened permission,
or whose owner declined the prompt, keeps the old narrower set. GitHub's own
documentation on modifying an App's permissions says so plainly: "If the
account owner does not approve the new permissions, their installation will
continue to use the old permissions." Only a token actually minted off that
installation reflects what the installation accepted.

## Where the shortfall is detected

Two places, sharing one set of words so they can never disagree:

- `src/githubapp/doctor-checks.ts` — the per-repository loop now mints instead
  of only looking the installation up. The mint answers both questions in one
  pass (a 404 on the installation lookup inside it is still
  `app-not-installed`), so the check costs one extra API call per registered
  project and no extra round trip for the installation id.
- `src/foreman/publish-permissions.ts` — `requirePublishPermissions`, called
  from `registerAndAsk` immediately after rule 10's cap gate and issue #189's
  meter gate, and before `brain.ask()`. A task that cannot be published never
  reaches a machine.

## The one deliberate fail-open, and why it is not a silent skip

The gate refuses on **one** finding: a mint that succeeded and came back
short. Everything else leaves the task to proceed exactly as it does today —
no GitHub App configured, a project whose `origin` is not a github.com
repository, GitHub unreachable, a key GitHub rejects, an installation that
does not cover the repository.

That is not timidity, it is the difference between evidence and the absence of
evidence. A task on a project with no `.inspector.json` at its base commit
publishes nothing at all (`judge.ts`'s `chooseCheckMode` self-test mode), and
such a project legitimately has no App, no origin on github.com, and nothing
to publish. Refusing those at task start would stop work that has always
worked and that issue #304 says nothing about. Each of them already has its
own loud refusal further down the same path, at the point where publishing is
actually about to happen: `publishToken`'s `check()` runs `projectRepo` and
`requireConfigured()` from `Inspector.prepare()`, before any push. The
check-could-not-be-taken cases are reported where a person is actually
reading: `fabrica doctor`'s own line, which already carries them as "could not
check <project>: <reason>".

## The root cause, which was in this repository's own instructions

`src/githubapp/config.ts`'s `appSetupSteps` and README.md's permission table
both told the Client to grant **Commit statuses: Read-only**. That is where
the missing `statuses: write` came from. Both now say **Read and write**, and
both say why (Inspector posts the `inspector` commit status). Without this,
every fresh setup would follow the instructions and then fail the new check.

`PUBLISH_PERMISSIONS` has wanted `statuses: write` since the handoff that
first answered 403 on the stamp (see `scopes.ts`'s own comment); the setup
instructions were simply never updated to match, and nothing compared the two.
`src/githubapp/granted.test.ts` now does: it asserts the setup steps name
"Read and write" for every permission any Fabrica scope asks for at `write`,
so the instructions cannot drift from the scopes again.

## The same shape, elsewhere, left standing

Three other paths start a round and can publish, and none of them carries this
gate:

- `fabrica answer` (`src/foreman/answer.ts`'s `recordAnswerDecision`)
- `fabrica verdict fix` (`src/foreman/verdict.ts`'s `recordVerdictDecision`)
- the quiz re-check round (`src/quiz/recheck.ts`'s `recheckOneTask`)

Issue #304 names `fabrica do` only, so only `fabrica do` was gated. The first
two matter less than they look: both resume a task that already passed this
gate at registration, and both run after the Client has seen `fabrica
doctor`'s own line. The quiz re-check publishes nothing.

Underneath that is the structural gap `notes/20261023-do-fabrica-issue-103-as-written-4s.md`
already named in its §8: `requireGitRoot`, `requireRoomToStart`,
`requireMeterRoomToStart` and now `requirePublishPermissions` are each called
by hand at the same sites, and review is the only thing that catches a new
gate landing at some of them. One `requireStartGates(...)` the start paths all
call, plus a test that fails when a new `require*ToStart` export is not called
from it, is still the cheap fix and is still unbuilt.

## Sharp edges worth knowing

- **The stub GitHub models both of GitHub's answers to an over-wide mint**,
  because the two are observably different and the real one was a surprise:
  `appPermissions` alone answers 422 for a permission the App does not hold at
  all, and `narrowSilently: true` drops it from the response's `permissions`
  instead — the behaviour the 2026-10-27 run actually hit. GitHub's reference
  for `POST /app/installations/{id}/access_tokens` says only that "The
  installation access token cannot be granted permissions that the app was not
  granted" and documents both 201 and 422; it does not say which you get when.
  Fabrica therefore has to survive both: `mint.ts` already turns the 422 into
  a `mint-refused` naming the permissions, and the granted-list comparison
  catches the 201.
- **A granted level is compared by rank, not by equality**
  (`read` < `write` < `admin`), so an App narrowed from write to read is a
  shortfall and one that over-grants is not.
- **`metadata` is never compared.** GitHub grants it to every installation
  token implicitly and it cannot be asked for or declined, so it arrives on
  the granted list without ever appearing in a Fabrica scope. Comparing only
  the keys a scope asked for is what keeps that from reading as a surprise.
