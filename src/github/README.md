# src/github

Everything Fabrica reads from GitHub's HTTP API on its own behalf. Today
that is exactly one thing: the issue a task names with `fabrica do
--issue <N>` — its title, its body **and its comments** — fetched once at
registration so a task worded "do issue #N as written" never has to ask
what #N says, or what was later ruled on it.

## What lives here, and what deliberately doesn't

- `issue-ref.ts` — parsing only: `N`, `#N`, `owner/repo#N`, and a pasted
  `https://github.com/owner/repo/issues/N`. No git, no network, no
  record, so it is testable with no repository at all.
- `api.ts` — what both calls share: the API root, the pinned
  `X-GitHub-Api-Version`, the headers GitHub's reference names, how an
  error body's own one-line explanation is read back, and one ISO-8601
  UTC timestamp spelling. Here rather than in `fetch-issue.ts` only
  because the two call files would otherwise be an import cycle; the
  point of it is that the two calls can never drift apart on which
  version they ask for.
- `fetch-issue.ts` — one documented `GET
  /repos/{owner}/{repo}/issues/{N}`, every status it documents answered
  with its own refusal, and the Client's 64 KB ceiling enforced here
  rather than by a caller. Also the one place the two calls are joined:
  `fetchIssue` returns the comments with the issue, so no caller can
  forget to ask for them — and it asks only after the issue's own text
  has passed every refusal, so an oversized issue or a pull request
  costs no second request.
- `fetch-comments.ts` — one documented `GET
  /repos/{owner}/{repo}/issues/{N}/comments`, walked a page at a time at
  the documented maximum `per_page=100` until a page comes back short,
  keeping GitHub's own order (that reference: "issue comments are
  ordered by ascending ID", i.e. oldest first, which is the order the
  brief needs). Automation's comments are separated out here — by
  GitHub's own `user.type` and the `[bot]` login suffix, the only two
  facts it publishes — and a single comment is cut at
  `MAX_COMMENT_CHARS`. How any of that is *worded* is not here: the
  rendering is `src/foreman/task-issue.ts`, which already owned the
  issue's own rendering, so the record's `issue.md` and the Worker's
  brief can never be two different documents.
Resolving a bare `--issue N` against the project's `origin` remote, and
anything that touches the task record, is **not** here: that is
`src/foreman/task-issue.ts`, which also owns the record file, the brief
section, and the one injectable seam every test replaces
(`IssueReader`, faked in `src/foreman/helpers/fake-issue-reader.ts` — it
has to cover origin resolution as well as the fetch, since no fixture
project has a github.com remote). The split is deliberate — this module
knows about GitHub, the foreman knows about tasks.

## Two decisions worth not re-litigating

**An injectable `fetch`, not `gh`.** The token is a GitHub App
installation token minted for the issue's own repository with only
`issues: read` (issue #187 - `src/githubapp/`, wired up in
`src/foreman/github-token.ts`); this module only ever receives it as the
`token` option and never learns where it came from. The *call* is a
plain HTTPS request. `gh issue view --json` would have been shorter and
is already installed on the Client's machine; it was rejected because it
needs the binary present at all, it introduces a second spelling of
"which issue, which repository" between the Client's `--issue` value and
the request, and a child process is the one thing `src/foreman` may not
spawn for anything but git (`src/foreman/no-host-check.test.ts`). It is
also the wrong credential now: `gh`'s own login is the Client's
personal one, which is exactly what the App replaced.

**Refuse, never shorten.** `MAX_ISSUE_BYTES` is a hard ceiling, not a
truncation point (Client ruling: "verbatim and in full on every round -
never truncated or summarized. Only above a hard cap (64 KB) refuse at
registration naming the size"). A worker that silently got half an issue
would answer half a request, and nothing downstream would know.

The comments' own limit is deliberately a different shape, because the
Client ruled on it separately: no cap on the count, the oldest never
dropped, and a cut only within a single comment past
`MAX_COMMENT_CHARS` — and then loudly, naming the comment, its author
and how much was left out. So comments are not counted toward
`MAX_ISSUE_BYTES` (that ceiling is about title plus body, and counting
them in would be a count cap by the back door), and the page walk's
`MAX_COMMENT_PAGES` is a runaway guard rather than a limit anyone should
reach: the walk stops on the first short page, so an API that ignored
`page` would otherwise loop forever. Reaching it refuses rather than
carrying whatever had been read so far.

**Pages are walked, not followed.** GitHub's pagination guide
recommends the `Link` header, and `HttpFetch` deliberately exposes only
`status` and `text()` — widening that seam would ripple into every fake
for no gain here, since asking for the next page until one comes back
short needs nothing but the page itself.
