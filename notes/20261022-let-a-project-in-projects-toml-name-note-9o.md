# Knowledge-base notes in every brief (`[projects.<name>.knowledge]`)

A project's `projects.toml` entry can now name a knowledge base and a
list of notes from its `notes/` folder; every brief on that project
carries those notes' words in full, each under its front-matter title as
a `##` heading, after the task's own words. `src/knowledge/` reads and
renders them, `src/foreman/task-knowledge.ts` is the round's half,
`src/config/load.ts` parses and shape-checks the table. Both READMEs
(`src/knowledge/README.md`, `src/foreman/README.md`) carry the full
reasoning; this note keeps only what is worth knowing before touching
any of it.

## The decision that shapes everything else: read fresh, never frozen

The issue a task names is fetched once at registration and frozen
(`task-issue.ts`) because it **is** the request. A knowledge note is
not: it is what the project knows today, so it is read off the disk on
every round and nothing about it is written to the record. The Client's
own wording was "the files are read from that path as they are on
disk". A fix round therefore reads a note corrected since the first
round — there is a test pinning exactly that
(`task-knowledge.test.ts`'s "a note corrected between rounds").

The freezing alternative (a `knowledge.md` task file alongside
`issue.md`) was considered and rejected for that reason, and because a
frozen copy could not satisfy "a missing note fails the task" on a later
round at all.

## Why the notes are resolved at three call sites, not inside `workerBrief`

`touched-tests.ts`'s `workerBrief` is "the one place that builds the
brief a worker actually receives", so adding the notes there would have
covered every round in one line. It was rejected: `workerBrief` runs
*after* the ProductionLine is cut or reopened, and the requirement is
that a missing knowledge base or note fails the task **before any line
is cut**. So `knowledgeNotesFor` is called early — in `ask.ts` before
`brain.ask()`, in `do.ts`'s `productionRound` before
`createProductionLine`, in `verdict.ts`'s `runFixRound` before
`reopenProductionLine` — and `withKnowledge` only assembles text. Any
new round-starter must do the same two steps in that order.

## A brief now has a size ceiling, and it lives in `src/knowledge`

There was no brief-size limit anywhere before this. The Client's
clarification required one ("a brief that would exceed its limit with
the notes in fails before the line is cut, saying which notes and by how
much"), so `MAX_BRIEF_BYTES` (256 KB) sits in `src/knowledge/notes.ts`
and is checked **only** inside `withKnowledgeNotes`. A project that
names no notes is never measured, which is deliberate: the blast radius
stays with the feature that introduced the rule, and the refusal can
always name something the Client can remove. If a general brief ceiling
is ever wanted, it belongs somewhere else and needs its own ruling.

## Note names are validated where the registry is read

`.md` in a name, a path separator, `.`/`..`, or an empty entry are
refused by `src/config/load.ts`, not by the reader. That is what makes
"flat, inside the knowledge base's own `notes/`" true by construction
rather than by a path check later. The knowledge `path` is also resolved
there, against `dirname(projects.toml)`, so every downstream reader
holds an absolute path and nobody re-derives what a relative one meant.

## The front-matter reading is narrow on purpose

Only a `---` block at the very top, only a `title:` key at its own top
level (no leading whitespace), one pair of surrounding quotes stripped.
A `title` nested under another key is not the note's own, and an
unclosed block is not front matter. No YAML parser was added for this.
Note that this repository's own `notes/` files (this one included) have
no front matter at all, so they would fail that check — the knowledge
base a project points at is a different repository with its own
convention.
