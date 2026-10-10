# Inspector handoff

`src/inspector/` is Fabrica's adapter for the independently run `inspector` command. A task requires inspection when its base commit contains `.inspector.json`; Worker changes cannot opt out or weaken inspection by changing it. Any final config blob that differs from the base commit, including deletion, is an Inspector refusal rather than a skip. The adapter turns Inspector's exit codes into `green`, `red`, or `refused` without treating a refusal as a red verdict.

The handoff is trigger-driven: after each attempt's work is committed, the Foreman invokes Inspector directly and waits for that process. Fabrica runs no check of its own (issue #64); Inspector's run is the verdict, and a red report becomes the next attempt's correction brief. The call is `inspector -repo <worktree> -branch fabrica/<taskId>`: Inspector requires `-branch`, the one branch it may publish to after a green result. Neither module polls for an Inspector result. Exit 0 is `green`, exit 1 is `red`, and exit 2 is `refused`; every unexpected exit is also a refusal, never a red verdict. The Foreman records the call and report in `events.jsonl`; this module only knows how to make the call. Streamed output is kept as a bounded tail while Inspector runs, and its stored report is capped at 16 KiB with the true total byte count, retaining the end where command-line tools normally print the diagnosis.

## Publishing boundary

Fabrica commits the Worker's changes before this call, but never pushes them. Inspector owns publishing under [inspector#18](https://github.com/inactdev/inspector/issues/18): green work may be pushed by Inspector only after its independent check, and red work must remain local. Inspector repairs and commits mechanical failures that do not require the Client's request context before it reports green. Request-aware changes return as a red report for the Client's verdict instead.

A repository whose task base commit has no `.inspector.json`, or a machine where Inspector is not installed (`Inspector.installed()`), is self-tested in the Worker's own box instead - see `src/foreman/README.md`.
