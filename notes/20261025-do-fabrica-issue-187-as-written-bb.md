# A GitHub App mints every GitHub token Fabrica uses (issue #187)

## The plan, written before anything was changed

The Client's personal token (`GITHUB_TOKEN`, else `gh auth token` —
`src/inspector/run.ts`'s `resolveGithubToken`) backed four GitHub calls:
Inspector's publish, the pull request's own checks (`src/ci/`), the
issue a task names (`src/foreman/task-issue.ts`), and `fabrica doctor`'s
own line about it. All four now take a one-hour, one-repo installation
token minted from a GitHub App whose private key lives on the host.

Safest first: the whole point of the issue is that a credential which
lasts until revoked and reaches every repository the Client owns is
replaced by one that expires in an hour and names exactly one repository
and exactly the permissions the call it was minted for needs. So the
permission sets are per-call constants (`src/githubapp/scopes.ts`), the
`repositories` list is always exactly one name, and there is no
fall-back to a personal token anywhere — a missing App or a failed mint
refuses, naming the setup step (Client ruling, clarification 2).

### The alternative that was rejected

**Mint one token per task and reuse it for every call that task makes.**
One mint instead of three or four, one event instead of several, and
simpler wiring: the token could be resolved once in `prepareRound` and
threaded like the reviewer's key already is.

Rejected because a single token has to carry the union of every call's
permissions — `contents: write` plus `pull_requests: write` plus
`issues: read` plus `checks`/`statuses`/`actions: read` — so the token
handed to Inspector's child process, which is the one credential that
crosses a process boundary, would be strictly more powerful than the
push and pull-request call it exists for. The issue asks for a token
"limited to that task's repo with only `contents: write` and
`pull_requests: write`", and the clarification sharpened it to "exactly
the permissions each call needs". Per-call minting is slower (two API
calls per mint) and noisier on the record; it is also the only version
that actually delivers the narrowing the issue is for.

## What a future session needs to know

- **`src/githubapp/` is the only place that holds the App's key.** It
  reads two settings — `FABRICA_GITHUB_APP_ID` and
  `FABRICA_GITHUB_APP_KEY` — from Fabrica's own environment first, then
  from `<recordHome>/brain.env`, the same precedence and the same file
  every other credential uses. The key is a *path* to a `.pem`, not the
  PEM itself (Client ruling, clarification 4), and the file must be
  mode `600` exactly: anything else is refused by name, naming the mode
  it found and the `chmod 600` that fixes it. That is deliberately
  stricter than `brainEnvValue`'s own `(mode & 0o077) !== 0` check —
  `brain.env` refuses only a file others can read, this refuses a
  group-writable or world-writable one too.
- **A JWT is never cached; an installation token is never cached.** The
  JWT is signed per mint with `iat` 60 s in the past and `exp` 9 minutes
  out (GitHub's documented ceiling is 10 minutes, and its own samples
  backdate `iat` by 60 s). The one thing the minter does remember is the
  installation id per `owner/repo`, which is not a credential.
- **The record never holds a token.** `"token-minted"` (details:
  `src/foreman/github-token.ts`'s `TokenMintedDetails`) carries the
  repository, the installation id, the permission set, the expiry and
  what the token was for. It is declared in `src/inspector/types.ts`'s
  widening, not in `contract/surface.ts`, for the reason that file's own
  header gives: a minted credential is Fabrica's own bookkeeping, not a
  new promise to the Client about a seam, and `contract/surface.ts` is a
  path `rule9-gate.yml` protects. (Issue #186's `"network-refused"` went
  into the contract instead; the rule stated in `src/inspector/types.ts`
  is the one followed here, since it costs the Client no hand-merge.)
- **`Inspector.prepare()` stays synchronous.** It now checks that the
  App is *configured* — both settings present, the key readable at mode
  600, and parsable as a private key — with no network call at all, so a
  handoff that could not possibly work still refuses before any worker
  starts (`ForemanError("inspector-not-ready")`), exactly as the missing
  personal token used to. The mint itself happens inside `inspect()`,
  which is already async, one per inspection.
- **Inspector's own call is unchanged.** It still receives the token as
  `GITHUB_TOKEN` on its child environment, so
  `src/inspector/consumer-contract.json` needed no edit and neither side
  of the contract-sync workflow moves.
- **`fabrica doctor`'s "github app" line replaces its "GitHub token"
  line.** It resolves the credentials, asks `GET /app` for the App's own
  slug and `installations_count`, then asks `GET
  /repos/{owner}/{repo}/installation` for every registered project whose
  origin is on github.com, and FAILs naming any repository the App is
  not installed on. A `GITHUB_TOKEN` still sitting in Fabrica's
  environment or in `brain.env` rides along as a `note`, which
  `fabrica up` prints as a warning without refusing to start — the issue
  asks doctor to *warn* about a leftover personal token, not to block on
  one. `gh auth token` is deliberately not probed: a `gh` login on the
  machine is not Fabrica's configuration, and warning about it would be
  warning about the wrong thing.
- **The scoping proof exists twice, on purpose.** `mint.test.ts` drives
  a stub GitHub that enforces the scope it was handed (a token minted
  for repo A gets 404 on repo B), so it runs on every `npm test`;
  `live.test.ts` does the same against the real App and two real fixture
  repositories behind `FABRICA_GITHUB_APP_LIVE=1`, and skips with a loud
  banner otherwise — the same convention
  `src/brain/adapters/claude-code.test.ts` and
  `src/cli/skill-settings-live.test.ts` already use for tests that need
  a real credential.
- **`actions: read` is in the checks permission set even though the
  Client's list named only checks/statuses/pull requests.** The job-log
  tail a red check carries (`src/ci/logs.ts`) is three
  `/repos/.../actions/...` reads, and that module answers an
  unreadable log with `null` — so without `actions: read` every red
  check would quietly lose its log tail, which is the silent skip the
  standing rulings forbid.
- **A stub GitHub has to serve every call the real reader makes, query
  string and all.** `src/github/fetch-issue.ts` makes *two* calls, not
  one: the issue, then `fetch-comments.ts`'s paginated
  `/issues/{n}/comments?per_page=…&page=…`, and it refuses a
  half-read issue rather than carrying the text alone. So
  `src/githubapp/helpers/stub-github.ts` routes on the path with its
  query string stripped and serves both endpoints, each enforcing the
  minted token's scope — which also makes the scoping proof stronger,
  since both calls are refused on a repository the token does not
  cover, in their own right. Any later stub that stands in for GitHub
  here needs the same treatment: the reader's call count is not fixed.
- **`tests.map` is committed, so adding or deleting a file is a change
  to it.** A mapping naming a test file the project no longer has is
  reported broken on a delivery (`src/testmap/`), and a source file no
  entry matches is reported unmapped — so a module landing without
  entries is a quiet gap in every later round's brief. Hand-editing is
  expected (the header says so); `fabrica tests-map` regenerating it
  needs `--force` and discards hand edits, so do not reach for the
  generator just to add a few lines. The generator emits only
  colocated `foo.ts`/`foo.test.ts` pairs and sorts both the patterns
  and each entry's test list by plain codepoint order — match that when
  adding lines by hand, or the next regeneration reshuffles the file.
