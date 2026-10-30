# src/githubapp

Every GitHub credential Fabrica uses, minted from a GitHub App the
Client owns (issue #187). One repository, one call's worth of
permissions, one hour, then gone.

## Why this exists

Before this, every GitHub call Fabrica made used the Client's personal
token — `GITHUB_TOKEN` from the environment, else `gh auth token`. That
credential lasts until it is revoked and can touch every repository the
Client owns. A worker box never saw it (pushes happen on the host, and
still do), but a bug anywhere on the host, or an Inspector child
process, held a key to everything.

A GitHub App's installation token is the opposite: it expires an hour
after it is minted, it names the repositories it may touch, and it names
the permissions it has there. Fabrica mints one per call and throws it
away.

## The four calls, and what each asks for

`scopes.ts` is the list, one constant per call site, named after the
call rather than after the permissions — so adding an endpoint
somewhere forces a decision here instead of quietly riding on a set
that happens to be wide enough.

| call | where | permissions |
|---|---|---|
| push the branch, open/update the pull request | Inspector's handoff (`src/inspector/run.ts`) | `contents: write`, `pull_requests: write`, `statuses: write` (the `inspector` stamp) |
| read the issue a task names, and its comments | registration (`src/foreman/task-issue.ts`) | `issues: read` |
| read the pull request's own checks | after a green inspection (`src/ci/`) | `pull_requests`, `checks`, `statuses`, `actions`, all read |

`metadata: read` is not listed anywhere: GitHub grants it to every
installation token implicitly and it cannot be asked for or declined.

`actions: read` is in the checks set even though the Client's own list
named only checks, statuses and pull requests. The job-log tail a red
check carries into his report (`src/ci/logs.ts`) is three
`/repos/.../actions/...` reads, and that module answers an unreadable
log with `null` — so without this permission every red check would
quietly arrive with no log, which is the silent skip the standing
rulings forbid.

### Why the preflight mints, and what it reads off the token

`fabrica doctor` used to mint nothing: the two questions it asked — does
this key work, and where is the App installed — are both answered by
JWT-authenticated endpoints (`GET /app`, `GET
/repos/{owner}/{repo}/installation`).

Issue #304 added a third question those two cannot answer. On
2026-10-27 four tasks ran, reached Inspector, went green, and ended as
incomplete publications: the installation token lacked `statuses:
write`, so posting the `inspector` commit status answered 403. The key
signed, the installation covered the repository, and both existing
checks were green the whole time.

GitHub narrows an installation token to what the App holds **and what
the installation has accepted** — its own documentation on modifying an
App's permissions is explicit that an owner who does not approve a
widening keeps the old set — and the only place that narrowing is
visible is the `permissions` map on a token it actually minted. So the
**github app** line now mints a real publishing token per registered
project (`publish-permissions.ts`) and compares that map against
`PUBLISH_PERMISSIONS` (`granted.ts`). A shortfall is a FAIL naming the
permission and the exact setting to change.

No write is ever attempted with it, nothing but `permissions` is read
off it, and the token is discarded — which is what keeps this cheap
enough to run as often as the Client likes. The mint's own installation
lookup is what 404s on a repository the App is not installed on, so this
answers the second question on the way past and costs one extra API call
per project rather than two. A preflight has no task to record a mint
against, so `defaultTokenMinter` is built here with no `onMinted`
recorder; the same comparison at task start
(`src/foreman/publish-permissions.ts`) goes through the task's own
recording minter and lands a `"token-minted"` event like every other
mint.

## How a mint works

1. `config.ts` reads two settings — `FABRICA_GITHUB_APP_ID` and
   `FABRICA_GITHUB_APP_KEY` — from Fabrica's own environment first, then
   from `<recordHome>/brain.env`, the same precedence and the same
   600-mode file every other credential on the machine uses.
2. `jwt.ts` signs a JWT with the App's private key: RS256, `iat` 60
   seconds in the past, `exp` nine minutes out. It can only ask for an
   installation token — it can read nothing and write nothing itself.
3. `mint.ts` asks `GET /repos/{owner}/{repo}/installation` which
   installation covers the repository, then `POST
   /app/installations/{id}/access_tokens` with `repositories: ["<repo>"]`
   and the call's own `permissions`.
4. The caller uses the token for that one call and drops it.

### The key is a path, not a value

`FABRICA_GITHUB_APP_KEY` points at a `.pem` file; it does not hold the
PEM (Client ruling, issue #187's clarification 4). A PEM is multi-line,
and inlining it would mean either a base64 blob nobody can eyeball or a
format `brain.env`'s one-line-per-setting reader cannot hold.

**That file must be mode `600` exactly, and any other mode is refused by
name** — the refusal prints the mode it found and the `chmod 600` that
fixes it. This is deliberately stricter than `brain.env`'s own check,
which refuses only a file other users can *read*: a private key its
owner has left group- or world-*writable* is as replaceable as it is
readable.

### Nothing is cached except the installation id

No JWT is cached (signing is local and cheap, and a cache is one more
place a credential sits). No token is cached — every call gets its own,
and a fix round reached days after the first pass mints a fresh one
rather than trying to publish with an expired token. The one thing
`minter.ts` remembers is which installation covers a given repository,
which is a public fact about the App and not a credential; without it
every mint would be two round trips to GitHub instead of one.

The one exception is the checks read, which mints once for a poll that
may run twenty minutes rather than once per fifteen-second tick: the
scope is identical every time, so a mint per tick would be a hundred
extra API calls and a hundred extra record entries for no narrowing at
all. See `ReadChecksOptions.mintToken` in `src/ci/checks.ts`.

## There is no fallback, on purpose

With no App configured, or a mint GitHub refuses, the call refuses and
names the setup step (Client ruling, clarification 2: "Fail loudly: with
no App configured or a failed mint, refuse the push and the pull request
with the exact setup step; no fallback"). The Client's personal token is
gone from the configuration, and there is nothing else to reach for.

One project may be out of this module's scope entirely — not fall back
to something else, which is the distinction that matters. A project whose
`projects.toml` entry names `githubTokenVar` (issue #314, work mode: a
company organization the App cannot be installed on) reaches GitHub with
its own token for **every** operation, and nothing here is reached for
it: no mint, no `requireConfigured`, and no FAIL on its account from the
doctor line below. That is still not a fallback — a project either names
a token or uses the App, decided by its own entry and never by whether
the other one happens to be configured. See `src/projecttoken/README.md`
for the whole of it, including what issue #304's start gate cannot ask
about such a project.

Two things make that land early rather than mid-task:

- `Inspector.prepare()` is still **synchronous and offline**. It checks
  that both settings are present, the key file is at mode 600, and the
  key parses — no network call — so a handoff that could not possibly
  work refuses with `ForemanError("inspector-not-ready")` before any
  worker starts, exactly as the missing personal token used to.
- `fabrica doctor`'s **github app** line fails on an App that is not
  configured, whose key GitHub rejects, that is installed nowhere, that
  is not installed on a registered project's own repository, or whose
  publishing token comes back short of what a handoff needs (issue
  #304) — and `fabrica up` refuses to start a session over it.
- **`fabrica do` refuses at task start** on that last one
  (`src/foreman/publish-permissions.ts`, called from
  `registerAndAsk` behind rule 10's cap gate and issue #189's meter
  gate): a task whose work could never be published must never be
  worked. It refuses on one finding only — a mint that succeeded and
  came back short. A machine with no App configured, a project with no
  github.com origin, or GitHub unreachable is left to proceed exactly as
  before, because a project self-tested in the worker's box publishes
  nothing at all and legitimately has none of those; each of those cases
  still refuses at `Inspector.prepare()`, and doctor reports it.

## What the record says

One `"token-minted"` event per mint, with
`src/foreman/github-token.ts`'s `TokenMintedDetails`: the repository,
the installation id, the permissions **GitHub says it granted** (read
back off its answer, not echoed from the request, so the record is right
even when the App holds less than the call asked for), the expiry, the
purpose, and GitHub's own `repository_selection`.

Never the token. It exists in memory for the length of one call and
nowhere else — not in a message, not in Fabrica's own process
environment, not in the worker's box. The event name is declared in
`src/inspector/types.ts`'s widening rather than in `contract/surface.ts`
for the reason that file's header gives: which credential Fabrica
reached GitHub with is its own bookkeeping, not a new promise to the
Client about a seam.

`repository_selection` is recorded rather than assumed: if it ever reads
`all`, the one guarantee this whole module exists for has stopped
holding, and the record is where anyone asking would look.

## Testing

Nothing here needs a registered App to test.

- `helpers/fake-minter.ts` — the `TokenMinter` every suite that touches
  a minting code path uses, recording what it was asked for. The same
  role `contract/helpers/fake-inspector.ts` plays for Inspector.
- `helpers/stub-github.ts` — a real local HTTP server that **verifies
  the App's JWT** with the matching public key and **enforces the scope
  of every token it issues**, answering 404 for a repository outside it
  exactly as GitHub does. A double that merely answered requests could
  not catch a missing header, a malformed body, or a scope that was
  never applied.
- `helpers/test-key.ts` — a throwaway PKCS#1 RSA pair, generated per
  call. The format GitHub's "Generate a private key" button downloads,
  so a test that signs with it exercises the same path a real key takes.
  Generated rather than committed: a private key in a repository is a
  private key, however fake.

### The scoping proof exists twice, on purpose

Issue #187's "done when" asks for a test proving the minted token cannot
read a second repo. Both halves are here, per the Client's ruling
(clarification 3: "Both"):

- `mint.test.ts` mints for repository A against the stub, then drives
  **Fabrica's own issue reader** (`src/github/fetch-issue.ts`) at
  repository B — a repository the *same installation* covers, so what
  turns it away is the token's scope and not the installation's. Both of
  that reader's calls are covered: the issue, and the comments call it
  always makes after it, each refused on repository B in its own right.
  Runs on every `npm test`.
- `live.test.ts` does the same against the real App and two real
  fixture repositories, asking GitHub itself which repositories the
  minted token can reach (`GET /installation/repositories`, documented
  to list exactly that). Opt-in behind `FABRICA_GITHUB_APP_LIVE=1`, and
  it skips with a loud banner naming what to set — a silent skip is a
  bug, and a scoping proof that quietly did not run is the worst kind.
  The reach is read from GitHub's own enumeration rather than inferred
  from a 403 or a 404, whose meaning the reference leaves open for a
  repository a token cannot see.

## What still uses the Client's own GitHub credential

`fabrica register` opens its registration pull request with `gh pr
create`, using the Client's own `gh` login (`src/register/tools.ts`'s
`realGhStatus`, `src/register/register.ts` step 10). That is deliberately
untouched here, for two reasons: `gh`'s login is the GitHub CLI's
configuration rather than Fabrica's, so nothing about it is a token this
issue asks to remove; and at `fabrica register` time the App cannot yet
be installed on the project, because the project is only being
registered. Moving that one call onto the App is its own piece of work.
