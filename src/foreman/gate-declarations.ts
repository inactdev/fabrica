// Rule 9's declarations, across a task's rounds (issue #68).
//
// A worker declares any ratified-test or check-setting change it made, in
// its own prose (contract/surface.ts's `BrainWorkResult.gateChanges`), and
// the delivery carries that declaration (`Delivery.gateChanges`). A
// delivery's `files` is the whole cumulative diff since the task's first
// attempt, so its declaration has to account for all of it: a fix round
// that left an earlier round's gate change alone must not lose that
// round's declaration.
//
// Merging used to be "append whatever is not byte-identical to what came
// before", applied to the previous delivery's already-merged text - so a
// task taken through many rounds grew one block per round, forever, and
// re-stored every earlier block on each new "delivered" event. Client
// ruling (issue #68, 2026-10-22): key a declaration by the gate it names
// and keep the newest per gate - "the latest round's intent is the one
// that stands" - while the record keeps every earlier event untouched.
//
// Rule 9's actual enforcement is nowhere near here: it reads the pull
// request's real changed-file list in `.github/workflows/rule9-gate.yml`
// and never looks at Fabrica's output (see src/foreman/README.md). What
// this module decides is only which of a task's own declarations the
// current delivery reports.

/**
 * A path-like token in a declaration's prose: a name with a lowercase
 * 2-8 character extension, optionally under directories. Covers every
 * shape a gate is actually spelled as - `check.sh`, `CONTRACT.md`,
 * `contract/rule9.gate-is-sacred.test.ts`,
 * `.github/workflows/rule9-gate.yml` - and leaves ordinary prose alone:
 * "e.g." and "i.e." have a one-character extension, "1.2.3" and "No."
 * have none that qualifies, and an uppercase extension ("formatted.Then",
 * a missing space after a full stop) is not one either.
 *
 * This is the one place anything under `src/` reads meaning out of a
 * worker's prose, which is normally exactly what this project does not do
 * - so it is written to fail safe. A token this misses, or one it invents,
 * can only ever leave an OLDER declaration standing beside a newer one:
 * that change is still in the cumulative diff the delivery reports, so
 * reporting it is correct, just more than the newest round said. It can
 * never drop a declaration.
 */
const GATE_PATH_TOKEN = /(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.[a-z0-9]{2,8}\b/g;

/** The key a declaration that names no gate at all is filed under - one
 * shared slot, newest wins, so it is bounded like every other key. Not a
 * possible path, so it can never collide with a real gate name. */
const UNNAMED_GATE = "<no gate named>";

/** Every gate a declaration names, lowercased (a worker writing
 * `Check.sh` means the same file as `check.sh`) and de-duplicated. */
export function gateNamesIn(declaration: string): string[] {
  const names = new Set<string>();
  for (const match of declaration.matchAll(GATE_PATH_TOKEN)) names.add(match[0].toLowerCase());
  return [...names];
}

/**
 * The declaration a delivery reports, built from every per-round
 * declaration the task has made, oldest first. One block per gate's
 * newest declaration, blocks that are the same text folded into one, in
 * the order each gate was first declared. `undefined` when the task has
 * declared nothing at all, which is what `Delivery.gateChanges` renders
 * as the empty string.
 *
 * A declaration naming several gates stands as the newest for each of
 * them, so one round's prose is never split up or attributed to a gate it
 * only mentions in passing.
 */
export function mergeGateDeclarations(declarations: readonly (string | undefined)[]): string | undefined {
  const newestByGate = new Map<string, string>();
  for (const declaration of declarations) {
    const text = declaration?.trim();
    if (!text) continue;
    const gates = gateNamesIn(text);
    for (const gate of gates.length > 0 ? gates : [UNNAMED_GATE]) newestByGate.set(gate, text);
  }
  if (newestByGate.size === 0) return undefined;
  const blocks: string[] = [];
  for (const text of newestByGate.values()) if (!blocks.includes(text)) blocks.push(text);
  return blocks.join("\n\n");
}
