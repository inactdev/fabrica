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
import type { IssueReader } from "./task-issue.ts";
import type { Foreman, Inspector } from "../inspector/types.ts";
import type { Caps } from "../../contract/surface.ts";
import { recordCost } from "./caps.ts";
import { readModelChoice } from "./model.ts";
import { machineImageForTask } from "../projectimage/index.ts";
import type { ChecksReader } from "./ci-checks.ts";
import type { TokenMinter } from "../githubapp/index.ts";
import type { DiffReader } from "./reader-round.ts";
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
  /** Issue #267: who reads the checks the repository runs on the pull
   * request Inspector opened, after it has published a green branch.
   * Omitted reads the real pull request over GitHub's API; tests supply
   * a fake, the same way they do for `inspector` and `checkBox`. Only
   * ever reached by a round whose green inspection printed a pull
   * request URL. */
  checksReader?: ChecksReader;
  /** Issue #187: where every GitHub token a task uses is minted from -
   * the push and pull request, the issue it names, the checks on its
   * pull request. Omitted uses the real GitHub App configured on this
   * machine (`src/githubapp`), which is also what refuses a task when
   * no App is configured; tests supply
   * `src/githubapp/helpers/fake-minter.ts`'s fake so no suite needs a
   * registered App or the network. Every mint lands on the task's
   * record as `"token-minted"` either way - that half is Fabrica's own
   * (`src/foreman/github-token.ts`), never the minter's.
   *
   * Reached only for a project that uses the App. One whose
   * projects.toml entry names its own GitHub token (issue #314) never
   * mints at all, so nothing here is asked for it. */
  minter?: TokenMinter;
  /** Inspector issue #34: who reads the whole diff once Inspector has
   * turned it green. Omitted makes the real call to the model named by
   * the project's own `[reader]` table; tests supply a fake, the same
   * way they do for `inspector`, `checkBox` and `checksReader`, so no
   * suite needs a credential or a network. The `[reader]` table is
   * still resolved either way - a fake here replaces the call, never
   * the configuration - so a test exercising a real read configures
   * one. */
  readDiff?: DiffReader;
  /** Where `do(..., { issue })` reads that issue's title and body from
   * (src/foreman/task-issue.ts). Omitted uses the real GitHub, with a
   * GitHub App token minted for the issue's own repository and only
   * `issues: read` (issue #187); tests supply a fake
   * (src/foreman/helpers/fake-issue-reader.ts) so no suite ever needs a
   * token or a network. */
  issueReader?: IssueReader;
  /** Told each new task's id the moment it is registered - before any
   * step that can fail - so a caller can label what it logs for it. */
  onTaskRegistered?: (taskId: string) => void;
}

/** Issue #184: a round started in a fresh process has to build its
 * worker with the model the task was registered with, not whatever the
 * brain's own configuration resolves to - otherwise a `fix` on a task
 * that declared one would silently run a different model from the round
 * being fixed, while its receipt still named the declaration. Read from
 * the task's own record (`model.json`), the same way everything else a
 * resumed round needs is. */
function modelFor(recordHome: string, taskId: string): { model?: string } {
  const { declaredModel } = readModelChoice(recordHome, taskId);
  return declaredModel === null ? {} : { model: declaredModel };
}

/** Everything a worker for an already-registered task has to be built
 * with, re-derived from that task's own record: the model it was
 * registered with (above), and the image its project's machine works in
 * (issue #322 - the project's own check image with Fabrica's layer on
 * top, when it has one). Both for the same reason: a resumed or fix
 * round that ran a different model, or wrote in a different box, from
 * the round it continues would be reporting on something other than
 * what it did. */
function brainChoiceFor(recordHome: string, taskId: string): { model?: string; image?: string } {
  const image = machineImageForTask(recordHome, taskId)?.image;
  return { ...modelFor(recordHome, taskId), ...(image === undefined ? {} : { image }) };
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
      const task = await doTask(recordHome, taskText, { ...callOpts, inspector: opts.inspector, checkBox: opts.checkBox, checksReader: opts.checksReader, minter: opts.minter, readDiff: opts.readDiff, issueReader: opts.issueReader, caps, onTaskRegistered: opts.onTaskRegistered });
      if (callOpts.brain) brainByTask.set(task.id, callOpts.brain);
      return task;
    },
    async answer(taskId, text) {
      // Same per-instance memory verdict()'s "fix" path uses below: a
      // same-process `do()` call that ended up "asking" already
      // remembered its brain by taskId; a fresh process (the real shape
      // of `fabrica do` then `fabrica answer` by hand) falls back the
      // same way verdict() does.
      const brain = brainByTask.get(taskId) ?? opts.brain ?? defaultBrainAdapter(recordHome, brainChoiceFor(recordHome, taskId));
      return answerTask(recordHome, taskId, text, { brain, inspector: opts.inspector, checkBox: opts.checkBox, checksReader: opts.checksReader, minter: opts.minter, readDiff: opts.readDiff, caps });
    },
    async deliveryOf(taskId) {
      return lookupDelivery(recordHome, taskId);
    },
    async receiptsOf(taskId) {
      return lookupReceipts(recordHome, taskId);
    },
    async verdict(taskId, ruling, note) {
      const brain = brainByTask.get(taskId) ?? opts.brain ?? defaultBrainAdapter(recordHome, brainChoiceFor(recordHome, taskId));
      return recordVerdict(recordHome, taskId, ruling, note, { brain, inspector: opts.inspector, checkBox: opts.checkBox, checksReader: opts.checksReader, minter: opts.minter, readDiff: opts.readDiff, caps });
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
