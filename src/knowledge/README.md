# `src/knowledge` — the notes a project carries into every brief

A project can keep what it knows in a knowledge base: a folder with a
`notes/` directory of markdown notes in it, usually its own repository.
Its `projects.toml` entry names that folder and the notes every Worker
on the project should be handed:

    [projects.spending-app.knowledge]
    path = "../knowledge-base"
    notes = ["worker-boxes", "money-rounding"]

This module reads them. `src/foreman/task-knowledge.ts` is the half that
decides *when* — before any ProductionLine is cut, on every round — and
turns the refusals here into the task's own failure.

## What is settled, and why

**Nothing is fetched.** These are files on the Client's own machine,
read as they are on disk at the moment a brief is built. No network, no
copy in the record, no snapshot taken at registration: a note corrected
between a first round and a `fix` round is read corrected by the second
one. The issue a task names goes the other way — fetched once and frozen
(`src/foreman/task-issue.ts`) — because that one *is* the request.

**Bare names, flat.** `"worker-boxes"` means
`<path>/notes/worker-boxes.md`. A name carrying its own `.md`, a path
separator, or a `..` is refused by the config loader
(`src/config/load.ts`), not quietly turned into a lookup nobody meant —
which also means no name can name a file outside the knowledge base's
own `notes/` folder.

**The heading is the note's own title.** Read from a `---` front-matter
block at the top of the file, as a top-level `title:` key, and rendered
as a second-level heading with the note's body under it. The reading is
deliberately narrow rather than a YAML parse: only a block at the very
top, only a key at its own top level, one pair of surrounding quotes
stripped. A note with no title fails the task by name, exactly the way a
missing note does — a brief whose sections were headed by file names
would be a different document than the one that was asked for.

The front matter itself is left out of the brief. It is the note's
metadata, and its one load-bearing field is already the heading the body
sits under.

**Never trimmed.** A note is carried whole or not at all, so something
has to say "this does not fit" out loud: `withKnowledgeNotes` refuses a
brief past `MAX_BRIEF_BYTES` (256 KB — four times `src/github`'s
per-issue ceiling, since a brief holds the task's words, the issue it
names and these notes together), naming every note's size and the
overage. The alternative — handing a Worker a brief with half a note in
it and nothing downstream knowing — is the failure this exists to
prevent, and it is the same ruling `MAX_ISSUE_BYTES` already follows.

The ceiling is only checked where notes are added. A project that names
none is never refused for the size of its own task text, and the message
can always name something the Client can actually remove.

## Files

| File | Holds |
| --- | --- |
| `notes.ts` | `readKnowledgeNotes` (the disk read), `frontMatterTitle`/`bodyAfterFrontMatter` (the narrow front-matter reading), `renderKnowledgeSection` and `withKnowledgeNotes` (the brief section, and the size ceiling), plus `KNOWLEDGE_BRIEF_HEADER`, `NOTES_FOLDER` and `MAX_BRIEF_BYTES`. |
| `errors.ts` | `KnowledgeError`, with codes `no-knowledge-base`, `missing-note`, `missing-note-title`, `brief-too-large`. Every message names the note, the file or the folder it is about, and is shown to the Client verbatim. |
| `index.ts` | The barrel. `src/foreman/task-knowledge.ts` is the only importer. |

`KnowledgeSource` is declared here, structurally, rather than imported
from `src/config`: this module reads a knowledge base, and the registry
it happens to be configured from is not its business.
