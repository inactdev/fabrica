// The shape of a cut ProductionLine.
// LANGUAGE.md: "ProductionLine — one task's disposable lane: a throwaway
// copy of the project where the Worker and the checks run as stations.
// Built for one task, torn down after."

/** A created, live ProductionLine: a linked git worktree of `project`. */
export interface ProductionLine {
  taskId: string;
  /** `fabrica/<taskId>` — left intact after teardown for the Client to review. */
  branch: string;
  /** Resolved root of the Client's own checkout. Never written to. */
  project: string;
  /** The throwaway worktree — every Worker and check runs here. */
  workdir: string;
  /** Resolved record home the workdir was created under (`recordHome/tasks/<taskId>/worktree`). */
  recordHome: string;
}
