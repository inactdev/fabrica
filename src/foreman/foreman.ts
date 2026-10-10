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
import type { Brain, CheckBox } from "../brain/index.ts";
import type { Foreman, Inspector } from "../inspector/types.ts";
import type { Caps } from "../../contract/surface.ts";
import { recordCost } from "./caps.ts";
import {
  deliveryOf as lookupDelivery,
  eventsOf as lookupEvents,
  receiptsOf as lookupReceipts,
  statusOf as lookupStatus,
} from "./queries.ts";

export interface ForemanOptions {
  recordHome: string;
  /** Rule 10: hard dollar limits (contract/surface.ts's Caps), enforced
   * on every task, resumed round, and fix round this Foreman starts.
   * Omitted, no cap applies. */
  caps?: Caps;
  /** Fallback for a "fix" verdict's or an answer()'s brain when this
   * Foreman instance never saw a do() call for that task (a fresh
   * process running `fabrica verdict` or `fabrica answer` on its own,
   * the real CLI's shape) — omitting this uses defaultBrainAdapter().
   * When a do() call on THIS instance registered the task, its exact
   * brain is remembered and reused instead (below), so a fix or an
   * answer picks up the same warm worker within one process even
   * without this option; this is only the across-process fallback. */
  brain?: Brain;
  /** Optional Inspector socket. Omitted uses the installed Inspector
   * command when the ProductionLine contains .inspector.json; tests can
   * supply a fake to keep the real command and GitHub out of the run. */
  inspector?: Inspector;
  /** Where a project with no Inspector is self-tested: the worker's own
   * box. Omitted uses the default adapter's box; tests supply a fake. */
  checkBox?: CheckBox;
}

export function createForeman(opts: ForemanOptions): Foreman {
  const { recordHome, caps } = opts;
  // Remembers which brain a do() call on THIS instance used for each
  // task, so a same-process "fix" verdict re-enters the exact same warm
  // worker rather than a fresh defaultBrainAdapter() instance. Empty
  // (and irrelevant) the moment `fabrica verdict` runs in its own
  // process, which is why the fallback above exists.
  const brainByTask = new Map<string, Brain>();

  return {
    async do(taskText, callOpts) {
      const task = await doTask(recordHome, taskText, { ...callOpts, inspector: opts.inspector, checkBox: opts.checkBox, caps });
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
      return answerTask(recordHome, taskId, text, { brain, inspector: opts.inspector, checkBox: opts.checkBox, caps });
    },
    async deliveryOf(taskId) {
      return lookupDelivery(recordHome, taskId);
    },
    async receiptsOf(taskId) {
      return lookupReceipts(recordHome, taskId);
    },
    async verdict(taskId, ruling, note) {
      const brain = brainByTask.get(taskId) ?? opts.brain ?? defaultBrainAdapter();
      return recordVerdict(recordHome, taskId, ruling, note, { brain, inspector: opts.inspector, checkBox: opts.checkBox, caps });
    },
    async status() {
      return lookupStatus(recordHome);
    },
    async recordCost(taskId, usd) {
      recordCost(recordHome, taskId, usd);
    },
    async events(taskId) {
      return lookupEvents(recordHome, taskId);
    },
    recordPath() {
      return eventsPath(recordHome);
    },
  };
}
