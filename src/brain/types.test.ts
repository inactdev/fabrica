// contract/surface.ts and src/brain/types.ts each declare `Brain`
// independently - production code under src/ must never depend on
// contract/, the ratified answer key, so the duplication itself is
// correct. But nothing was checking the two declarations still agree,
// so a drift between them would only surface as a confusing type error
// on whichever real adapter tried to satisfy both at once (carried over
// from PR #37 to issue #6, which is where it would first bite).
//
// This is a type-only, compile-time check: AssertBrainsMatch only
// typechecks if SrcBrain and ContractBrain are structurally identical
// in both directions. If either file's Brain shape changes without the
// other following, `npx tsc --noEmit` fails right here instead of
// inside some adapter's confusing mismatch.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Brain as ContractBrain } from "../../contract/surface.ts";
import type { Brain as SrcBrain } from "./types.ts";

type AssertBrainsMatch = SrcBrain extends ContractBrain
  ? ContractBrain extends SrcBrain
    ? true
    : never
  : never;
const brainsMatch: AssertBrainsMatch = true;

test("src/brain/types.ts's Brain is structurally identical to contract/surface.ts's Brain", () => {
  assert.equal(brainsMatch, true);
});
