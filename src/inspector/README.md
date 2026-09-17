# Inspector handoff

`src/inspector/` is Fabrica's adapter for the independently run `inspector` command. A task requires inspection when its base commit contains `.inspector.json`; Worker changes cannot opt out or weaken inspection by changing it. Any final config blob that differs from the base commit, including deletion, is an Inspector refusal rather than a skip. The adapter turns Inspector's exit codes into `green`, `red`, or `refused` without treating a refusal as a red verdict.

The Foreman records the call and report in `events.jsonl`; this module only knows how to make the call. Streamed output is kept as a bounded tail while Inspector runs, and its stored report is capped at 16 KiB with the true total byte count, retaining the end where command-line tools normally print the diagnosis.

## Publishing boundary

Fabrica commits the Worker's changes before this call, but never pushes them. Inspector owns publishing under [inspector#18](https://github.com/inactdev/inspector/issues/18): green work may be pushed by Inspector only after its independent check, and red work must remain local. Inspector is also responsible for committing any mechanical repair it makes before it reports green.

Today's Inspector still requires its HEAD to have been pushed before it can post a status. Since Fabrica correctly never pushes, a configured task currently receives Inspector's `refused` result until inspector#18 supplies the push-inspect-publish order. Fabrica records that refusal as no Inspector verdict, not as a code failure or a red result.

A repository whose task base commit has no `.inspector.json` is deliberately skipped and follows Fabrica's existing delivery path unchanged.
