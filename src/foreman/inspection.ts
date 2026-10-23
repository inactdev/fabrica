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

export async function handToInspector(
  recordHome: string,
  taskId: string,
  line: ProductionLine,
  baseCommit: string,
  inspector: Inspector | undefined,
  options: InspectionOptions = {}
): Promise<Inspection | undefined> {
  if (!inspectorIsConfigured(line.workdir, baseCommit)) {
    appendEvent(recordHome, {
      taskId,
      name: "inspection-skipped",
      details: { reason: "no .inspector.json at the task base commit" },
    });
    return undefined;
  }

  let inspection: Inspection;
  if (!inspectorIsConfigured(line.workdir)) {
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
    const lease = options.publishLease;
    appendEvent(recordHome, {
      taskId,
      name: "inspector-called",
      details: {
        branch: line.branch,
        // Both tips when they disagreed, not just the one leased against
        // (Client ruling) - the record is where anyone asking "why did
        // that publish refuse" has to be able to see what was expected.
        ...(lease
          ? { expectedTip: lease.expectedTip, ...(lease.localTip ? { localTipBeforeRebase: lease.localTip } : {}) }
          : {}),
      },
    });
    try {
      inspection = await withHeartbeat(
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
      inspection = {
        verdict: "refused",
        report: `Inspector could not run: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
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
