// Assembles the Foreman: the object src/index.ts's createForeman hands
// back once every seam is wired, satisfying contract/surface.ts's Foreman
// interface — declared once there and imported here as a type (issue
// #45) rather than redeclared, since `import type` is erased at compile
// time and creates no runtime dependency on contract/.

import { recordPath as eventsPath } from "../record/index.ts";
import { doTask } from "./do.ts";
import { answerTask } from "./answer.ts";
import { recordVerdict } from "./verdict.ts";
import { defaultBrainAdapter } from "../brain/index.ts";
import type { Brain } from "../brain/index.ts";
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
  /** Fallback for a "fix" verdict's or an answer()'s brain when this
   * Foreman instance never saw a do() call for that task (a fresh
   * process running `fabrica verdict` or `fabrica answer` on its own,
   * the real CLI's shape) — omitting this uses defaultBrainAdapter().
   * When a do() call on THIS instance registered the task, its exact
   * brain is remembered and reused instead (below), so a fix or an
   * answer picks up the same warm worker within one process even
   * without this option; this is only the across-process fallback. */
  brain?: Brain;
}

export function createForeman(opts: ForemanOptions): Foreman {
  const { recordHome } = opts;
  // Remembers which brain a do() call on THIS instance used for each
  // task, so a same-process "fix" verdict re-enters the exact same warm
  // worker rather than a fresh defaultBrainAdapter() instance. Empty
  // (and irrelevant) the moment `fabrica verdict` runs in its own
  // process, which is why the fallback above exists.
  const brainByTask = new Map<string, Brain>();

  return {
    async do(taskText, callOpts) {
      const task = await doTask(recordHome, taskText, callOpts);
      if (callOpts.brain) brainByTask.set(task.id, callOpts.brain);
      return task;
    },
    async answer(taskId, text) {
      // Same per-instance memory verdict()'s "fix" path uses below: a
      // same-process `do()` call that ended up "asking" already
      // remembered its brain by taskId; a fresh process (the real shape
      // of `fabrica do` then `fabrica answer` by hand) falls back the
      // same way verdict() does.
      const brain = brainByTask.get(taskId) ?? opts.brain ?? defaultBrainAdapter();
      return answerTask(recordHome, taskId, text, { brain });
    },
    async deliveryOf(taskId) {
      return lookupDelivery(recordHome, taskId);
    },
    async receiptsOf(taskId) {
      return lookupReceipts(recordHome, taskId);
    },
    async verdict(taskId, ruling, note) {
      const brain = brainByTask.get(taskId) ?? opts.brain ?? defaultBrainAdapter();
      return recordVerdict(recordHome, taskId, ruling, note, { brain });
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
