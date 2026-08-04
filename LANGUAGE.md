# LANGUAGE

The shared words for this factory. Plain English, one idea per word,
nothing borrowed from other projects. This is a living document: when
the language grows or changes, this file changes with it.

![The loop](loop.svg)

## The core models

| Model | Role |
| --- | --- |
| **Client** | You. The one the whole factory serves: hands in tasks, answers questions, gives verdicts. (Sometimes speaks through an AI assistant — that assistant only relays; it is not a model of its own.) |
| **Factory** | The whole app: every line, every worker, every record, one container. |
| **ProductionLine** | One task's disposable lane — a throwaway copy of the project where the Worker and the checks run as stations. Built for one task, torn down after. The Client's real code is never on the line. |
| **Foreman** | The delegator in the middle: queues tasks, routes them to lines, counts everything. Pure code — it delegates and it never thinks. Thinking happens only in Workers and in the Client. |
| **Worker** | The execution unit: one per attempt, one model inside, works only on its own ProductionLine. |
| **ProvingGround** | The isolated improvement space: overnight, the factory re-attempts past work, measures, and experiments to get more efficient — graded by the checks and the Client's old verdicts. (Known informally as the gym.) |

## The loop words

| Word | Meaning |
| --- | --- |
| **task** | One piece of work you hand in — typed, or spoken to the AI you talk to. |
| **questions** | Asked before any work starts, only when the task is unclear. You answer; it resumes. |
| **ProductionLine** | Where everything happens: the throwaway copy, the Worker, the checks. Broken down afterward. |
| **worker** | The spawned doer. Exactly one per attempt. It never sees your real checkout. |
| **model** | The AI brain inside a worker. Plugged in through an adapter; the rest of the tool never knows which one. |
| **checks** | The project's own tests, run inside the workspace. They decide pass or fail; they hold no opinions. |
| **retry** | On a failed check: one more try by the same worker, told exactly what failed. Counted by code, never decided by a model. |
| **delivery** | The only thing that leaves the workspace: how sure, assumptions, gaps, and proof. Missing any piece = invalid, never shown. |
| **verdict** | Your last word on a delivery: accept, fix, or wrong direction. |
| **fix** | A verdict that re-enters the loop: your note goes back to the same worker, same workspace, checks re-run. Counted. |
| **record** | Every step, every delivery, every verdict — written down permanently, add-only. |
| **caps** | Dollar limits enforced by code at every step. Hard stops, never vigilance. |
| **ProvingGround** | Later: overnight training on the record and your old verdicts, so aim improves with time. |

## The loop, in one breath

The Client hands in a task. Questions come first only if it's unclear.
The Foreman cuts a ProductionLine; one Worker with one model does the
work on it; the project's checks decide, with one counted retry on
red. A delivery leaves the line — how sure, assumptions, gaps, proof —
and the Client gives the verdict. Accept or wrong closes the task on
the record; fix sends the note back to the same warm Worker. Caps
watch every step (contract rule 10). The ProvingGround trains on all
of it, later.

## Color legend (in the diagram)

Purple = you. Amber = a mind (the only places one exists). Blue and
teal = code and checks. Gray = output. Rose = money limits.

## The name

**Fabrica** — Latin for workshop; Spanish fabrica, a factory.
Chosen August 4, 2026.
