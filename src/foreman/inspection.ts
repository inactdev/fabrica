// Records the Foreman's handoff to Inspector. A green Fabrica check is
// necessary but not sufficient for delivery on a configured project:
// Inspector supplies the independent verdict. A refusal means no verdict,
// so it is recorded without being changed into a red result.

import { appendEvent } from "../record/index.ts";
import { defaultInspector, inspectorIsConfigured, reportForRecord } from "../inspector/index.ts";
import type { Inspection, Inspector, ProductionLine } from "../../contract/surface.ts";

export async function handToInspector(
  recordHome: string,
  taskId: string,
  line: ProductionLine,
  inspector: Inspector | undefined
): Promise<Inspection | undefined> {
  if (!inspectorIsConfigured(line.workdir)) {
    appendEvent(recordHome, {
      taskId,
      name: "inspection-skipped",
      details: { reason: "no .inspector.json at the branch head" },
    });
    return undefined;
  }

  appendEvent(recordHome, { taskId, name: "inspector-called", details: { branch: line.branch } });

  let inspection: Inspection;
  try {
    inspection = await (inspector ?? defaultInspector()).inspect({ branch: line.branch, workdir: line.workdir });
  } catch (err) {
    inspection = {
      verdict: "refused",
      report: `Inspector could not run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  inspection = { ...inspection, report: reportForRecord(inspection.report) };

  appendEvent(recordHome, {
    taskId,
    name: "inspection-finished",
    details: inspection,
  });
  return inspection;
}
