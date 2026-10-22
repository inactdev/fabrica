// A fake GitHub for this module's tests: a real local HTTP server on
// 127.0.0.1, answering the exact endpoints `src/ci/` reads, so the tests
// exercise the real client - headers, status codes, the log download's
// 302 and all - without ever touching github.com.
//
// Test-only fixture: deliberately not exported from `src/ci/index.ts`.

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

/** One poll tick's worth of answers. The LAST entry of each list repeats
 * for every tick after it, so a test scripts only what changes. */
export interface FakeGithubPlan {
  sha?: string;
  /** `check_runs` for successive reads. */
  checkRuns?: unknown[][];
  /** `statuses` for successive reads. */
  statuses?: unknown[][];
  /** Workflow runs on the head commit, for the job-log lookup. */
  workflowRuns?: { id: number }[];
  /** Jobs per workflow run id. */
  jobs?: Record<number, { id: number; check_run_url: string }[]>;
  /** Job log bodies, by job id. A job with no entry answers 404. */
  logs?: Record<number, string>;
  /** When set, EVERY api route answers this status instead - the
   * unreadable path. */
  failWith?: number;
}

export interface FakeGithub {
  /** Base url to hand `createGithubReader`/`pollPullRequestChecks`. */
  readonly baseUrl: string;
  /** Every request this server saw: path, and the Authorization header
   * if one was sent. The blob route is included, which is how the test
   * that proves the token is never forwarded to it reads. */
  readonly requests: readonly { path: string; authorization: string | null }[];
  close(): Promise<void>;
}

export async function startFakeGithub(plan: FakeGithubPlan): Promise<FakeGithub> {
  const requests: { path: string; authorization: string | null }[] = [];
  const sha = plan.sha ?? "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  let checkRunReads = 0;
  let statusReads = 0;

  const pick = <T>(lists: T[][] | undefined, read: number): T[] => {
    if (!lists || lists.length === 0) return [];
    return lists[Math.min(read, lists.length - 1)];
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "";
    requests.push({ path, authorization: req.headers.authorization ?? null });

    const json = (body: unknown): void => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    // The blob the log route redirects to - never behind failWith, since
    // it is not a GitHub API route at all.
    const blob = /^\/blob\/(\d+)$/.exec(path);
    if (blob !== null) {
      const body = plan.logs?.[Number(blob[1])];
      if (body === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(body);
      return;
    }

    if (plan.failWith !== undefined) {
      res.writeHead(plan.failWith, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "fake refusal" }));
      return;
    }

    if (/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(path)) {
      json({ number: 1, state: "open", head: { sha } });
      return;
    }
    if (path.includes("/check-runs")) {
      const list = pick(plan.checkRuns, checkRunReads++);
      json({ total_count: list.length, check_runs: list });
      return;
    }
    if (/\/commits\/[^/]+\/status/.test(path)) {
      const list = pick(plan.statuses, statusReads++);
      json({ state: "pending", total_count: list.length, statuses: list, sha });
      return;
    }
    if (/\/actions\/runs\?/.test(path)) {
      const runs = plan.workflowRuns ?? [];
      json({ total_count: runs.length, workflow_runs: runs });
      return;
    }
    const runJobs = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs/.exec(path);
    if (runJobs !== null) {
      const jobs = plan.jobs?.[Number(runJobs[1])] ?? [];
      json({ total_count: jobs.length, jobs });
      return;
    }
    const logs = /^\/repos\/[^/]+\/[^/]+\/actions\/jobs\/(\d+)\/logs$/.exec(path);
    if (logs !== null) {
      res.writeHead(302, { location: `${baseUrl()}/blob/${logs[1]}` });
      res.end();
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: `fake GitHub has no route for ${path}` }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake GitHub did not bind a port");
  const port = address.port;
  function baseUrl(): string {
    return `http://127.0.0.1:${port}`;
  }

  return {
    baseUrl: baseUrl(),
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A completed check run, as GitHub's own shape. */
export function checkRun(
  name: string,
  conclusion: string,
  opts: { id?: number; url?: string } = {}
): Record<string, unknown> {
  return {
    id: opts.id ?? 1,
    name,
    status: "completed",
    conclusion,
    html_url: opts.url ?? `https://github.com/o/r/runs/${opts.id ?? 1}`,
    details_url: null,
  };
}

/** A check run that has not answered yet. */
export function runningCheckRun(name: string, opts: { id?: number; status?: string } = {}): Record<string, unknown> {
  return {
    id: opts.id ?? 2,
    name,
    status: opts.status ?? "in_progress",
    conclusion: null,
    html_url: `https://github.com/o/r/runs/${opts.id ?? 2}`,
    details_url: null,
  };
}

/** A commit status, as GitHub's own shape. */
export function commitStatus(context: string, state: string, targetUrl: string | null = null): Record<string, unknown> {
  return { context, state, target_url: targetUrl, description: null, id: 1 };
}

/** A clock a test drives with `sleep` instead of waiting, so a whole
 * expired wait costs no real time. */
export function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let at = 0;
  return {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms;
    },
  };
}
