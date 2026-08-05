// Assembles the Foreman: the object src/index.ts's createForeman hands
// back once every seam is wired, satisfying contract/surface.ts's Foreman
// interface — declared once there and imported here as a type (issue
// #45) rather than redeclared, since `import type` is erased at compile
// time and creates no runtime dependency on contract/.

import { recordPath as eventsPath } from "../record/index.ts";
import { doTask } from "./do.ts";
import { ForemanError } from "./errors.ts";
import {
  deliveryOf as lookupDelivery,
  eventsOf as lookupEvents,
  receiptsOf as lookupReceipts,
  statusOf as lookupStatus,
} from "./queries.ts";
import type { Foreman } from "../../contract/surface.ts";

export interface ForemanOptions {
  recordHome: string;
  /** Rule 10: hard dollar limits. Accepted for shape compatibility with
   * contract/surface.ts's Foreman; not enforced here — that's issue #11's
   * job, not this loop's. */
  caps?: { perTaskUsd?: number; perDayUsd?: number };
}

export function createForeman(opts: ForemanOptions): Foreman {
  const { recordHome } = opts;

  return {
    async do(taskText, callOpts) {
      return doTask(recordHome, taskText, callOpts);
    },
    async deliveryOf(taskId) {
      return lookupDelivery(recordHome, taskId);
    },
    async receiptsOf(taskId) {
      return lookupReceipts(recordHome, taskId);
    },
    async verdict() {
      // CONTRACT rule 6 ("You get the last word") is issue #10's job: the
      // record shape it needs (a "verdict" task file, a "closed" state)
      // is already in place above it, but recording and closing the loop
      // on a ruling is deliberately left to whoever builds that issue.
      throw new ForemanError("not-built", "fabrica verdict is not built yet (issue #10).");
    },
    async status() {
      return lookupStatus(recordHome);
    },
    async events(taskId) {
      return lookupEvents(recordHome, taskId);
    },
    recordPath() {
      return eventsPath(recordHome);
    },
  };
}
