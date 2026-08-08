# Claude Code session config (issue #13's prevention half)

This is the one harness this ships a verified config for — the only coding agent installed on the machine this was built and tested on (`no-mistakes doctor` shows `claude` present; `codex`, `rovodev`, `opencode`, `pi`, `copilot`, `acpx`, `cursor` all absent). **No other harness's config exists yet.** If the Client's daily-driver chat agent isn't Claude Code, this piece of issue #13 is unfinished for him, not silently assumed to work — say so rather than guess.

Installed version verified against: **Claude Code 2.1.224.**

## What's here

- `settings.json` - a permissions template: wires the file-editing tools to a denying `PreToolUse` hook, and narrows Bash to Fabrica's own command plus a short allowlist of read-only ones.
- `verify.ts` - the harness-specific half of `fabrica verify-hook` (`src/cli/verify-hook-command.ts` loads it by scanning `skill/` at runtime, never by naming this harness in `src/`). Not something you run directly - see "Verifying your installation" below.

The actual hook logic - deny the edit, record it as an `edit-attempt-blocked` event, both in one invocation - lives in the installed `fabrica` command itself now (`fabrica deny-and-log-edit`), not in a script under this folder. See "How this design was arrived at" for why that moved.

## Installing it

This is **not** applied automatically to anything — Fabrica registering a project never means Fabrica may silently drop files into that project's own `.claude/` folder; that would be exactly the kind of unrecorded, off-the-books edit this whole issue exists to catch. The Client installs it himself, once per project he wants protected (or once at `~/.claude/settings.json` for every session, project or not — see "Where to put it" below):

