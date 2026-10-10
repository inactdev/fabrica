// Who judges each attempt (issue #64, Client ruling 2026-10-08). Fabrica
// runs no project check on the host - the check command is a file the
// worker just edited. Two modes, chosen once per round:
//
//   a. "inspector": Inspector is installed and the task's base commit has
//      .inspector.json. Each attempt's work is committed and handed to
//      Inspector, whose containerized run is the verdict. Fabrica runs
//      nothing itself.
//   b. "self-test": otherwise. The project's check runs once per attempt
//      inside the worker's own box (CheckBox), never on the host. That is
//      the builder checking the builder - the delivery says so.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { appendEvent } from "../record/index.ts";
import { defaultInspector, inspectorIsConfigured } from "../inspector/index.ts";
import { defaultCheckBox } from "../brain/index.ts";
import type { CheckBox } from "../brain/index.ts";
import type { GateResult, ProductionLine } from "../../contract/surface.ts";
import type { Inspection, Inspector } from "../inspector/index.ts";
import type { Delivery } from "../inspector/types.ts";
import { DEFAULT_CHECK_COMMAND, requireCheckCommand, resolveCheckCommand } from "./resolve-check.ts";
import { requireGateBaseline } from "./gate-changes.ts";
import { ForemanError } from "./errors.ts";
import { commitWorktreeChanges } from "./commit.ts";
import { handToInspector } from "./inspection.ts";

/** One attempt's judgement. Only "verdict" is a red or green result; the
 * rest stop the loop with no verdict at all. */
export type Judgement =
  | { kind: "verdict"; gate: GateResult; inspection?: Inspection }
  /** Inspector reached no verdict. */
  | { kind: "refused"; inspection: Inspection }
  /** The worker's box could not run the check - not verified, not red. */
  | { kind: "not-verified"; reason: string }
  /** Committing the attempt for Inspector failed (a host problem). */
  | { kind: "commit-failed"; error: string };

export type Judge = (attempt: number) => Promise<Judgement>;

export type CheckMode = { mode: "inspector"; inspector: Inspector } | { mode: "self-test"; reason: string };

/** Mode a when Inspector can run and the base commit asks for it; mode b
 * otherwise - never a refusal (Client ruling: no Inspector still works,
 * the Client is just the only reviewer). */
export function chooseCheckMode(line: ProductionLine, baseCommit: string, inspector: Inspector | undefined): CheckMode {
  if (!inspectorIsConfigured(line.workdir, baseCommit)) {
    return { mode: "self-test", reason: "no .inspector.json at the task base commit" };
  }
  const chosen = inspector ?? defaultInspector();
  if (chosen.installed && !chosen.installed()) return { mode: "self-test", reason: "Inspector is not installed" };
  return { mode: "inspector", inspector: chosen };
}

/** The exact words a self-tested delivery carries (issue #64, mode b). */
export const SELF_TESTED = "self-tested in the worker's box; no Inspector; not independently checked";

/** A shell exit status meaning the box lacks a command the check needs. */
const COMMAND_NOT_FOUND = 127;

export function inspectorJudge(
  recordHome: string,
  taskId: string,
  line: ProductionLine,
  baseCommit: string,
  inspector: Inspector,
  commitMessage: string
): Judge {
  return async () => {
    // Inspector judges a commit, so the attempt is committed first.
    try {
      commitWorktreeChanges(line.workdir, commitMessage);
    } catch (err) {
      if (err instanceof ForemanError && err.code === "commit-failed") return { kind: "commit-failed", error: err.message };
      throw err;
    }
    const inspection = (await handToInspector(recordHome, taskId, line, baseCommit, inspector))!;
    if (inspection.verdict === "refused") return { kind: "refused", inspection };
    const gate: GateResult = {
      green: inspection.verdict === "green",
      output: `check: delegated to Inspector - Inspector reported ${inspection.verdict}:\n${inspection.report}`,
    };
    return { kind: "verdict", gate, inspection };
  };
}

