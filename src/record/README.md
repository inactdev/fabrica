# The record

`src/record/` is Fabrica's permanent, add-only log of everything that happens to a task: `events.jsonl` on disk, plus a `tasks/<id>/` folder per task holding the human-readable files derived from it.

## What it is

The record has two parts:

- **`events.jsonl`** — one JSON object per line, appended as things happen. This is the single source of truth (SPEC.md "The record"). Nothing in Fabrica may reconstruct a task's history from anywhere else.
- **`tasks/<id>/`** — five files per task (below), for humans and other tools to read without parsing JSON lines. Every one of them is derived from `events.jsonl`, never an independent record of its own.

This module exists because of CONTRACT rule 5, "It writes everything down": every step of a task — received, worked, checked, delivered, ruled on — lands here in order, and none of it can be changed or erased afterward.

## Every field of an event

A line of `events.jsonl` looks like this:

```json
{"occurredAt":"2026-08-04T12:00:03.118Z","taskId":"20260804-fix-login-bug-q7","name":"task-received"}
```

| Field | Holds | For | If omitted |
| --- | --- | --- | --- |
| `occurredAt` | An ISO 8601 timestamp | Placing the event in time — ordering, and `fabrica log`'s output. | Can't be omitted from the file: `appendEvent` stamps it itself at write time (see `NewRecordEvent` below). |
| `taskId` | The id of the task this event belongs to | Letting `readEventsForTask` pull one task's history out of the shared file. | Can't be omitted: every event belongs to exactly one task. |
| `name` | A short event name — `task-received`, `work-started`, `check-run`, `delivered`, and so on | Saying what happened. Callers invent these names as they wire up each lifecycle step; this module doesn't validate or enumerate them. | Can't be omitted: an event with no name says nothing happened. |
| `details` | Any JSON value | Whatever extra context that particular event needs — a check's exit code, an attempt number, a verdict's note. | Left off the line entirely, not written as `null` — a plain event stays a plain three-field line. |

### `NewRecordEvent`

`appendEvent(home, input)` takes a `NewRecordEvent`: a `RecordEvent` with `occurredAt` removed from the type. That is deliberate — the record decides when an event happened, not the caller. The type only omits the field; nothing in JavaScript stops a caller from handing over an object that still has one, for example by replaying an event it read earlier. `appendEvent` overwrites `occurredAt` unconditionally regardless of what came in, so a stale or forged timestamp never reaches the file.

## The five task files

Each task gets `tasks/<id>/`, holding:

| File | Holds | Written by |
| --- | --- | --- |
| `task.md` | The task text verbatim, plus any clarifying Q&A rounds appended below it | `registerTask`, once, at registration; later Q&A rounds are appended by whatever handles `fabrica answer`. |
| `plan.md` | The agent's plan, on the runs where it proceeds straight to work instead of asking questions | The worker, once. |
| `delivery.md` | The delivery block, or a failure report | The Foreman, once, after checks run. |
| `verdict` | The Client's ruling (`accept` / `fix` / `wrong`) plus their note and a timestamp | `fabrica verdict`, once. |
| `transcript.log` | The agent session's raw output | The worker, streamed live as it runs. |

`registerTask` writes `task.md` and appends the matching `task-received` event to `events.jsonl` in the same call, so the file and the record can't drift apart. The other four files exist for the modules that write `plan.md`/`delivery.md`/`verdict`/`transcript.log` later in the loop to reuse the same pattern.

## Why there is no edit and no delete

CONTRACT rule 5 says old entries can never be changed or erased through Fabrica. This module satisfies that by construction, not by policing: there is no `updateEvent`, no `deleteEvent`, no `truncate` — no function anywhere in this module that opens `events.jsonl` for anything but reading or appending. There is nothing to check for misuse, because there is no path capable of the misuse.

If you got an event wrong, or a task's understanding of the world changed, don't rewrite the old line — **append a new event describing the correction.** The record is a history, not a snapshot; the correction is itself data worth keeping.

## Task ids

An id looks like `20260804-fix-login-bug-q7`: the registration date, a slug of the task text, and two random characters.

Two tasks registered in the same second still can't collide, even though two random characters alone would occasionally repeat. `registerTask` claims its candidate id as an exclusive directory — `mkdir` without `recursive`, which fails if that directory already exists — and retries with a fresh suffix on collision. The guarantee comes from the filesystem refusing a second `mkdir` on the same path, not from the odds of the random suffix being large enough.