1. Make sure `fabrica` itself is installed (`npm install && npm link` from this repo - see the top-level README's "Installing the command"). The hook command below is just `fabrica deny-and-log-edit`, resolved on `PATH` the same way any other installed tool would be - nothing to substitute, no path to keep up to date if this checkout moves.
2. Copy `settings.json`'s content into the target `.claude/settings.json` (merge its `permissions` and `hooks` keys into an existing file rather than overwriting one that already has content).
3. Optionally set `FABRICA_HOME` in the environment the hook command's shell sees, if the record home isn't the default `~/.fabrica`.
4. Run `fabrica verify-hook` from that directory to prove it, rather than assume it - see below.

### Where to put it

Verified precedence (highest wins): CLI flags > `.claude/settings.local.json` (personal, gitignored) > `.claude/settings.json` (project, shareable) > `~/.claude/settings.json` (every session on the machine). Project-level `.claude/settings.json` is the natural fit for "this registered project's sessions shouldn't edit files directly" and is what the Client would check into that project's own repo if he wants teammates protected too; user-level is the right choice only if he wants it enforced everywhere, Fabrica-registered or not — that's a broader guarantee than this issue asks for, so it's offered as an option, not the default recommendation.

### Verifying your installation

`fabrica verify-hook`, run from inside the directory you just installed this into, asks your chat agent - right now, for real, with no permission bypass - to create a throwaway file there, then reports whether the edit was denied and whether the attempt was recorded:

    $ fabrica verify-hook
    Attempting a real edit in this directory, through your installed session config...
      edit denied:    yes
      attempt logged: yes
    Your session config is working correctly.

A failing line names exactly which half broke, instead of leaving "is this installed correctly" as something to assume (Client ruling, issue #13 follow-up - the fail-open gap below is exactly the failure mode this command exists to catch).

## How this design was arrived at, and what's verified

This template had two earlier designs, and neither one held up on its own. The history matters, because each failure is the reason the current shape looks the way it does.

### The first design, and how it failed

The first version denied file editing with bare tool names in `permissions.deny` (`"Edit"`, `"Write"`, `"NotebookEdit"`, `"MultiEdit"`) and logged the denial from a separate `PermissionDenied` hook. It was built from static verification only: the installed 2.1.224 binary's own embedded strings (`strings -a` on `~/.local/share/claude/versions/2.1.224`) contain the literal `["Edit","Write","NotebookEdit"]` grouping, a `PermissionDenied` hook-event name with the doc string *"When a tool call is denied by the auto mode classifier..."*, that event's payload shape (`{...base, hook_event_name:"PermissionDenied", tool_name, tool_input, tool_use_id, reason}`), and the `matcher` field's `"A|B|C"` alternation over `tool_name`. All of that is real. None of it proved the hook fires.

It was then tested live against the real installed binary in four configurations:

| Configuration | What actually happened |
| --- | --- |
| The shipped bare-name deny list | The editing tools were absent from the session entirely, so no call was ever attempted - and nothing attempted means nothing to log. |
| A path-form deny (`Edit(//**)`) | The call was attempted and blocked. |
| No deny rule at all | The call was denied by the permission prompt. |
| The edit delegated to a spawned subagent | Denied there too. |

The prevention half held in all four - the target file's content was never changed. But the `PermissionDenied` hook fired in **none** of them, so no `edit-attempt-blocked` event was ever produced. A control `SessionStart` hook added to the same settings file did fire, which rules out "hooks from this file are ignored"; the Fabrica-side script itself also recorded correctly when fed a real payload on stdin. The gap was specifically that `PermissionDenied` never fires.

### The second design, and the gap it left open

Following an explicit Client decision to try a single-hook alternative, file editing was denied *and* logged by one `PreToolUse` hook in the same invocation. Denying through a hook rather than through `permissions.deny` keeps the tool visible to the model, so a real attempt is made every time - which is what makes logging possible at all. This was verified with two further live, non-bypassed `claude -p` sessions against the really installed 2.1.224 binary: a direct top-level `Edit` attempt and one delegated to a spawned subagent. Both denied, both logged, real events landing in `events.jsonl` from the hook actually firing during the live session, not a synthetic stdin test.

Review then found a real gap in that design, independent of whether the hook logic itself was correct: **the hook command was a hand-substituted absolute path** into this checkout's `node_modules/.bin/tsx`. A `PreToolUse` hook only blocks a tool call on exit code 2; any other non-zero exit (a mistyped placeholder, a moved or renamed Fabrica checkout, a missing `node_modules`) makes the shell exit 127 - a non-blocking error - and the edit is silently *allowed*, with nothing but a stderr line to signal it. The first design's bare-`permissions.deny` failed closed no matter what; this one could fail open on nothing more than a broken install.

### The current design: two fixes, one gap still open by design

Client ruling on that finding (issue #13 follow-up) was **both fixes**, and explicitly *not* a third option that was floated (stacking a static `permissions.deny` rule underneath the hook as a fail-closed backstop) - his reasoning: a backstop like that can still block an edit, but it cannot log one, because the logger is exactly the thing that failed to start; the Client had already ruled that the *log* is the part that matters here, since CI and the inspector catch the substance of an unrecorded change downstream anyway.

1. **The hook command no longer names a path at all.** `settings.json`'s `hooks.PreToolUse` command is just `fabrica deny-and-log-edit` - the installed `fabrica` binary, resolved on `PATH` like any other tool. The hook logic itself moved from a script under this folder into that command (`src/cli/deny-and-log-edit-command.ts`), which is why `hooks/deny-and-log-edit.ts` is gone. This still works from inside a target project with no `tsx` or `node_modules` of its own, the same property the old absolute-path substitution existed for - `fabrica` already resolves its own dependencies via `bin.mjs`'s `import.meta.url` trick regardless of the caller's `cwd` (`src/cli/README.md`), so nothing about *that* changed, only how the hook command reaches it.
2. **`fabrica verify-hook`** (above) makes "is this actually working" a question the Client can answer on demand, rather than something a broken install could silently un-answer for him. It was itself run against the really installed 2.1.224 binary, both directions: an installed config reported denied-and-logged, and a directory with no config installed reported failure rather than a false pass.

**Neither fix removes the fail-open gap.** A `fabrica` that cannot be found or cannot run at all still means the hook command exits non-zero for a reason `PreToolUse` doesn't block on, and the edit still goes through unlogged in that exact moment. What the two fixes change is that the *ordinary* way this used to break - a hand-typed path going stale - no longer exists as a failure mode at all, and the Client now has a direct way to notice if something else takes its place, rather than a misconfiguration sitting silent until an edit slips through for real. Documented here plainly rather than papered over: **this remains a fail-open design**, resting on `fabrica` being reachable, not a fail-closed one.

### Bash: `find` was removed, not narrowed

`Bash(find *)` was in the original allowlist alongside `ls`/`cat`/`grep`/`rg`/`head`/`tail`/`wc`/`pwd`/`git status`/`git diff`/`git log`/`git show`/`git branch` - and it was the odd one out. Unlike those, `find` has flags (`-delete`, `-exec rm {} +`, and others) that mutate the filesystem, and being on the *allow* list means auto-approval with **no prompt at all** - so `find . -delete` would have silently deleted files, past the deny list and past the file-edit hook, with no `edit-attempt-blocked` event, because it is a `Bash` call, not an `Edit`/`Write`/`NotebookEdit`/`MultiEdit` one.

Client ruling (issue #13 follow-up): **remove the entry, don't narrow it.** Deny rules for the specific destructive flags (`-delete`, `-exec`) were considered and rejected - `find`'s own flag surface is too flexible for a prefix-pattern deny list to enumerate correctly once and stay correct, the same limitation "What's not verified" already documents for Bash generally. `find` now falls through to whatever the default ask-first behavior is for any other command not on the allowlist, the same as it would if it had never been considered at all.

The Client's own reasoning for *why* the destructive-`find` risk mattered enough to remove outright, rather than being an acceptable Bash-isn't-a-sandbox caveat like the others: `find . -delete` never becomes a commit, so nothing downstream - not CI, not the inspector - ever sees it happen. Committed files are recoverable from git history; uncommitted work is not, and that is the one category of loss this allowlist cannot afford to risk for the sake of convenience. `grep`, `rg`, `cat`, `head`, `tail`, `wc` and `ls` all stay for the same stated reason: none of them has a destructive mode of its own the way `find` has `-delete` and `-exec` - there's nothing in their own flag surface to remove-instead-of-narrow. **Do not re-add `find` to the allowlist** without a fresh ruling - it is exactly the kind of change that looks like closing an oversight and is actually reopening a considered one.

That reason is about each command's *own* flags, and it is deliberately not a claim that an allowed command cannot write. Any of those seven can put bytes on disk through the shell around it - `cat x > y`, `ls > y`, and so on. That is a general property of running a shell at all, not a property of the seven: **writing via shell redirection through an allowed command is a gap prefix pattern-matching cannot close**, because the allowlist matches the command prefix and the redirection lives outside it. Deny patterns aimed at redirection itself were considered and rejected (Client ruling, issue #13 follow-up) as a false guarantee - they would read like a closed door while quoting, `sh -c`, `tee`, an interpreter's `-e`, and any number of other spellings walk around them. The only thing that actually closes it is real containment - not a filesystem the session cannot write to at all, but one where the *only* writable thing is a single throwaway directory. `src/containment/` runs a Worker's command in a fresh Docker container bind-mounted to `workdir` and nowhere else on the host, network denied unless deliberately allowed: the process can still write, but a stray redirect has nothing reachable to write *to* outside that one directory. That is what a chat session does not run under today.

## What's not verified

- **Only `Edit` was live-tested, not all four tool names.** `Write`, `NotebookEdit` and `MultiEdit` ride the same matcher and the same hook, so they are expected to behave identically, but they were not independently exercised against the real binary.
- **Bash's allow/deny lists are not a sandbox.** They narrow what auto-approves and hard-block a curated list of destructive patterns, but a determined bypass through Bash (an interpreter's `-c`/`-e` flag, shell redirection through an otherwise-allowed command, etc.) is not something prefix-pattern matching can close completely. In particular, **writing through an allowed command - `cat x > y` and every variant of it - is a general gap, not a defect in any one allowlist entry**: the pattern matches the command prefix, and the redirection sits outside what a prefix can see. No wording of the allowlist closes it; only running under real containment does - bind-mounted to one throwaway directory and nowhere else, the way `src/containment/` already runs Workers, which a chat session does not today. See "Bash: `find` was removed, not narrowed" above for why the allowlist was still not trimmed further on account of it. Bash's lists are defense in depth, not a claim of a closed shell.
- **Whether the session actually runs under a mode where hook decisions are honored at all.** `bypassPermissions` mode exists and, if the Client's own Claude Code invocation uses it, neither the hook's deny nor `settings.json`'s deny rules apply. This config assumes an ordinary (non-bypass) session.
- **The fail-open gap itself** (above): a `fabrica` that cannot be found or cannot run at all is not caught by anything in this design - only made easier to notice, via `fabrica verify-hook`, than the previous design's silent path-substitution failure mode was.
