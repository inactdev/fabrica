# Notes inbox

A task that discovers a durable, project-intrinsic fact (build, test,
release, architecture, a sharp edge) adds it here as its own new file,
instead of editing `AGENTS.md` directly.

**Why:** `AGENTS.md` used to take every such note as a new bullet
appended to its shared body. Two tasks on parallel branches — the normal
case in this project — both insert text at that same spot, so their pull
requests collide on merge, every time. A new file here can never collide
with another new file.

## Convention: one file per task

Name the file after the task's own branch slug — `git branch
--show-current` with the leading `fabrica/` stripped — e.g.
`notes/20261017-file-a-second-small-issue-agents-md-note-na.md`. That
name is already unique per task, so no extra bookkeeping is needed to
avoid a collision. Plain prose, as long as it needs to be; nothing else
about the format is enforced.

## This is an inbox, not the destination

`AGENTS.md`'s own "Maintaining this file" section still asks for one
curated document that prefers rewriting and pruning over appending.
Folding a note in from here is a separate, human-paced step: read what
piled up, rewrite or extend the relevant part of `AGENTS.md`, then delete
the file(s) just absorbed. A note that hasn't been folded in yet is still
visible to a future agent session — nothing here is hidden — just not
yet distilled.
