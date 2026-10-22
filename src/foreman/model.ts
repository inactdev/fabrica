// Which model a task asked for, which one actually ran, and where the
// choice came from (issue #184).
//
// Before this, every receipt the reference worker produced said
// `model: "default"` - true in the sense that no model had been named,
// useless in every other sense: nothing on the record said which model
// did the work, and nothing let a project ask for a cheaper one.
//
// Three facts, kept apart on purpose:
//
//   - the DECLARED model: what was asked for, by `fabrica do --model`
//     or by `[projects.<name>].model` in projects.toml. Null when
//     nothing was asked for, which is the ordinary case.
//   - where that declaration came from (`ModelSource`), so a receipt
//     read weeks later says whether the Client typed it or the project
//     carries it.
//   - the ACTUAL model: what the worker reports having run, which is
//     the only one of the three a brain can be authoritative about
//     (see src/brain/model.ts for why it arrives as a transcript entry).
//
// The declared half is resolved ONCE, at registration, and persisted as
// the task file `model.json` - the same pattern `issue` and `caps.json`
// already follow, and for the same reason: a resumed round or a fix
// round re-derives it from the record rather than having it threaded
// across a process boundary, so `recordHome` plus `taskId` is enough to
// rebuild the worker this task started with.

import { isModelName, MODEL_TRANSCRIPT_KIND, UNKNOWN_MODEL } from "../brain/index.ts";
import { loadConfigOrProblem } from "../config/index.ts";
import { readTaskFile, writeTaskFile } from "../record/index.ts";
import type { FabricaEvent } from "../record/index.ts";
import type { ModelSource, Receipt } from "../inspector/types.ts";

// Declared beside the Receipt field that carries it (see that file) and
// re-exported here, where every reader of it already imports from.
export type { ModelSource };

/** What a task asked for. `declaredModel` is null exactly when
 * `modelSource` is "default". */
export interface ModelChoice {
  declaredModel: string | null;
  modelSource: ModelSource;
}

/** The choice a task carries when nothing declared a model. */
export const NO_MODEL_DECLARED: ModelChoice = { declaredModel: null, modelSource: "default" };

/**
 * The model this task should ask for, and where that came from: the
 * flag wins over the project's own setting, which wins over nothing at
 * all.
 *
 * `project` is the resolved project path, matched against the paths in
 * projects.toml - the same way `networkPolicyFor` and `workerBrief`
 * find a project's other settings. A projects.toml that will not parse
 * yields no project setting rather than throwing: this runs inside
 * `fabrica do`, which already refuses on a broken config file long
 * before here (src/cli/load-config.ts), and a second, differently
 * worded refusal from this depth would say nothing the first did not.
 */
export function resolveModelChoice(recordHome: string, project: string, flagModel?: string): ModelChoice {
  const flag = typeof flagModel === "string" ? flagModel.trim() : "";
  if (flag.length > 0) return { declaredModel: flag, modelSource: "flag" };

  const { config } = loadConfigOrProblem(recordHome);
  for (const entry of Object.values(config.projects)) {
    if (entry.path !== project) continue;
    const declared = typeof entry.model === "string" ? entry.model.trim() : "";
    if (declared.length > 0) return { declaredModel: declared, modelSource: "project" };
  }
  return { ...NO_MODEL_DECLARED };
}

/** Persists the resolved choice once, at registration. Written for
 * every task, declaration or not, so "nothing was declared" is a
 * recorded fact rather than a missing file that could equally mean "a
 * task from before this existed". */
export function writeModelChoice(recordHome: string, taskId: string, choice: ModelChoice): void {
  writeTaskFile(recordHome, taskId, "model.json", JSON.stringify(choice));
}

/** The choice this task was registered with. A task registered before
 * `model.json` existed - or one whose file is unreadable - reports
 * `NO_MODEL_DECLARED`, which is what those tasks actually ran under. */
export function readModelChoice(recordHome: string, taskId: string): ModelChoice {
  const raw = readTaskFile(recordHome, taskId, "model.json");
  if (raw === null) return { ...NO_MODEL_DECLARED };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...NO_MODEL_DECLARED };
  }
  const candidate = parsed as Partial<ModelChoice> | null;
  if (candidate === null || typeof candidate !== "object") return { ...NO_MODEL_DECLARED };
  const declaredModel = typeof candidate.declaredModel === "string" ? candidate.declaredModel.trim() : "";
  const source = candidate.modelSource;
  if (declaredModel.length === 0 || (source !== "flag" && source !== "project")) return { ...NO_MODEL_DECLARED };
  return { declaredModel, modelSource: source };
}

/** The model the worker reported actually running, out of one attempt's
 * transcript (src/brain/model.ts's reserved entry kind) - null when it
 * reported none, or named a placeholder rather than a model. The last
 * such entry wins, mirroring `meterReadingFromTranscript`. */
