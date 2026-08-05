// "Claims verified by code, not taken on faith": a delivery's `files` list
// is a claim about what its branch contains. This checks that claim
// against the branch's actual diff (diff-files.ts) instead of trusting
// whatever the caller wrote down — a disagreement is malformed, exactly
// like a missing field (CONTRACT rule 4). Needs `project`, the git repo
// the branch lives in, which is why this is a separate function from
// validate.ts's validateDelivery: that one runs on a bare object with no
// repo behind it at all.

import type { Delivery } from "../../contract/surface.ts";
import { DeliveryError } from "./errors.ts";
import { diffFiles } from "./diff-files.ts";

export function validateDeliveryFiles(delivery: Delivery, project: string): void {
  const declared = [...delivery.files].sort();
  const actual = diffFiles(project, delivery.branch).sort();

  const agree = declared.length === actual.length && declared.every((file, i) => file === actual[i]);
  if (!agree) {
    throw new DeliveryError(
      "files-mismatch",
      `delivery's files list (${JSON.stringify(declared)}) does not match ` +
        `${delivery.branch}'s actual diff (${JSON.stringify(actual)})`
    );
  }
}
