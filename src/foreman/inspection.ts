// Records the Foreman's handoff to Inspector. On a configured project,
// Inspector's run is the only check (issue #64): Fabrica runs none. A refusal means no verdict,
// so it is recorded without being changed into a red result.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, copyTaskFile } from "../record/index.ts";
import {
  defaultInspector,
  inspectorConfigMatches,
  inspectorIsConfigured,
  reportForRecord,
} from "../inspector/index.ts";
import { DEFAULT_HEARTBEAT_INTERVAL_MS, withHeartbeat } from "./attempts.ts";
import type { ProductionLine } from "../../contract/surface.ts";
import type { Receipt } from "../inspector/types.ts";
import type { Inspection, Inspector } from "../inspector/index.ts";
// Type only: what a rebased branch's publish leases against, decided by
// fix-rebase.ts's policy - this module only carries it.
import type { PublishLease } from "./fix-rebase.ts";

interface InspectionOptions {
  heartbeatIntervalMs?: number;
  /** Resume metadata for a round Inspector refuses, which delivers
   * nothing: with these set, `"inspection-finished"` carries what a
   * `"delivered"` event otherwise would. No caller passes them today -
   * `judge.ts`'s one call site passes only the pull request's title and
   * body, and every attempt's receipt reaches the record through its own
   * `"receipt-recorded"` event (`caps.ts`'s `recordReceipt`). If this is
   * ever wired up, `receipts` is **this round's** receipts, like every
   * `"delivered"` event's since issue #68 - never the task's whole
   * history re-stored, which is what `queries.ts`'s `receiptsOf`
   * reconstructs on read. */
  receipts?: Receipt[];
  totalAttempts?: number;
  prTitle?: string;
  prBody?: string;
  /** Set only by a fix round whose host-side rebase rewrote the branch
   * (inspector#53). Absent means Inspector publishes exactly as it
   * always has. */
  publishLease?: PublishLease;
  /** True for a project whose terms live in a folder outside its
   * repository (issue #316, work mode). The three reads below are all
   * about `.inspector.json` *in the repository*, and such a project has
   * none there by design - the file is in the terms folder, which is
   * never mounted into a worker's box and so is not a thing an attempt
   * could have removed or changed. Those reads are skipped rather than
   * answered wrongly: asked of a work-mode project they would skip the
   * inspection entirely, every time. */
  outsideTerms?: boolean;
}

const INSPECTOR_DIR = ".inspector";
const INSPECTOR_LATEST_FILE = "latest.json";
const INSPECTOR_RUNS_DIR = "runs";

/**
 * Inspector's own on-disk report, if it wrote one: `.inspector/latest.json`
 * names (field "run") the matching file under `.inspector/runs/`. Copied
 * into the task's record folder before the worktree it lives in is torn
 * down - best effort throughout: a self-tested round, or an Inspector that
 * wrote nothing, simply leaves nothing to copy, which is not an error.
 */
function copyInspectorReportFiles(recordHome: string, taskId: string, workdir: string): void {
  const latestPath = join(workdir, INSPECTOR_DIR, INSPECTOR_LATEST_FILE);
  if (!existsSync(latestPath)) return;
  copyTaskFile(recordHome, taskId, "inspector-latest.json", latestPath);

  let run: unknown;
  try {
    run = JSON.parse(readFileSync(latestPath, "utf8")).run;
  } catch {
    return;
  }
  if (typeof run !== "string" || run.length === 0) return;
  const runPath = join(workdir, INSPECTOR_DIR, INSPECTOR_RUNS_DIR, run);
  if (existsSync(runPath)) copyTaskFile(recordHome, taskId, "inspector-run.json", runPath);
}

/** The handoff itself: the one place `"inspector-called"` is appended
 * and the adapter is actually run, reached once every pre-check above
 * has had its say. Its own function because a project whose terms live
 * outside its repository (issue #316) has none of those pre-checks to
 * make and must still make exactly this call. */
async function callInspector(
  recordHome: string,
  taskId: string,
  line: ProductionLine,
  inspector: Inspector | undefined,
  options: InspectionOptions
): Promise<Inspection> {
  const lease = options.publishLease;
  appendEvent(recordHome, {
    taskId,
    name: "inspector-called",
    details: {
      branch: line.branch,
      // What this handoff asked of Inspector that is not the default
      // (issue #316): where this project's terms came from, and that no
      // commit status was to be posted. On the record because "why does
      // this pull request carry no inspector stamp" has to be answerable
      // from the task's own history.
      ...(options.outsideTerms ? { outsideTerms: true } : {}),
      // Both tips when they disagreed, not just the one leased against
      // (Client ruling) - the record is where anyone asking "why did
      // that publish refuse" has to be able to see what was expected.
      ...(lease
        ? { expectedTip: lease.expectedTip, ...(lease.localTip ? { localTipBeforeRebase: lease.localTip } : {}) }
        : {}),
    },
  });
  try {
    return await withHeartbeat(
      () => appendEvent(recordHome, { taskId, name: "heartbeat", details: { phase: "inspection" } }),
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      () =>
        (inspector ?? defaultInspector()).inspect({
          branch: line.branch,
          workdir: line.workdir,
          prTitle: options.prTitle,
          prBody: options.prBody,
          ...(lease ? { expectedTip: lease.expectedTip } : {}),
        })
    );
  } catch (err) {
    return {
      verdict: "refused",
      report: `Inspector could not run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function handToInspector(
  recordHome: string,
  taskId: string,
  line: ProductionLine,
  baseCommit: string,
  inspector: Inspector | undefined,
  options: InspectionOptions = {}
): Promise<Inspection | undefined> {
  const outsideTerms = options.outsideTerms === true;
  if (!outsideTerms && !inspectorIsConfigured(line.workdir, baseCommit)) {
    appendEvent(recordHome, {
      taskId,
      name: "inspection-skipped",
      details: { reason: "no .inspector.json at the task base commit" },
    });
    return undefined;
  }

  let inspection: Inspection;
  if (outsideTerms) {
    inspection = await callInspector(recordHome, taskId, line, inspector, options);
  } else if (!inspectorIsConfigured(line.workdir)) {
    inspection = {
      verdict: "refused",
      report: "Inspector could not run: .inspector.json was removed from the ProductionLine",
    };
  } else if (!inspectorConfigMatches(line.workdir, baseCommit)) {
    inspection = {
      verdict: "refused",
      report: "Inspector could not run: .inspector.json differs from the task base commit",
    };
  } else {
    inspection = await callInspector(recordHome, taskId, line, inspector, options);
  }
  inspection = { ...inspection, report: reportForRecord(inspection.report) };

  appendEvent(recordHome, {
    taskId,
    name: "inspection-finished",
    details: {
      ...inspection,
      ...(options.receipts
        ? {
            receipts: options.receipts,
            project: line.project,
            totalAttempts: options.totalAttempts,
            baseCommit,
          }
        : {}),
    },
  });

  // Driven purely by whether Inspector's own stdout carried the line - no
  // other condition appends this event.
  if (inspection.prUrl) {
    appendEvent(recordHome, { taskId, name: "pr-opened", details: { url: inspection.prUrl } });
  }

  copyInspectorReportFiles(recordHome, taskId, line.workdir);

  return inspection;
}
