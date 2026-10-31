# Files handed to a task (`fabrica do --file`, issue #325)

`src/attached/` plus `src/foreman/task-files.ts` is how a task receives a
document it needs - a note, a spec, a data file - instead of having that
document's whole text pasted into the task text. Its own README carries
the design in full; what is worth knowing from outside it:

- **The folder is `<workstation>/.fabrica-files/`**, one path segment,
  and the workstation is the only place a machine can read (its container
  is bind-mounted there and nowhere else). The Client's ruling is that
  Fabrica never commits these files: the folder is excluded from git for
  the run **and** removed before the delivery commit - both halves built,
  so neither has to hold alone. The exclusion is a `.gitignore` of `*`
  written inside the folder itself (`*` matches that file too, so git
  sees nothing at all - measured against real git in `place.test.ts`).
  `.git/info/exclude` was rejected: for a linked worktree it lives in the
  project's **shared** git dir, so writing it would edit the Client's own
  repository, and that dir is mounted read-only in the box anyway. A file
  that is meant to land in the repository is copied to its real path by
  the machine, and the brief tells it so in those words.
- **The removal lives in `src/foreman/round.ts`**, at the top of
  `writeRoundResult` - the one tail every round of every delivery shape
  passes through on its way to a commit. Not at do.ts's and verdict.ts's
  two call sites, which would be two places for it to go missing from
  one.
- **The record keeps paths, names and sizes - not bytes** (`files.json`,
  a new `TaskFile`, written once at registration for every task, an empty
  list included). So this is a knowledge-note-shaped decision, not an
  issue-shaped one: a document corrected between rounds is read
  corrected. What follows is that every round re-reads the paths *before*
  its ProductionLine is cut, so a file the Client has since moved fails
  that round with no line behind it, naming it. Sizes are never compared
  against the recorded ones - an edit is not a reason to kill a task.
- **The repeatable flag crosses the process boundary as one
  `--file <path>` pair per file** (`task-entry-args.ts`), not as a
  delimited list: a path is exactly the kind of value a delimiter would
  mangle. `do-args.ts` makes each path absolute before handing it over,
  because the detached runner does not share the terminal's working
  directory.
- **The clarifying step hears about the files but cannot read them.** It
  runs before any ProductionLine exists, so `withAttachedFiles(...,
  { placed: false })` names them and says plainly that they are not
  readable yet. One header, two wordings - `brief.ts`.
- `Foreman.do`'s `files` option was added to the **widened** `Foreman` in
  `src/inspector/types.ts`, not to `contract/surface.ts`, which is the
  protected answer key; that file is the single place such widenings go
  and `--issue`'s own extra spellings already live there.
