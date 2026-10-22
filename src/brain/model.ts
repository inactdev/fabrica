// Which model actually ran (issue #184), as far as the brain socket is
// concerned.
//
// A `Brain`'s `model` field is a label it can offer before any call -
// the model it was configured with, if it was configured with one at
// all. Several brains cannot say more than that up front: a CLI worker
// handed no model runs whatever its own configuration resolves to, and
// only the call itself reveals which that was. So the model a receipt
// records is reported per call, as one more reserved transcript entry
// (`MODEL_TRANSCRIPT_KIND` below) - exactly the shape rule 10's
// "usage" entry and issue #189's "meters" entry already use, and for
// the same reason: `Brain.work()`'s ratified return shape has no field
// for it, and a per-call fact must never be kept as mutable state on a
// `Brain` object two concurrent tasks in one process share.
//
// Reading the entry back out is src/foreman/model.ts's job, where the
// receipt is built. This file holds only what both sides need to agree
// on - the entry's kind, and which strings are not model names.

/** The reserved `TranscriptEntry.kind` whose `text` is the name of the
 * model that actually ran, verbatim as the brain reported it. An
 * adapter emits at most one per `work()` call; the last one wins. */
export const MODEL_TRANSCRIPT_KIND = "model";

/** What the record says when nobody could name the model: never
 * "default", which reads as a real choice and was what every receipt
 * said before issue #184. */
export const UNKNOWN_MODEL = "unknown";

/** Labels that look like a model name but name no model - a brain's own
 * stand-in for "whatever my configuration resolves to" (`"default"`),
 * for "nothing is configured" (`"unset"`), or for this file's own
 * admission above. Kept as a set rather than one comparison so a receipt
 * can never record any of them as the model that ran (issue #184: no
 * receipt says "default" again). */
const PLACEHOLDER_LABELS = new Set([UNKNOWN_MODEL, "default", "unset", ""]);

/** Whether `value` is a usable model name rather than a placeholder or
 * nothing at all. Case-insensitive and trim-insensitive: the comparison
 * is about what the string means, not how it was spelled. */
export function isModelName(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  return !PLACEHOLDER_LABELS.has(value.trim().toLowerCase());
}
