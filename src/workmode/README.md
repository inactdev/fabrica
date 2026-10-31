# Work mode

Issue #316. Three settings for a project whose repository nothing of
ours may be added to, and whose CI nothing of ours may touch:

```toml
[projects.dayjob]
path                = "~/work/widgets"
githubTokenVar      = "DAYJOB_GITHUB_TOKEN"   # issue #314, the same machine
terms               = "~/fabrica-terms/widgets"
noStamp             = true
pullRequestTemplate = true
```

| Setting | What it changes |
| --- | --- |
| `terms` | The folder on this machine holding this project's `.inspector.json`, `Dockerfile.inspector` and check script. Handed to Inspector as `-terms <dir>`, and Fabrica stops looking for those files in the repository at all. |
| `noStamp` | Inspector is handed `-no-stamp`, so a green run still pushes and opens its pull request but posts no commit status; Fabrica's own checks for that status are skipped, and its publishing token stops asking for `statuses: write`. |
| `pullRequestTemplate` | The pull request body is this repository's own `.github/PULL_REQUEST_TEMPLATE.md`, with the write-up's words placed under the template's own sections. The commit message is unchanged. |

A project that carries none of them behaves exactly as it did before
this existed - the issue's own clarification, and what every test
written before it still proves.

## This module answers one question only

`workModeFor(config, projectPath)` (and `projectWorkMode(recordHome,
projectPath)` for a caller that holds only the record home) says which
of the three a project carries. What each one then changes is the
reader's business:

- `src/foreman/judge.ts`'s `prepareRound` - Inspector mode without an
  in-repo config, `-terms`/`-no-stamp` on the handoff, the terms
  folder's own refusals, the reviewer read from the terms folder, and the
  pull request template.
- `src/foreman/inspection.ts` - skips the three in-repo
  `.inspector.json` reads for an outside-terms project.
- `src/cli/do-command.ts` - a work-mode project is set up for Fabrica by
  that setting, so it is never told to run `fabrica register`.
- `src/cli/doctor-command.ts` - the per-project line reports the terms
  folder instead of the repository's own files.
- `src/foreman/github-token.ts` + `src/foreman/publish-permissions.ts` -
  the publishing token's scope and issue #304's start gate.

One answer with many readers, the same shape `src/projecttoken/` has for
issue #314: what `fabrica doctor` says and what a round refuses on can
never be two different answers.

## The terms folder is read-only to Fabrica

Nothing here, and nothing downstream of it, writes into it. In
particular `fabrica register` - the one command that does write a
project's three files - knows nothing about this setting, and cannot: a
project being registered has no entry yet to read one from. A work-mode
project is registered by hand.

Whether a terms folder can actually be used - it exists, it is a
directory, no colon in its path, it is not inside the repository and
does not contain it, and it holds both required files - is
`src/inspector/terms.ts`'s question, because the answer is Inspector's
own list of refusals and a round has to refuse on it before any worker
starts. This module reads the registry and nothing else.
