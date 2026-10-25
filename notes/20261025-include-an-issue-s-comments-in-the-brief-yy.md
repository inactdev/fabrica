# An issue's comments are part of the request, and are read as amendments

A task that names an issue (`fabrica do --issue N`) now gets that
issue's comments in every brief, not just its title and body: a comment
is where a ruling or an amendment lands, so an issue read without them
is the request as it was first written rather than as it stands.

## The plan this was built to, and the alternatives rejected

**Chosen:** one extra documented `GET
/repos/{owner}/{repo}/issues/{N}/comments` beside the existing issue
`GET`, both at registration, both frozen into the task's `issue.md`;
the rendering of the comments section lives next to the issue's own
rendering (`src/foreman/task-issue.ts`), so what the record keeps and
what the worker reads are the same text. Safest first: a failed or
half-read comments fetch refuses the task before any ProductionLine is
cut, exactly as a failed issue fetch already did - a worker that
silently got the pre-amendment issue would answer a superseded request
and nothing downstream would know.

Rejected, with reasons:

- **Fetching comments fresh on every round** instead of once at
  registration. Rejected: `task-issue.ts`'s decision 2 is that the issue
  is frozen at registration because the record is append-only and a task
  answers the request as it was made. A comment landing mid-task would
  change the request under a running worker; that is a new task.
- **`gh issue view --comments --json comments`**. Rejected for the three
  reasons already ratified in `src/github/README.md` for the issue call
  itself: it needs the binary even when `GITHUB_TOKEN` is set, it puts a
  second spelling of "which issue, which repository" in the way, and
  `src/foreman` may spawn nothing but git.
- **Paginating off the `Link` header**, which GitHub's pagination guide
  recommends. Rejected: `HttpFetch` deliberately exposes only `status`
  and `text()`, and widening it would ripple into every fake for no gain
  here. Pages are walked by asking for `per_page=100` until a page comes
  back short, with a loud refusal (`issue-comments-unbounded`) if the
  walk ever passes `MAX_COMMENT_PAGES` rather than looping forever
  against an API that ignores `page`.
- **Counting comments toward `MAX_ISSUE_BYTES`.** Rejected: the Client's
  ruling on this task is "no cap on count", and that 64 KB ceiling is
  its own ratified ruling about title plus body. The comments' own limit
  is per comment (4000 characters, cut with a loud marker), not a total.

## Sharp edges worth knowing

- **Comments are the one thing an issue carries that is deliberately
  filtered.** Bot and automation comments are never carried as text -
  they would read as rulings to a machine - but they are never silently
  dropped either: their author and posted date go on one "left out" line
  at the end of the section. "Bot" is GitHub's own `user.type` plus the
  `[bot]` login suffix; automation running under a human's personal
  token is indistinguishable from that human and is carried as one.
- **The heading is always emitted, even for an issue with no comments**,
  with an explicit "No comments on this issue as of <fetch time>." line.
  That is what lets a reader tell "none" apart from "not fetched" - and
  it is why `FetchedIssue`'s `comments`/`omittedComments`/`fetchedAt` are
  required fields rather than optional ones: an `IssueReader` that
  forgets them fails to compile instead of rendering a silent nothing.
- **A single comment is cut at 4000 code points**, not 4000 UTF-16 code
  units, so a cut never lands inside a surrogate pair and produces half
  an emoji. The issue's own 64 KB ceiling is still measured in bytes -
  the two limits deliberately use different units, because one is about
  what a brief can hold and the other about what a reader can take in.
- **A brief's own 256 KB ceiling (`src/knowledge`'s `MAX_BRIEF_BYTES`)
  is only checked where knowledge notes are added.** With no cap on
  comment count, a very heavily-commented issue can push a brief past
  that on a project that also carries knowledge notes, and the refusal
  will name the notes rather than the comments. Nothing here changes
  that; it is the known interaction to look at first if that refusal
  ever appears on an issue task.
