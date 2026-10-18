// Test-only: what a relay started in-process reports its refusals to.
//
// `startRelay` hands each refusal to an `onRefusal` callback and writes
// nothing anywhere itself (see ../types.ts for why that moved out of the
// relay), so a test asserting on refusals collects them here instead of
// reading events.jsonl. The containerized relay is the one that turns
// these into `"network-refused"` events, on the host side
// (../container/launch.ts) - tests covering that path still read the
// record.

import type { RefusalDetails, RelayOptions } from "../types.ts";

export interface RefusalCollector {
  /** Pass this straight into `startRelay`. */
  onRefusal: NonNullable<RelayOptions["onRefusal"]>;
  /** Every refusal reported so far, in order. */
  refusals: RefusalDetails[];
}

export function collectRefusals(): RefusalCollector {
  const refusals: RefusalDetails[] = [];
  return { onRefusal: (details) => void refusals.push(details), refusals };
}
