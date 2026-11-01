# src/attached

The files a task is handed. `fabrica do --file <path>` (repeatable,
issue #325) names documents a task needs — a note, a spec, a data file —
and this module is what gets them to the machine. Before it, the only way
was to paste the whole text into the task text, because a workstation
sees the project checkout and nothing else.

Four small pieces, one each:

| file | what it does |
| --- | --- |
| `resolve.ts` | what a `--file` value means: absolute path, bare name, size — and every shape refused instead |
| `place.ts` | the copies into the workstation's fixed subfolder, the exclusion from git, and taking them away again |
| `brief.ts` | how a brief names them (names and sizes, never contents) |
| `errors.ts` | `AttachedError`, one code per refusal, messages written for the Client verbatim |

`src/foreman/task-files.ts` is the half that knows about tasks: it
persists the resolved list to the task's own `files.json` at
registration, reads it back for every later round, and carries these
messages on as `ForemanError("attached-unavailable")`. Nothing here
knows what a task or a record is.

## Where the files go, and why there

`<workstation>/.fabrica-files/`. The workstation is the one folder a
machine can read — its container is bind-mounted to that and nowhere else
(`src/containment/`) — so a copy anywhere else on the host would be
invisible to it. One path segment, dot-prefixed, so it reads as machinery
rather than as part of the project.

## Why they are never committed

The Client's ruling, in his own words:

> Never committed by Fabrica: the files sit in the fixed subfolder during
> the run, that subfolder is excluded from git for the run, and it is
> deleted before the delivery commit. If the task asks for a file to land
> in the repository, the machine copies it to that real path, and that
> copy is committed like any other change.

Both halves are built, deliberately, rather than either one alone:

1. **Excluded** by a `.gitignore` holding `*` written *inside* the
   subfolder, before any file lands there. `*` matches that file too, so
   the whole folder is invisible to `git status`, `git add -A` and
   `git ls-files` — measured against real git in `place.test.ts`, not
   reasoned about.
2. **Removed** before the delivery commit, in `src/foreman/round.ts` —
   the one tail every round of every delivery shape passes through on its
   way to a commit.

If either one alone failed, the files would still stay out of the branch.

The obvious alternative for the exclusion, `.git/info/exclude`, was
rejected: for a linked worktree that file lives in the project's **shared**
git directory, so writing it would edit the Client's own repository — and
that directory is bind-mounted into the worker's box read-only anyway
(`src/line/worktree-git.ts`).

## What is recorded, and what is not

The record keeps each file's **path, name and size** (`files.json`,
written once at registration). It does **not** keep the bytes. That is
the opposite of how an issue's words are handled (`src/foreman/task-issue.ts`
freezes those at registration) and the same as a knowledge note
(`src/knowledge/`): a document the Client corrects between rounds is one
the next round should read corrected, and copying every handed-over file
into the record home would duplicate possibly large data for every task
that ever used one.

What follows from that: the paths are re-read before each round's
ProductionLine is cut, so a file the Client has since moved or deleted
fails that round with no line behind it, naming the path — the same
timing and the same reason a missing knowledge note gets. Sizes are never
compared against the recorded ones; an edit is not a reason to kill a
task.

## Sharp edges

- A file named `.gitignore` is refused (`"reserved-name"`). That is the
  one name the subfolder uses for itself, and a copy would overwrite the
  thing keeping the folder out of git.
- Two files whose paths end in the same name are refused
  (`"duplicate-name"`) rather than renamed: a brief naming `spec.md` when
  the task meant the *other* `spec.md` is worse than being told to rename
  one.
- Nothing here ever deletes a folder it did not write. A workstation
  already carrying a `.fabrica-files/` of the project's own refuses the
  round instead of being overwritten and then deleted.
- The brief has two wordings, one header. The work's says the files are
  already there; the clarifying step's says they will be, because that
  step runs before any ProductionLine exists
  (`src/foreman/ask.ts`). It still hears about them — it is deciding
  whether the task is clear, and "there is a data file for this" is part
  of that answer.
