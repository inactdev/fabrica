# Claude Code session config (issue #13's prevention half)

This is the one harness this ships a verified config for — the only coding agent installed on the machine this was built and tested on (`no-mistakes doctor` shows `claude` present; `codex`, `rovodev`, `opencode`, `pi`, `copilot`, `acpx`, `cursor` all absent). **No other harness's config exists yet.** If the Client's daily-driver chat agent isn't Claude Code, this piece of issue #13 is unfinished for him, not silently assumed to work — say so rather than guess.

Installed version verified against: **Claude Code 2.1.224.**

## What's here

- `settings.json` — a permissions template: hard-denies the file-editing tools, and narrows Bash to Fabrica's own command plus a short allowlist of read-only ones.
- `hooks/log-blocked-edit.ts` — a `PermissionDenied` hook that turns a blocked edit into a durable `edit-attempt-blocked` event on Fabrica's own record.

## Installing it

This is **not** applied automatically to anything — Fabrica registering a project never means Fabrica may silently drop files into that project's own `.claude/` folder; that would be exactly the kind of unrecorded, off-the-books edit this whole issue exists to catch. The Client installs it himself, once per project he wants protected (or once at `~/.claude/settings.json` for every session, project or not — see "Where to put it" below):

1. Copy `settings.json`'s content into the target `.claude/settings.json` (merge its `permissions` and `hooks` keys into an existing file rather than overwriting one that already has content).
2. Replace both `<ABSOLUTE-PATH-TO-FABRICA-REPO>` placeholders in the `hooks.PermissionDenied` command with wherever this Fabrica checkout actually lives (e.g. `/Users/ari/inkling-umbrella/fabrica`). The command runs Fabrica's own `tsx` against Fabrica's own hook script by absolute path deliberately — it works regardless of whether the *target* project has `tsx` (or any Node dependency) installed at all, since it never depends on that project's own `node_modules`.
3. Optionally set `FABRICA_HOME` in the environment the hook command's shell sees, if the record home isn't the default `~/.fabrica`.

### Where to put it

Verified precedence (highest wins): CLI flags > `.claude/settings.local.json` (personal, gitignored) > `.claude/settings.json` (project, shareable) > `~/.claude/settings.json` (every session on the machine). Project-level `.claude/settings.json` is the natural fit for "this registered project's sessions shouldn't edit files directly" and is what the Client would check into that project's own repo if he wants teammates protected too; user-level is the right choice only if he wants it enforced everywhere, Fabrica-registered or not — that's a broader guarantee than this issue asks for, so it's offered as an option, not the default recommendation.

## Exactly what's verified, and how

Everything below was checked directly against the installed 2.1.224 binary's own embedded strings (`strings -a` on `~/.local/share/claude/versions/2.1.224`) — not just the hosted docs, since a doc page can drift from what's actually shipped and a subagent summarizing a fetched page can misquote it. Where the binary itself echoes the exact string, that's as close to "verified on this machine" as this task gets without a live end-to-end run against the real product (out of scope here — see "What's not verified" below).

| Claim | Verified how |
| --- | --- |
| `permissions.deny` accepts bare tool names `"Edit"`, `"Write"`, `"NotebookEdit"` to remove a tool from the session entirely | The binary contains the literal array `["Edit","Write","NotebookEdit"]` as an internal grouping, plus doc strings describing bare-name removal. `"MultiEdit"` also appears as a related tool name elsewhere in the binary; included in `settings.json`'s deny list defensively even though its exposure in 2.1.224's active tool surface wasn't separately confirmed — denying a tool name that doesn't exist is a harmless no-op, omitting one that does would not be. |
| Bash permission patterns use `Bash(<prefix> *)` / `Bash(<exact command>)` syntax | Confirmed by the hosted docs (`code.claude.com/docs/en/permissions.md`) via a research subagent; not independently re-derived from the binary's strings the way the hook mechanics below were, since pattern-matching logic isn't exposed as a literal string to grep for. |
| A `PermissionDenied` hook event exists, distinct from `PreToolUse` | The binary's own hook-event-name array includes it; a nearby string spells out its purpose: *"When a tool call is denied by the auto mode classifier. Return `{retry: true}` to tell the model it may retry the denied tool call."* |
| `PermissionDenied`'s stdin payload shape | The binary constructs it as `{...base, hook_event_name:"PermissionDenied", tool_name, tool_input, tool_use_id, reason}` — read directly from the minified source, not inferred. `cwd` was not confirmed present on this exact payload (it appears on the shared "base" fields for other hook events); `log-blocked-edit.ts` reads `payload.cwd` if present and falls back to the hook process's own `process.cwd()` otherwise. |
| The hook `matcher` field supports `"A|B|C"` regex-alternation over `tool_name` | The binary's own embedded example doc string is `{"PostToolUse": [{"matcher": "Edit|Write", ...}]}`, with `matcherMetadata:{fieldToMatch:"tool_name",...}` alongside it. |
| Settings file precedence (CLI flags > `.local.json` > project `.json` > user `.json`) | From the hosted docs via the research subagent; not independently re-derived from the binary. |

## What's not verified

- **No end-to-end run against the real Claude Code product.** Nothing here was proven by actually opening a Claude Code session, attempting an edit, and watching it get denied and logged — that needs an interactive (or scripted-but-real) Claude Code session, which this build task didn't have the setup for. The string-level verification above is strong evidence the mechanism exists and is shaped as described; it is not the same as having watched it fire.
- **Bash's allow/deny lists are not a sandbox.** They narrow what auto-approves and hard-block a curated list of destructive patterns, but a determined bypass through Bash (an interpreter's `-c`/`-e` flag, shell redirection through an otherwise-allowed command, etc.) is not something prefix-pattern matching can close completely. The hard guarantee here is the `Edit`/`Write`/`NotebookEdit`/`MultiEdit` tool-level deny; Bash's lists are defense in depth, not a claim of a closed shell.
- **Whether the session actually runs under a mode where `permissions.deny` is honored at all.** `bypassPermissions` mode exists and, if the Client's own Claude Code invocation uses it, none of `settings.json`'s deny rules apply. This config assumes an ordinary (non-bypass) session.
