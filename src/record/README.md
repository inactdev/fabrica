# The record

`src/record/` is Fabrica's permanent, add-only log of everything that happens to a task: `events.jsonl` on disk, plus a `tasks/<id>/` folder per task holding the human-readable files derived from it.

## What it is

The record has two parts:

- **`events.jsonl`** — one JSON object per line, appended as things happen. This is the single source of truth (SPEC.md "The record"). Nothing in Fabrica may reconstruct a task's history from anywhere else.
- **`tasks/<id>/`** — seven files per task (below), for humans and other tools to read without parsing JSON lines. Every one of them is derived from `events.jsonl`, never an independent record of its own.

This module exists because of CONTRACT rule 5, "It writes everything down": every step of a task — received, worked, checked, delivered, ruled on — lands here in order, and none of it can be changed or erased afterward.

## Every field of an event

A line of `events.jsonl` looks like this:

```json
{"occurredAt":"2026-08-04T12:00:03.118Z","taskId":"20260804-fix-login-bug-q7","name":"task-received"}
```

| Field | Holds | For | If omitted |
| --- | --- | --- | --- |
| `occurredAt` | An ISO 8601 timestamp | Placing the event in time — ordering, and `fabrica log`'s output. | Can't be omitted from the file: `appendEvent` stamps it itself at write time (see `NewFabricaEvent` below). |
| `taskId` | The id of the task this event belongs to | Letting `readEventsForTask` pull one task's history out of the shared file. | Can't be omitted: every event belongs to exactly one task. |
| `name` | One of a known, closed set of event names — `task-received`, `work-started`, `check-run`, `delivered`, and so on (the full set is `FabricaEventName` in `types.ts`) | Saying what happened. A closed union rather than a free-form string, so a typo in an event name is a build error, not a phantom event that silently never shows up in any query. | Can't be omitted: an event with no name says nothing happened. |
| `details` | Any JSON value | Whatever extra context that particular event needs — a check's exit code, an attempt number, a verdict's note. | Left off the line entirely, not written as `null` — a plain event stays a plain three-field line. |

### `FabricaEvent` and `NewFabricaEvent`

The type is called `FabricaEvent`, matching `contract/surface.ts`'s type of the same name — the two used to be named differently (`RecordEvent` here, `FabricaEvent` there) for the identical shape, which is exactly the two-names-for-one-thing confusion this module now avoids. It's declared locally rather than imported from `contract/`, because `src/` modules stay independent of `contract/` (see AGENTS.md) — the two declarations are kept in sync by hand.

`appendEvent(recordHome, input)` takes a `NewFabricaEvent`: a `FabricaEvent` with `occurredAt` removed from the type. That is deliberate — the record decides when an event happened, not the caller. The type only omits the field; nothing in JavaScript stops a caller from handing over an object that still has one, for example by replaying an event it read earlier. `appendEvent` overwrites `occurredAt` unconditionally regardless of what came in, so a stale or forged timestamp never reaches the file.

## The request, answers, and brief

Three different documents live in a task's folder, and they used to be conflated into one (`task.md`, holding the original text with clarification rounds appended onto it — indistinguishable from each other once appended). They're kept apart because that distinction is itself worth keeping:

- **`request.md`** — what the Client originally wrote. Verbatim, immutable: `registerTask` writes it once, at registration, and nothing in this module ever appends to it or overwrites it again.
- **`answers.md`** — every clarification round so far, one section per round: the question that was asked, and the answer the Client gave. Appended to by whatever handles `fabrica answer`, one round at a time.
- **`brief.md`** — the request plus every answer, assembled into the single document a Worker actually receives. This is exactly what gets passed as the `brief` argument to `Brain.work` (see `src/brain/README.md`). Re-derived from `request.md` and `answers.md` every time `fabrica answer` runs, so it can never drift out of sync with what it's assembled from.

Why keep them apart instead of one growing file? Because "this task needed three rounds of clarification" and "this task ran straight through" are different facts about a task — and, over time, about the Client's own task-writing — and merging request and answers into one blob destroys that signal. It feeds directly into:

- **CONTRACT rule 4**, which requires declaring assumptions made "where the brief was silent" — sharper when it's visible which parts of the brief were the original request and which only exist because a Worker had to ask.
- **Phase 5** (#30–#33), which re-attempts past tasks and grades against recorded verdicts; how ambiguous the original request was is a natural thing to compare outcomes against, and that's only recoverable if it was kept separate in the first place.
- **Confidence calibration** (#33), which wants to compare a Worker's claimed confidence against what actually happened — initial ambiguity is an obvious covariate.

`brief.md` could instead be derived fresh on every read instead of written to disk, and that would be defensible too — but writing it keeps the record readable with bare hands, which SPEC.md requires of everything under the record home, so a Worker's exact input is sitting right there in a file rather than reconstructed only in memory.

## The task files

Each task gets `tasks/<id>/`, holding:

| File | Holds | Written by |
| --- | --- | --- |
| `request.md` | The Client's original task text, verbatim | `registerTask`, once, at registration; never appended to or overwritten again. |
| `answers.md` | Every clarification round: question asked, answer given | Whatever handles `fabrica answer`, one round appended per call. |
| `brief.md` | `request.md` plus every answer in `answers.md`, assembled — what a Worker actually receives | The Foreman, at registration, verbatim from the request (no answers exist yet); re-derived and rewritten by `fabrica answer` each time a round is added. |
| `plan.md` | The agent's plan, on the runs where it proceeds straight to work instead of asking questions | The worker, once. |
| `delivery.md` | The delivery block, or a failure report | The Foreman, once, after checks run. |
| `verdict` | The Client's ruling (`accept` / `fix` / `wrong`) plus their note and a timestamp | `fabrica verdict`, once. |
| `transcript.log` | The worker's transcript entries, one JSON line each (see `src/brain/README.md`'s `TranscriptEntry`) | The Foreman, one append per attempt as the loop runs. |

`registerTask` writes `request.md` and appends the matching `task-received` event to `events.jsonl` in the same call, so the file and the record can't drift apart. `src/foreman/` (issue #7) now writes `brief.md`, `transcript.log`, and `delivery.md` the same way; the remaining files exist for the modules that write them later in the loop to reuse the pattern.

## Why there is no edit and no delete

CONTRACT rule 5 says old entries can never be changed or erased through Fabrica. This module satisfies that by construction, not by policing: there is no `updateEvent`, no `deleteEvent`, no `truncate` — no function anywhere in this module that opens `events.jsonl` for anything but reading or appending. There is nothing to check for misuse, because there is no path capable of the misuse.

If you got an event wrong, or a task's understanding of the world changed, don't rewrite the old line — **append a new event describing the correction.** The record is a history, not a snapshot; the correction is itself data worth keeping. (`request.md` follows the same principle for a different reason: it isn't corrected at all, because it's not Fabrica's record of what happened — it's the Client's own words, kept exactly as given.)

## Task ids

An id looks like `20260804-fix-login-bug-q7`: the registration date, a slug of the task text, and two random characters.

Two tasks registered in the same second still can't collide, even though two random characters alone would occasionally repeat. `registerTask` claims its candidate id as an exclusive directory — `mkdir` without `recursive`, which fails if that directory already exists — and retries with a fresh suffix on collision. The guarantee comes from the filesystem refusing a second `mkdir` on the same path, not from the odds of the random suffix being large enough.
