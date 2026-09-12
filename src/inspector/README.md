# Inspector handoff

`src/inspector/` is Fabrica's adapter for the independently run `inspector` command. It invokes `inspector -repo <ProductionLine workdir>` only when that revision contains `.inspector.json`, and turns Inspector's exit codes into `green`, `red`, or `refused` without treating a refusal as a red verdict.

The Foreman records the call and report in `events.jsonl`; this module only knows how to make the call. Its stored report is capped at 16 KiB, retaining the end where command-line tools normally print the diagnosis.

## Publishing boundary

Fabrica commits the Worker's changes before this call, but never pushes them. Inspector owns publishing under [inspector#18](https://github.com/inactdev/inspector/issues/18): green work may be pushed by Inspector only after its independent check, and red work must remain local. Inspector is also responsible for committing any mechanical repair it makes before it reports green.

Today's Inspector still requires its HEAD to have been pushed before it can post a status. Since Fabrica correctly never pushes, a configured task currently receives Inspector's `refused` result until inspector#18 supplies the push-inspect-publish order. Fabrica records that refusal as no Inspector verdict, not as a code failure or a red result.

A repository without `.inspector.json` is deliberately skipped and follows Fabrica's existing delivery path unchanged.
