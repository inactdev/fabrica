// Exactly what each GitHub call Fabrica makes needs, and nothing else
// (Client ruling, issue #187's clarification 1: "the App's short-lived,
// one-repo token replaces the personal token for every GitHub call
// Fabrica makes, with exactly the permissions each call needs").
//
// One constant per call site, named after the call rather than after the
// permissions, so adding an endpoint somewhere forces a decision here
// instead of quietly riding on a set that happens to be wide enough.
// GitHub grants `metadata: read` to every installation token implicitly;
// it is not listed because it cannot be asked for or declined.

import type { AppPermission } from "./types.ts";

/** Inspector's handoff: push the task branch, open or update its pull
 * request, and post the `inspector` commit status on its head commit -
 * which is what `statuses: write` is for, added after a real handoff
 * answered 403 "Resource not accessible by integration" on that last
 * call with only the issue's own two ("only `contents: write` and
 * `pull_requests: write`"). This is the one token that crosses a process
 * boundary (into the inspector child's environment), which is why it is
 * kept to the three permissions that call genuinely needs rather than
 * sharing a wider set with the read-only calls below. */
export const PUBLISH_PERMISSIONS: Readonly<Record<string, AppPermission>> = Object.freeze({
  contents: "write",
  pull_requests: "write",
  statuses: "write",
});

/** The issue a task names, read once at registration
 * (`src/github/fetch-issue.ts`: one `GET
 * /repos/{owner}/{repo}/issues/{N}`). Read-only, and nothing else: this
 * call never touches code. */
export const READ_ISSUE_PERMISSIONS: Readonly<Record<string, AppPermission>> = Object.freeze({
  issues: "read",
});

/**
 * The checks the repository runs on the pull request itself
 * (`src/ci/`), which is five endpoints across four permissions:
 *
 *   GET /repos/{o}/{r}/pulls/{n}                     pull_requests
 *   GET /repos/{o}/{r}/commits/{sha}/check-runs      checks
 *   GET /repos/{o}/{r}/commits/{sha}/status          statuses
 *   GET /repos/{o}/{r}/actions/runs?head_sha=...     actions
 *   GET /repos/{o}/{r}/actions/runs/{id}/jobs        actions
 *   GET /repos/{o}/{r}/actions/jobs/{id}/logs        actions
 *
 * `actions: read` is here even though the Client's list named only
 * checks, statuses and pull requests: the last three endpoints are the
 * job-log tail a red check carries into the Client's own report
 * (`src/ci/logs.ts`), and that module answers an unreadable log with
 * `null`. Without this permission every red check would quietly arrive
 * with no log, which is the silent skip the standing rulings forbid.
 * All four are read-only - nothing in `src/ci/` can write.
 */
export const READ_CHECKS_PERMISSIONS: Readonly<Record<string, AppPermission>> = Object.freeze({
  pull_requests: "read",
  checks: "read",
  statuses: "read",
  actions: "read",
});

// `fabrica doctor` has no entry here on purpose, and still does not,
// even though it mints now. Its first two questions - does this key
// work, and where is the App installed - are answered by
// JWT-authenticated endpoints (`GET /app`, `GET
// /repos/{owner}/{repo}/installation`) and need no token at all. Its
// third (issue #304: would a publishing token actually be allowed to
// publish?) can only be answered off a real grant, so it mints
// `PUBLISH_PERMISSIONS` above - deliberately the very set it is
// checking, never a wider "preflight" set of its own. It attempts no
// write with it, reads nothing off it but `permissions`, and discards
// it; see `publish-permissions.ts`.
