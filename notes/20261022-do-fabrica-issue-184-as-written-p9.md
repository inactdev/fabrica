# Issue #184: the real model on every receipt and row

## What the record now holds about a model

Three facts per attempt, all on the `Receipt`:

- `model` — the model that **actually ran**, as the brain reported it.
- `declaredModel` — what was **asked for** (`--model`, or
  `[projects.<name>].model`), or `null` when nothing was asked for.
- `modelSource` — `"flag" | "project" | "default"`.

`"default"` can never appear as a receipt's `model` again:
`src/foreman/model.ts`'s `receiptModel()` is the one builder, and it
treats `"default"`/`"unset"`/`""` as placeholders rather than model names
(a brain that labels itself that way yields `"unknown"`).
`src/foreman/model.test.ts` proves it.

## Where the actual model comes from

Verified against the real binary (2.1.222) on 2026-10-22, by running
`claude -p "say hi" --output-format stream-json --verbose`: the
`system`/`init` line carries `"model":"claude-opus-5[1m]"` — the alias
plus context suffix, i.e. exactly what was selected, not a canonical id.
(The `assistant` line's `message.model` is the canonical `claude-opus-5`,
and the `result` line's `modelUsage` is keyed by the init-line spelling
with a `canonicalModel` inside. The issue asked for the init line; it is
also the only one of the three that exists on a call that never reaches
the API.)

The adapter reports it as a **reserved transcript entry**,
`kind: "model"`, the same way issue #11's `"usage"` and issue #189's
`"meters"` entries work: `Brain.work()`'s ratified return shape has no
field for it, and `src/foreman/model.ts`'s `modelFromTranscript()` reads
it back out where the receipt is built.

**Rejected alternative:** making `Brain.model` mutable so the adapter
could remember the model its last call observed (no new entry kind, no
new reader). Two brains' worth of state on one object: a `Brain` is a
module-level factory result that two concurrent tasks in one process
share, so the receipt for task A could name task B's model. The
transcript entry is per call by construction — the same reasoning
`src/brain/live-transcript.ts` already documents for keying listeners on
`workdir`.

## Why the contract file is untouched

`contract/surface.ts` is a path `rule9-gate.yml` protects, and
`src/inspector/types.ts` is the one place Fabrica widens the ratified
`Receipt` (issue #189's `meters` is the precedent). `declaredModel` and
`modelSource` are Fabrica's own bookkeeping about a choice the Client
made, not a new promise about a seam, so they are widened there and
every reader in `src/` keeps importing `Receipt` from that file.

## The declared model's path through a task

`--model` (or the project's setting) is resolved **once**, at
registration, and persisted as the task file `model.json` — the same
pattern `issue` and `caps.json` already use. Every later round (a
`fabrica answer` resume, a `fix`) re-derives it from there rather than
having it threaded across a process boundary, which is what lets the
detached entry points (`run-task-entry.ts`, `answer-entry.ts`,
`verdict-fix-entry.ts`) build the brain with the right model from
`recordHome` + `taskId` alone.

`defaultBrainAdapter(recordHome, { model })` passes it to whichever
adapter is selected — so `--model` also overrides `FABRICA_MODEL` for
the direct-API worker, not just the CLI worker's `--model` flag.

## The detached child's argv stopped being positional

`--issue` used to ride as a trailing fourth positional into
`run-task-entry.ts`. A second optional value cannot do that without a
placeholder for an absent first one, so the child's argv is now three
positionals plus named flags, parsed by `src/cli/task-entry-args.ts` -
one module both the real entry script and the test fake read, so the
spawner and the parser cannot drift.

## The same shape elsewhere, and what was left standing

A receipt field that never carries the real fact is the shape this issue
fixed. The others found while looking:

- `Receipt.reasoningEffort` is still hardcoded `null` at both
  receipt-building sites in `src/foreman/attempts.ts` - nothing ever
  sets `BrainWorkOptions.reasoningEffort`, so the field records nothing,
  exactly as `model` recorded nothing. Left standing: not this issue's
  scope.
- `brainLabels`' `"unset"` label (`src/brain/adapters/index.ts`) for the
  direct-API worker with no model named. Left standing deliberately, and
  harmless now: `receiptModel` treats it as a placeholder, so it can
  never reach a receipt as a model name.
- `src/brain/adapters/openai-compatible.ts` emits no `"model"` entry -
  but its `Brain.model` IS the exact model id it was configured with, so
  the receipt fallback is already a real name, not a placeholder. A
  provider that silently routes to a different served model would be
  invisible; reporting that would mean plumbing the response's own
  `model` field out of `adapters/openai-agent/`.
- The live view's `networkPolicyLabel` reads "not recorded" for the same
  underlying reason the model did before this - `Brain.work`'s ratified
  shape has nowhere to carry it. Its own README already documents that.

## The fake CLI's init line

`src/brain/adapters/helpers/stream-json-shape.ts` now has a third
category beside `RESULT_KEYS`/`BLOCK_KEYS`: `SYSTEM_KEYS` (`model`),
because the adapter now genuinely reads a key off the `system`/`init`
line. The recorder keeps that one field (`record-real-cli-fixture.mjs`
otherwise rebuilds the init line from scratch), so a re-recording proves
it and `fake-claude-cli.mjs` has to keep emitting it.

## The detached child's argv, after #270 landed beside this

Both optional values a task carries now travel as **named flags** after
the three positionals (`src/cli/task-entry-args.ts`): `--issue <value>`
and `--model <name>`. `--issue` used to be a trailing fourth positional,
which worked only while it was the single optional value - a second one
would have needed a placeholder for an absent issue, in argv, between
two processes, with nothing checking the order.

The `--issue` value crosses that boundary as **the text the Client
typed**, never re-derived into a number on the way: `fabrica do` accepts
three spellings (a plain number, `owner/repo#N`, a pasted issue URL) and
only registration resolves which repository one means
(`src/foreman/task-issue.ts`). `taskEntryFlags` therefore accepts
`number | string` and stringifies, and the parser refuses only a blank
value - a malformed one is refused once, at registration, rather than in
each process that handles it.

Both values are persisted once, at registration (`src/foreman/ask.ts`):
the issue as the `issue`/`issue.md` task files, the model choice as
`model.json`. Every later round - a resumed answer, a fix round, each in
its own fresh process - re-reads both from the record rather than
receiving them as parameters it never gets.