export function modelFromTranscript(transcript: { kind: string; text: string }[]): string | null {
  let name: string | null = null;
  for (const entry of transcript) {
    if (entry.kind !== MODEL_TRANSCRIPT_KIND) continue;
    if (isModelName(entry.text)) name = entry.text.trim();
  }
  return name;
}

/**
 * What a receipt's `model` records: the model the worker reported, else
 * the brain's own label when that names a real model, else
 * `UNKNOWN_MODEL`.
 *
 * The one builder of that field anywhere, and the reason a receipt can
 * never say "default" again (issue #184): a brain whose label is a
 * placeholder - the reference CLI worker's own "I run whatever my
 * configuration resolves to" - contributes nothing here, and the record
 * says "unknown" instead of implying a model nobody chose.
 */
export function receiptModel(reportedModel: string | null, brainLabel: string | null | undefined): string {
  for (const candidate of [reportedModel, brainLabel]) {
    if (isModelName(candidate)) return (candidate as string).trim();
  }
  return UNKNOWN_MODEL;
}

/** Everything a task row can say about its model, drawn from the
 * record: the actual model off the newest receipt, and the declaration
 * the round was started with. */
export interface ModelOnRecord {
  /** Null until an attempt's receipt has landed. */
  actualModel: string | null;
  declaredModel: string | null;
  modelSource: ModelSource;
}

/**
 * The model facts for one task, from events the caller already holds -
 * never a fresh read of events.jsonl (`fabrica status` renders a whole
 * listing from one pass, and the live view polls twice a second).
 *
 * Both carriers of a receipt are walked, the same way the live view's
 * own `latestReceipt` does: an attempt that ended with no delivery is
 * on the record only as its own "receipt-recorded" event, while a
 * delivery carries the whole list. The declaration is read from
 * whichever event last carried it - a receipt when one exists, and
 * "work-started"'s own details before that, so a row says what the
 * round asked for from the moment work begins rather than only once an
 * attempt has finished.
 */
export function modelFromEvents(events: FabricaEvent[]): ModelOnRecord {
  const onRecord: ModelOnRecord = { actualModel: null, declaredModel: null, modelSource: "default" };
  let latestAttempt = -Infinity;

  const takeDeclaration = (declaredModel: unknown, modelSource: unknown): void => {
    if (typeof declaredModel !== "string" || declaredModel.trim().length === 0) return;
    if (modelSource !== "flag" && modelSource !== "project") return;
    onRecord.declaredModel = declaredModel.trim();
    onRecord.modelSource = modelSource;
  };

  for (const event of events) {
    const details = event.details as
      | { receipt?: unknown; receipts?: unknown; declaredModel?: unknown; modelSource?: unknown }
      | undefined;
    if (details === undefined) continue;
    if (event.name === "work-started") takeDeclaration(details.declaredModel, details.modelSource);

    const candidates: unknown[] = [];
    if (details.receipt !== undefined) candidates.push(details.receipt);
    if (Array.isArray(details.receipts)) candidates.push(...details.receipts);
    for (const candidate of candidates) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const receipt = candidate as Partial<Receipt>;
      if (typeof receipt.attempt !== "number" || receipt.attempt < latestAttempt) continue;
      latestAttempt = receipt.attempt;
      onRecord.actualModel = isModelName(receipt.model) ? receipt.model!.trim() : null;
      takeDeclaration(receipt.declaredModel, receipt.modelSource);
    }
  }

  return onRecord;
}

/** How a declaration is named to the Client - the place he would go to
 * change it, not the enum's own word. */
function sourceLabel(source: ModelSource): string {
  return source === "flag" ? "--model" : "projects.toml";
}

/** A declaration on its own, for the one place that has nothing else to
 * say yet: `fabrica log`'s "work started" line, which lands before any
 * attempt has reported a model. */
export function describeDeclaration(declaredModel: string, source: ModelSource): string {
  return `${declaredModel} (via ${sourceLabel(source)})`;
}

/**
 * One short phrase for a task row: the model that ran, and the
 * declaration behind it when there was one.
 *
 * - nothing declared: `"some-model-5"`, or `"not reported yet"` before
 *   the first receipt lands.
 * - declared and that is what ran: `"small-5 (declared via --model)"`.
 * - declared and something else ran, or nothing has run yet:
 *   `"not reported yet (declared small-5 via --model)"` - the two are
 *   never collapsed, since a declaration the worker did not honor is
 *   exactly the case worth seeing.
 *
 * The single wording for `fabrica status`, `fabrica log`'s own header
 * line and the live view's row, so the three can never read differently
 * (the same reason `describeBaseStanding` is shared).
 */
export function describeModel(onRecord: ModelOnRecord): string {
  const actual = isModelName(onRecord.actualModel) ? onRecord.actualModel!.trim() : null;
  const ran = actual ?? "not reported yet";
  if (onRecord.declaredModel === null) return ran;
  const via = `via ${sourceLabel(onRecord.modelSource)}`;
  if (actual !== null && actual === onRecord.declaredModel) return `${ran} (declared ${via})`;
  return `${ran} (declared ${onRecord.declaredModel} ${via})`;
}
