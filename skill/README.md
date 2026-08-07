# skill/

SPEC.md's "operator's skill": the manual and session setup for whatever AI the Client talks to. This folder currently holds only the prevention piece issue #13 ("off-the-books nets") asks for — the per-harness session config that disables file editing for the chat agent, and its blocked-edit-attempt logging hook. (Issue #13 also specified a detection half; it was built, tested, then cut by Client ruling — see AGENTS.md. Nothing here or in `src/` claims it exists.) The full agent-facing manual (commands, examples, taboos — SPEC.md's "The operator's skill" section) is a separate, not-yet-built piece; don't assume it's here.

## Layout

- `claude-code/` — the one harness with a shipped, verified config right now. See its own README for exactly what's verified, how, and what isn't.

Each harness gets its own subfolder, named after the harness, holding whatever its own permission/settings/hook mechanism needs — these are inherently harness-specific (SPEC.md: "the skill folder ships a **per-harness** session setup"), so nothing here is shared across them beyond the one Fabrica-side event every harness's hook reports into: `edit-attempt-blocked` (`src/offbooks/blocked-edit.ts`'s `recordBlockedEditAttempt`).

## Why nothing here installs itself

Fabrica registering a project never means Fabrica may write into that project's own configuration — that would be the exact kind of silent, off-the-books edit issue #13 exists to catch, just committed by Fabrica itself. Every file under a harness's subfolder is a template the Client reviews and applies by hand; see that subfolder's README for the exact steps.
