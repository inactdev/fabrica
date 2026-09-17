// Records the Foreman's handoff to Inspector. A green Fabrica check is
// necessary but not sufficient for delivery on a configured project:
// Inspector supplies the independent verdict. A refusal means no verdict,
// so it is recorded without being changed into a red result.

import { appendEvent } from "../record/index.ts";
import {
  defaultInspector,
  inspectorConfigMatches,
  inspectorIsConfigured,
  reportForRecord,
} from "../inspector/index.ts";
import { DEFAULT_HEARTBEAT_INTERVAL_MS, withHeartbeat } from "./attempts.ts";
import type { Inspection, Inspector, ProductionLine, Receipt } from "../../contract/surface.ts";

interface InspectionOptions {
  heartbeatIntervalMs?: number;
  receipts?: Receipt[];
  totalAttempts?: number;
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
    appendEvent(recordHome, { taskId, name: "inspector-called", details: { branch: line.branch } });
    try {
      inspection = await withHeartbeat(
        () => appendEvent(recordHome, { taskId, name: "heartbeat", details: { phase: "inspection" } }),
        options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
        () => (inspector ?? defaultInspector()).inspect({ branch: line.branch, workdir: line.workdir })
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
  return inspection;
}
