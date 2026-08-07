# Claude Code session config (issue #13's prevention half)

This is the one harness this ships a verified config for — the only coding agent installed on the machine this was built and tested on (`no-mistakes doctor` shows `claude` present; `codex`, `rovodev`, `opencode`, `pi`, `copilot`, `acpx`, `cursor` all absent). **No other harness's config exists yet.** If the Client's daily-driver chat agent isn't Claude Code, this piece of issue #13 is unfinished for him, not silently assumed to work — say so rather than guess.

Installed version verified against: **Claude Code 2.1.224.**

## What's here

- `settings.json` - a permissions template: wires the file-editing tools to a denying `PreToolUse` hook, and narrows Bash to Fabrica's own command plus a short allowlist of read-only ones.
- `hooks/deny-and-log-edit.ts` - a `PreToolUse` hook that does both halves in one invocation: it denies the edit, and records it as a durable `edit-attempt-blocked` event on Fabrica's own record.

## Installing it

This is **not** applied automatically to anything — Fabrica registering a project never means Fabrica may silently drop files into that project's own `.claude/` folder; that would be exactly the kind of unrecorded, off-the-books edit this whole issue exists to catch. The Client installs it himself, once per project he wants protected (or once at `~/.claude/settings.json` for every session, project or not — see "Where to put it" below):

1. Copy `settings.json`'s content into the target `.claude/settings.json` (merge its `permissions` and `hooks` keys into an existing file rather than overwriting one that already has content).
2. Replace both `<ABSOLUTE-PATH-TO-FABRICA-REPO>` placeholders in the single `hooks.PreToolUse` command (there is one hook now, under `hooks.PreToolUse` - not `hooks.PermissionDenied`, which this design no longer uses) with wherever this Fabrica checkout actually lives (e.g. `/Users/ari/inkling-umbrella/fabrica`). The command runs Fabrica's own `tsx` against `hooks/deny-and-log-edit.ts` by absolute path deliberately - it works regardless of whether the *target* project has `tsx` (or any Node dependency) installed at all, since it never depends on that project's own `node_modules`.
3. Optionally set `FABRICA_HOME` in the environment the hook command's shell sees, if the record home isn't the default `~/.fabrica`.

### Where to put it

Verified precedence (highest wins): CLI flags > `.claude/settings.local.json` (personal, gitignored) > `.claude/settings.json` (project, shareable) > `~/.claude/settings.json` (every session on the machine). Project-level `.claude/settings.json` is the natural fit for "this registered project's sessions shouldn't edit files directly" and is what the Client would check into that project's own repo if he wants teammates protected too; user-level is the right choice only if he wants it enforced everywhere, Fabrica-registered or not — that's a broader guarantee than this issue asks for, so it's offered as an option, not the default recommendation.

## How this design was arrived at, and what's verified

This template had an earlier design, and it did not work. The history matters, because the failure is the reason the current shape looks the way it does.

### The first design, and how it failed

The first version denied file editing with bare tool names in `permissions.deny` (`"Edit"`, `"Write"`, `"NotebookEdit"`, `"MultiEdit"`) and logged the denial from a separate `PermissionDenied` hook (`hooks/log-blocked-edit.ts`, now deleted). It was built from static verification only: the installed 2.1.224 binary's own embedded strings (`strings -a` on `~/.local/share/claude/versions/2.1.224`) contain the literal `["Edit","Write","NotebookEdit"]` grouping, a `PermissionDenied` hook-event name with the doc string *"When a tool call is denied by the auto mode classifier..."*, that event's payload shape (`{...base, hook_event_name:"PermissionDenied", tool_name, tool_input, tool_use_id, reason}`), and the `matcher` field's `"A|B|C"` alternation over `tool_name`. All of that is real. None of it proved the hook fires.

It was then tested live against the real installed binary in four configurations:

| Configuration | What actually happened |
| --- | --- |
| The shipped bare-name deny list | The editing tools were absent from the session entirely, so no call was ever attempted - and nothing attempted means nothing to log. |
| A path-form deny (`Edit(//**)`) | The call was attempted and blocked. |
| No deny rule at all | The call was denied by the permission prompt. |
| The edit delegated to a spawned subagent | Denied there too. |

The prevention half held in all four - the target file's content was never changed. But the `PermissionDenied` hook fired in **none** of them, so no `edit-attempt-blocked` event was ever produced. A control `SessionStart` hook added to the same settings file did fire, which rules out "hooks from this file are ignored"; the Fabrica-side script itself also recorded correctly when fed a real payload on stdin. The gap was specifically that `PermissionDenied` never fires.

### The current design, and how it was verified

Following an explicit Client decision to try the single-hook alternative, file editing is now denied *and* logged by one `PreToolUse` hook in the same invocation (`hooks/deny-and-log-edit.ts`). Denying through a hook rather than through `permissions.deny` keeps the tool visible to the model, so a real attempt is made every time - which is what makes logging possible at all.

This was verified with two further live, non-bypassed `claude -p` sessions (no `--dangerously-skip-permissions`, real permission evaluation) against the really installed 2.1.224 binary, in a throwaway project with this exact hook wired in:

| Live run | Result |
| --- | --- |
| A direct top-level `Edit` attempt | The `tool_use` appears in the transcript, the target file's content was unchanged afterward (genuinely denied, not just claimed-denied), and a real `edit-attempt-blocked` event landed in `events.jsonl`, written by the hook firing during the live session - not a synthetic stdin test. |
| An `Edit` attempt delegated to a spawned subagent (the Agent tool) | Same result: attempted, file unchanged, event recorded. |

Only `Edit` was independently exercised live, directly and via a subagent. `Write`, `NotebookEdit` and `MultiEdit` were **not** separately live-tested. They are not four code paths - they are four `tool_name` strings matched by the same `matcher` regex into the same hook - so the same result is expected, but expected is not the same as watched.

`MultiEdit` also no longer produces 2.1.224's startup warning *"Permission deny rule "MultiEdit" matches no known tool - check for typos."*, which the old design printed to the Client twice per session. That warning came from `permissions.deny` validating its entries against the known tool names; `MultiEdit` now appears only inside the `PreToolUse` matcher, which is a pattern matched against whatever `tool_name` a call actually carries and is not validated against a tool list.

Two static claims from the first design are still load-bearing and still stand: Bash permission patterns use `Bash(<prefix> *)` / `Bash(<exact command>)` syntax, and settings-file precedence is CLI flags > `.local.json` > project `.json` > user `.json`. Both come from the hosted docs (`code.claude.com/docs/en/permissions.md`) via a research subagent, not independently re-derived from the binary.

## What's not verified

- **Only `Edit` was live-tested, not all four tool names.** See above - `Write`, `NotebookEdit` and `MultiEdit` ride the same matcher and the same hook, so they are expected to behave identically, but they were not independently exercised against the real binary.
- **Bash's allow/deny lists are not a sandbox.** They narrow what auto-approves and hard-block a curated list of destructive patterns, but a determined bypass through Bash (an interpreter's `-c`/`-e` flag, shell redirection through an otherwise-allowed command, etc.) is not something prefix-pattern matching can close completely. Bash's lists are defense in depth, not a claim of a closed shell.
- **Whether the session actually runs under a mode where hook decisions are honored at all.** `bypassPermissions` mode exists and, if the Client's own Claude Code invocation uses it, neither the hook's deny nor `settings.json`'s deny rules apply. This config assumes an ordinary (non-bypass) session.
