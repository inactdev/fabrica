// ForemanError: every refusal this module produces carries a `code` for
// callers that need to branch on it, and a `message` written to be shown
// to the Client verbatim.

export type ForemanErrorCode =
  | "no-brain"
  | "invalid-attempts"
  | "invalid-issue"
  /** `--issue` named a real-looking issue that could not be read before
   * the task started: no GitHub repository to resolve it against, no
   * token, GitHub unreachable, no such issue, or one past the ceiling
   * for an issue carried into a brief. Carries the cause verbatim -
   * see src/foreman/task-issue.ts. */
  | "issue-unavailable"
  /** A project names knowledge-base notes (projects.toml's
   * `[projects.<name>.knowledge]`) that could not be carried into the
   * brief: the knowledge base is not there, it has no `notes/` folder, a
   * named note has no file, a named note has no front-matter title, or
   * the brief would be past its size ceiling with them in. Raised before
   * any ProductionLine is cut - see src/foreman/task-knowledge.ts. */
  | "knowledge-unavailable"
  /** A file this task was handed (`fabrica do --file <path>`, issue
   * #325) could not be carried into the workstation: a named path has
   * nothing readable at it, is not a regular file, is named
   * `.gitignore`, shares its file name with another of the task's
   * files, or the copy itself failed. Also a `files.json` nothing can
   * parse. Raised at registration for a path that was wrong from the
   * start, and before any ProductionLine is cut for one that has gone
   * missing since - see src/foreman/task-files.ts. */
  | "attached-unavailable"
  /** The project commits a `tests.map` whose own text cannot be read - a
   * line that is not `pattern: tests`. Refused rather than skipped: a
   * half-read map would name fewer tests in the brief and report more
   * touched files as unmapped, both without anyone being told. Raised
   * before any ProductionLine is cut, like `knowledge-unavailable`, and
   * carries src/testmap's own message, which names the line to edit -
   * see src/foreman/test-map.ts. */
  | "test-map-unreadable"
  | "missing-check"
  /** A project has no github.com repository to mint a scoped token for
   * (issue #187): no `origin` remote, an origin on another host, or one
   * whose URL names no owner/repo. Nothing can be pushed or published
   * from such a project, so it is refused rather than started - see
   * src/foreman/github-token.ts. */
  | "no-github-repo"
  /** GitHub would mint this project's publishing token short of what
   * publishing needs (issue #304): the App does not hold a permission
   * `PUBLISH_PERMISSIONS` asks for, or the installation never accepted
   * it. Raised at task start, before any machine runs, from the granted
   * permissions on a real minted token - no write is attempted. Carries
   * the shortfall and the exact App setting to change; the same words
   * `fabrica doctor`'s github-app line says. See
   * src/foreman/publish-permissions.ts. */
  | "publish-not-permitted"
  /** A project reaches GitHub with its own token (projects.toml's
   * `githubTokenVar`, issue #314) and that token could not be read: the
   * variable it names is set nowhere, or `brain.env` can be read by
   * other users on this machine. Refused rather than published with
   * some other credential - the App is never a fallback for a project
   * that names a token. Carries the line to add, or the `chmod`. See
   * src/projecttoken/. */
  | "project-token-unavailable"
  | "inspector-not-ready"
  /** The installed Inspector is known to refuse this project's
   * configuration (issue #306): `.inspector.json` still carries a
   * retired `image` or `network` key, or no `Dockerfile.inspector` is
   * committed for the check box to be built from. Raised before any
   * machine runs, from the config as it stands at the task's own base
   * commit, and carries Inspector's own words plus the Client's hand
   * fix - Fabrica never edits either file. See
   * src/foreman/inspector-config.ts. */
  | "inspector-config-refused"
  /** No reviewer could be settled for a project whose test changes need
   * one judged - see src/reviewer/resolve.ts for the three grounds. */
  | "reviewer-not-ready"
  | "project-not-a-repo"
  | "commit-failed"
  | "unknown-task"
  | "not-delivered"
  | "inspection-refused"
  | "already-closed"
  | "invalid-verdict"
  | "missing-note"
  | "no-questions-pending"
  | "already-answered"
  | "missing-answer"
  /** Issue #176: the clarifying step never asked in the fixed shape -
   * one question with two to four options - across its first call and
   * both re-asks. Carries the last rejection's own words. The pass fails
   * rather than silently proceeding as though nothing needed asking. */
  | "ask-shape-invalid"
  /** `fabrica answer --question <id>` named an id this task never asked
   * (issue #175). Lists the ids it did ask. */
  | "unknown-question"
  /** `fabrica answer --option <n>` named an option the question does not
   * have, or paired a listed option with words of the Client's own,
   * which would leave two answers to one question. */
  | "invalid-option"
  | "cap-refused"
  /** Issue #189's pause rule refused to start anything: a subscription
   * meter is past its refuse threshold. Carries the numbers and the
   * threshold in its message. Not a cap refusal - that one is about
   * dollars, this one about a flat-rate subscription's own window. */
  | "meter-refused"
  | "spend-unknown"
  | "invalid-cost"
  | "nothing-to-record"
  /** `stop` (issue #203) on a task that isn't running - already
   * delivered, already closed, waiting on an answer, or never started. */
  | "not-running"
  /** A model call failed twice (issue #199): it failed the way a
   * dropped connection fails, was retried once on the same model after
   * a short wait, and failed again. Carries the model, the first
   * failure's kind and the second failure's own words - see
   * src/foreman/transport-retry.ts. No model is ever swapped in to
   * recover from this; the task stops instead. */
  | "model-call-failed"
  /** The network a Worker's box was running on is gone (2026-10-18): its
   * task's own relay container stopped serving mid-attempt, so every
   * request the box makes is refused by an address with nothing
   * listening. Carries what the relay watcher reported, which names the
   * relay - a worker left to discover this itself says only
   * "ConnectionRefused", minutes later, if at all. */
  | "worker-network-gone";

export class ForemanError extends Error {
  readonly code: ForemanErrorCode;

  constructor(code: ForemanErrorCode, message: string) {
    super(message);
    this.name = "ForemanError";
    this.code = code;
  }
}

// Same shape as src/line/safety.ts's describeGitError — duplicated locally
// on purpose rather than imported across module boundaries.
export function describeGitError(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string } | undefined)?.stderr;
  if (stderr && stderr.toString().trim().length > 0) return stderr.toString().trim();
  return err instanceof Error ? err.message : String(err);
}
