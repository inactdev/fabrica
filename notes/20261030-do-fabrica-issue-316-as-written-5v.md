# Work mode, third part: terms outside the repo, no stamp, the repo's own pull request template (issue #316)

Three `projects.toml` settings for a repository nothing may be added
to. A project that carries none of them behaves exactly as before - that
is the issue's own clarification, and it is what every existing test
still proves.

```toml
[projects.dayjob]
path                = "~/work/widgets"
githubTokenVar      = "DAYJOB_GITHUB_TOKEN"   # issue #314
terms               = "~/fabrica-terms/widgets"
noStamp             = true
pullRequestTemplate = true
```

## The plan, and the alternative that was rejected

**Chosen.** One module answers "what does work mode mean for this
project" - `src/workmode/` - exactly the way `src/projecttoken/` answers
"which GitHub credential does this project use" for issue #314. Every
reader (the round's own `prepareRound`, `fabrica do`'s up-front refusal,
`fabrica doctor`'s per-project line, the publishing token's scope) asks
that one function, so what the Client is told up front and what a round
does can never be two different answers. Inspector's own two new flags
(`-terms`, `-no-stamp`, inspector#69/PR #71, read from its merged
`main.go` rather than guessed) are passed by the adapter in
`src/inspector/run.ts`, and both are declared in
`src/inspector/consumer-contract.json`, which is what keeps Fabrica's
and Inspector's notion of the call in step (issue #109).

**Rejected: deciding "does this project keep its terms outside the
repo?" from the disk instead of from a setting** - e.g. treating a
project with no `.inspector.json` at its base commit but a sibling
folder holding one as a work-mode project. It needs no new setting and
would have worked, but every one of Fabrica's own "is this project set
up" answers would then depend on a guess about a folder nobody declared,
and a project that genuinely is not set up yet would silently become one
that is. A declared setting is the only thing that can be refused
loudly.

**Also rejected: parsing Fabrica's own rendered pull request body to
re-fit it under a template's headings.** It would have needed no new
data anywhere - the body already carries `## Description (What)` and
friends. But a worker's write-up is structured data Fabrica renders,
never prose Fabrica parses (the deleted `final-message.ts` parser is the
standing ruling), so the template is rendered from the `WorkerWriteup`
itself. That is why `FinalMessageForCommit` now carries the write-up it
was rendered from.

## Sharp edges worth keeping

- **A work-mode project has nothing in the repo to find, so four
  separate "is this set up" reads had to learn about it**, not one:
  `judge.ts`'s `chooseCheckMode` (which would have picked self-test and
  then refused for having no `check.sh`), `inspection.ts`'s three
  in-repo config reads (removed-from-the-line, differs-from-base),
  `src/cli/do-command.ts`'s `refusalForUnsetUpProject` (which would have
  told the Client to run `fabrica register` on a repository he may not
  add a file to), and `fabrica doctor`'s per-project line (which would
  have FAILed, and `fabrica up` stops on any blocking FAIL - the same
  trap issue #314 hit with the github-app line). Anything else that
  reads `.inspector.json` out of the repo in future needs the same
  branch.
- **The terms folder is read at the working tree, with no revision to
  pin it to, and that is safe for the one reason that matters**: it is
  never mounted into a worker's box, so no Worker can reach it. That is
  what lets `requireReviewer` read `testPaths` from it without the
  base-commit pinning an in-repo config needs (a Worker must not be able
  to change who reviews its own work).
- **Skipping the stamp means the publishing token must stop asking for
  `statuses: write` too.** Issue #304's start gate refuses a task whose
  minted token comes back short of what publishing needs; if the check
  were skipped for a no-stamp project while the mint still asked for
  `statuses: write`, the mint itself would fail (GitHub refuses a
  permission the App does not hold) and the task would die later instead
  of earlier. `publishPermissionsFor` is the one answer both the gate
  and the mint read.
- **Inspector refuses a terms folder by name for six reasons** (missing,
  not a directory, a colon in the path, inside the repo, containing the
  repo, missing either required file - read from `internal/inspector/
  terms.go` at `main`). Fabrica mirrors them in
  `src/inspector/terms.ts` so a round refuses before any worker starts,
  the same way issue #306's `inspectorConfigProblem` mirrors Inspector's
  config refusals. Mirrored lists drift: if Inspector's own
  config-check command ever lands (`src/inspector/config-check-issue.md`),
  both lists go away together.
- **`-no-stamp` takes no value.** It is declared in
  `consumer-contract.json` with the ordinary `{name, description}` shape
  and its description says so, rather than a new `boolean` field that
  Inspector's own copy of the file has no struct field for.
- **A variable that appears twice in `brain.env` reads as "not set".**
  `brainEnvValue` ends with `values.length === 1 ? values[0] :
  undefined` - two matching lines are ambiguous and answer nothing. That
  is the right behaviour, and it also means a test that calls both
  `addReaderToHome` and `withReaderConfigured` on one record home
  (`src/reader/helpers/configured-home.ts`) appends the reader's
  credentials twice and then fails with "the code reader ... is not
  set". Use one or the other, never both.
- **Fabrica has no network from inside a worker box, but `WebFetch` has
  one.** Inspector's merged `main.go`, its `terms.go` and its own issue
  were read through the GitHub API that way; `curl`, `gh` and node's
  `fetch` all fail here (the proxy variables are set, but node does not
  read them). Worth knowing before concluding that an outside document
  cannot be reached at all.