export function selfTestJudge(
  recordHome: string,
  taskId: string,
  line: ProductionLine,
  check: string,
  box: CheckBox
): Judge {
  return async (attempt) => {
    appendEvent(recordHome, { taskId, name: "check-run", details: { attempt, phase: "started", where: "worker's box" } });
    const result = await box(line.workdir, check);
    if (!result.ran) {
      appendEvent(recordHome, { taskId, name: "check-run", details: { attempt, notVerified: result.reason } });
      return { kind: "not-verified", reason: result.reason };
    }
    if (result.exitCode === COMMAND_NOT_FOUND) {
      const reason = `the box has no command the check needs (${check} -> exit ${COMMAND_NOT_FOUND})\n${result.output}`;
      appendEvent(recordHome, { taskId, name: "check-run", details: { attempt, notVerified: reason } });
      return { kind: "not-verified", reason };
    }
    const gate: GateResult = {
      green: result.exitCode === 0,
      output: `${SELF_TESTED}: ${check} -> exit ${result.exitCode}${result.output ? `\n${result.output}` : ""}`,
    };
    appendEvent(recordHome, { taskId, name: "check-run", details: { attempt, green: gate.green } });
    return { kind: "verdict", gate };
  };
}

/** Everything a round needs settled before its first attempt: who judges
 * it, and whether rule 9's check.sh comparison applies. Mode b refuses up
 * front when there is no check to run, as before; mode a needs no check
 * file of Fabrica's own. */
export function prepareRound(
  recordHome: string,
  taskId: string,
  line: ProductionLine,
  baseCommit: string,
  opts: { inspector?: Inspector; checkBox?: CheckBox; commitMessage: string }
): { judge: Judge; mode: CheckMode; protectedPathApplies: boolean } {
  const check = resolveCheckCommand(recordHome, line.project);
  const mode = chooseCheckMode(line, baseCommit, opts.inspector);
  if (mode.mode === "self-test") {
    requireCheckCommand(line.workdir, check);
    appendEvent(recordHome, { taskId, name: "inspection-skipped", details: { reason: mode.reason } });
  } else {
    // Anything Inspector can tell is missing up front (its GitHub token,
    // issue #103) refuses here, before any worker starts.
    try {
      mode.inspector.prepare?.();
    } catch (err) {
      throw new ForemanError("inspector-not-ready", err instanceof Error ? err.message : String(err));
    }
  }
  const protectedPathApplies =
    check === DEFAULT_CHECK_COMMAND && (mode.mode === "self-test" || existsSync(join(line.workdir, "check.sh")));
  if (protectedPathApplies) requireGateBaseline(line.workdir, baseCommit);

  const judge =
    mode.mode === "inspector"
      ? inspectorJudge(recordHome, taskId, line, baseCommit, mode.inspector, opts.commitMessage)
      : selfTestJudge(recordHome, taskId, line, check, opts.checkBox ?? defaultCheckBox());
  return { judge, mode, protectedPathApplies };
}

/** A round's delivery outcome from how its last attempt was judged.
 * Inspector red is inspection-red (the Client's verdict); a red self-test
 * is a failure report; a box that could not run the check is not-verified,
 * never a red. Refusals and commit failures are handled before this. */
export function roundOutcome(ctx: {
  undeclaredGateChange: boolean;
  capStopped: boolean;
  lastJudgement: Judgement;
  mode: CheckMode;
}): Delivery["outcome"] {
  if (ctx.undeclaredGateChange) return "discarded-protected-path";
  if (ctx.capStopped) return "cap-stopped";
  if (ctx.lastJudgement.kind === "not-verified") return "not-verified";
  if (ctx.lastJudgement.kind === "verdict" && ctx.lastJudgement.gate.green) return "done";
  return ctx.mode.mode === "inspector" ? "inspection-red" : "failure-report";
}
