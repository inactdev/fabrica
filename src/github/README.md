# src/github

Everything Fabrica reads from GitHub's HTTP API on its own behalf. Today
that is exactly one thing: the issue a task names with `fabrica do
--issue <N>`, fetched once at registration so a task worded "do issue #N
as written" never has to ask what #N says.

## What lives here, and what deliberately doesn't

- `issue-ref.ts` — parsing only: `N`, `#N`, `owner/repo#N`, and a pasted
  `https://github.com/owner/repo/issues/N`. No git, no network, no
  record, so it is testable with no repository at all.
- `fetch-issue.ts` — one documented `GET
  /repos/{owner}/{repo}/issues/{N}`, with the headers GitHub's reference
  names, every status it documents answered with its own refusal, and
  the Client's 64 KB ceiling enforced here rather than by a caller.
Resolving a bare `--issue N` against the project's `origin` remote, and
anything that touches the task record, is **not** here: that is
`src/foreman/task-issue.ts`, which also owns the record file, the brief
section, and the one injectable seam every test replaces
(`IssueReader`, faked in `src/foreman/helpers/fake-issue-reader.ts` — it
has to cover origin resolution as well as the fetch, since no fixture
project has a github.com remote). The split is deliberate — this module
knows about GitHub, the foreman knows about tasks.

## Two decisions worth not re-litigating

**An injectable `fetch`, not `gh`.** The token is the one Inspector
publishes with (`src/inspector/run.ts`'s `resolveGithubToken`:
`GITHUB_TOKEN`, else `gh auth token`), but the *call* is a plain HTTPS
request. `gh issue view --json` would have been shorter and is already
installed wherever that token comes from; it was rejected because it
needs the binary even when `GITHUB_TOKEN` is set, it introduces a second
spelling of "which issue, which repository" between the Client's
`--issue` value and the request, and a child process is the one thing
`src/foreman` may not spawn for anything but git
(`src/foreman/no-host-check.test.ts`).

**Refuse, never shorten.** `MAX_ISSUE_BYTES` is a hard ceiling, not a
truncation point (Client ruling: "verbatim and in full on every round -
never truncated or summarized. Only above a hard cap (64 KB) refuse at
registration naming the size"). A worker that silently got half an issue
would answer half a request, and nothing downstream would know.
