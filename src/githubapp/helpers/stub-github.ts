// A stub GitHub that behaves the way GitHub documents, for the tests in
// this module and for the scoping proof issue #187 asks for.
//
// A real local HTTP server rather than a hand-rolled `fetch` double,
// for the same reason `src/ci/helpers/fake-github.ts` is one: the thing
// under test is a set of HTTP calls, and a double that answers them
// cannot catch a malformed request line, a missing header, or a body
// that is not the JSON it claims to be.
//
// Two behaviours it models deliberately, because they are the two the
// whole design rests on:
//
//   1. The App's JWT is *verified*, with the matching public key and
//      against its own `exp` - so a test failure means GitHub would
//      really have rejected the token, not merely that it looked
//      different from expected.
//   2. An installation token is *scoped*: the repositories a mint named
//      are remembered against the token it issued, and a request for
//      any other repository with that token answers 404, exactly as
//      GitHub does. That is what makes "the minted token cannot read a
//      second repo" a test rather than an assertion about intent.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createVerify } from "node:crypto";
import { AddressInfo } from "node:net";

export interface StubGithubOptions {
  /** The public half of the key the App signs with. Every JWT is
   * verified against it. */
  publicKeyPem: string;
  /** The App id the JWT's `iss` must carry. */
  appId: string;
  /** Which repositories each installation covers, as
   * `{ "<id>": ["owner/repo", ...] }`. A repository in no installation
   * answers 404 to the installation lookup. */
  installations: Record<number, string[]>;
  /** `installations_count` for `GET /app`. Defaults to however many
   * installations are declared. */
  installationsCount?: number;
  /** The App's own permissions. A mint asking for anything outside this
   * is refused 422, the way GitHub refuses a token that would exceed
   * what the App holds. Defaults to "whatever was asked for". */
  appPermissions?: Record<string, string>;
  /** GitHub's *other* answer to a mint asking for more than the App
   * holds: 201, with the permission simply absent from the response's
   * `permissions` map (issue #304 - the behaviour four green tasks were
   * lost to on 2026-10-27, where the mint succeeded and only the
   * `statuses` write was missing). GitHub's reference documents the
   * ceiling ("The installation access token cannot be granted
   * permissions that the app was not granted") and both a 201 and a
   * 422, but not which one it picks when, so the stub models both and
   * Fabrica has to survive both. Needs `appPermissions`; without it
   * every mint is granted in full and there is nothing to narrow. */
  narrowSilently?: boolean;
  /** Forced answers, for the refusal paths: `{ "/app": 401 }`. The
   * body is GitHub's own `{ message }` shape. */
  force?: Record<string, { status: number; body?: string }>;
  /** Issues the stub serves, as `{ "owner/repo#1": { title, body } }` -
   * so a scoping test can drive Fabrica's real issue reader against it
   * rather than a second, test-only endpoint. */
  issues?: Record<string, { title: string; body?: string }>;
  /** Comments on those issues, keyed the same way. Absent means an issue
   * with no comments, which is what the issue reader's second call then
   * reads - it always makes that call, so the endpoint exists whether a
   * test declares any comments or not. */
  comments?: Record<string, { author: string; postedAt: string; body: string }[]>;
}

export interface StubRequest {
  method: string;
  path: string;
  authorization: string | null;
  accept: string | null;
  apiVersion: string | null;
  userAgent: string | null;
  contentType: string | null;
  body: string;
}

export interface StubGithub {
  baseUrl: string;
  requests: StubRequest[];
  /** Every mint this stub granted, as `{ token, repositories,
   * permissions, installationId }` - the scope it will then enforce. */
  granted: { token: string; repositories: string[]; permissions: Record<string, string>; installationId: number }[];
  close(): Promise<void>;
}

/** Seconds since the epoch, as a JWT's own claims are measured. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Verifies one JWT the way GitHub's own documentation says it is
 * signed and bounded. Returns null when it is acceptable, or the
 * complaint when it is not. */
function jwtProblem(authorization: string | null, opts: StubGithubOptions): string | null {
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    return "A JWT must be passed as `Authorization: Bearer <jwt>`.";
  }
  const segments = authorization.slice("Bearer ".length).split(".");
  if (segments.length !== 3) return "Not a JWT.";
  const [header, payload, signature] = segments;
  const decode = (segment: string) =>
    JSON.parse(Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  let claims: { iat?: number; exp?: number; iss?: string };
  try {
    if (decode(header).alg !== "RS256") return "A JWT must be signed with RS256.";
    claims = decode(payload);
  } catch {
    return "A JWT's header and payload must be base64url-encoded JSON.";
  }
  const ok = createVerify("RSA-SHA256")
    .update(`${header}.${payload}`)
    .verify(opts.publicKeyPem, Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  if (!ok) return "A JWT could not be decoded.";
  if (claims.iss !== opts.appId) return "A JWT could not be decoded.";
  const now = nowSeconds();
  if (typeof claims.exp !== "number" || claims.exp <= now) return "Expiration time' claim ('exp') must be a numeric value representing the future time at which the assertion expires.";
  if (claims.exp - now > 600) return "'Expiration time' claim ('exp') is too far in the future.";
  if (typeof claims.iat !== "number" || claims.iat > now) return "'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued.";
  return null;
}

export async function startStubGithub(opts: StubGithubOptions): Promise<StubGithub> {
  const requests: StubRequest[] = [];
  const granted: StubGithub["granted"] = [];
  let nextToken = 1;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const path = req.url ?? "";
      // The issue reader's comments call carries `per_page`/`page`, so
      // every route below is matched against the path without its query
      // string - GitHub routes the same way.
      const route = path.split("?")[0];
      const authorization = header(req, "authorization");
      requests.push({
        method: req.method ?? "",
        path,
        authorization,
        accept: header(req, "accept"),
        apiVersion: header(req, "x-github-api-version"),
        userAgent: header(req, "user-agent"),
        contentType: header(req, "content-type"),
        body,
      });

      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      };

      const forced = opts.force?.[route];
      if (forced !== undefined) {
        send(forced.status, forced.body ?? JSON.stringify({ message: "forced" }));
        return;
      }

      // --- App-authenticated endpoints (JWT) ---------------------------
      if (route === "/app" || route.endsWith("/installation") || route.endsWith("/access_tokens")) {
        const problem = jwtProblem(authorization, opts);
        if (problem !== null) {
          send(401, { message: problem });
          return;
        }
      }

      if (route === "/app") {
        send(200, {
          slug: "fabrica-stub",
          name: "Fabrica (stub)",
          installations_count: opts.installationsCount ?? Object.keys(opts.installations).length,
        });
        return;
      }

      const installationLookup = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(route);
      if (installationLookup) {
        const key = `${decodeURIComponent(installationLookup[1])}/${decodeURIComponent(installationLookup[2])}`;
        const found = Object.entries(opts.installations).find(([, repos]) => repos.includes(key));
        if (found === undefined) {
          send(404, { message: "Not Found" });
          return;
        }
        send(200, { id: Number(found[0]) });
        return;
      }

      const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(route);
      if (mint) {
        const installationId = Number(mint[1]);
        const covered = opts.installations[installationId];
        if (covered === undefined) {
          send(404, { message: "Not Found" });
          return;
        }
        let asked: { repositories?: unknown; permissions?: unknown };
        try {
          asked = JSON.parse(body);
        } catch {
          send(422, { message: "Invalid request." });
          return;
        }
        const permissions = (asked.permissions ?? {}) as Record<string, string>;
        // GitHub documents that a token "cannot exceed" the App's own
        // permissions, without documenting which of its two answers it
        // gives: a 422 refusal naming the permission (this branch), or a
        // 201 that quietly leaves it off the grant (`narrowSilently`,
        // below - what actually happened on 2026-10-27).
        if (opts.appPermissions !== undefined && !opts.narrowSilently) {
          const beyond = Object.keys(permissions).filter((key) => opts.appPermissions![key] === undefined);
          if (beyond.length > 0) {
            send(422, { message: `The permissions requested are not granted to this installation: ${beyond.join(", ")}.` });
            return;
          }
        }
        const requested = Array.isArray(asked.repositories) ? (asked.repositories as string[]) : null;
        // A mint naming no repositories reaches every repository the
        // installation has - the documented behaviour this module exists
        // to never rely on.
        const names = requested === null ? covered.map((key) => key.split("/")[1]) : requested;
        const scoped = covered.filter((key) => names.includes(key.split("/")[1]));
        const token = `ghs_stub_${nextToken++}`;
        granted.push({ token, repositories: scoped, permissions, installationId });
        send(201, {
          token,
          expires_at: new Date((nowSeconds() + 3600) * 1000).toISOString(),
          permissions: opts.appPermissions === undefined ? permissions : narrow(permissions, opts.appPermissions),
          repository_selection: requested === null ? "all" : "selected",
          repositories: scoped.map((key) => ({ full_name: key })),
        });
        return;
      }

      // --- Installation-token endpoints (the scope is enforced) --------
      //
      // Both of the issue reader's calls land here, and both are scoped
      // the same way: a token minted for one repository is turned away
      // from a second one with 404, exactly as GitHub turns it away.
      /** Whether `token` may read `key`, or null for "it may". */
      const outOfScope = (key: string): boolean => {
        const token = (authorization ?? "").replace(/^Bearer /, "");
        const grant = granted.find((g) => g.token === token);
        return grant === undefined || !grant.repositories.includes(key);
      };

      const comments = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(route);
      if (comments) {
        const key = `${decodeURIComponent(comments[1])}/${decodeURIComponent(comments[2])}`;
        if (outOfScope(key)) {
          send(404, { message: "Not Found" });
          return;
        }
        const stored = opts.comments?.[`${key}#${comments[3]}`] ?? [];
        send(
          200,
          stored.map((entry) => ({
            user: { login: entry.author, type: "User" },
            created_at: entry.postedAt,
            updated_at: entry.postedAt,
            body: entry.body,
            html_url: `https://github.com/${key}/issues/${comments[3]}#issuecomment-1`,
          }))
        );
        return;
      }

      const issue = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(route);
      if (issue) {
        const key = `${decodeURIComponent(issue[1])}/${decodeURIComponent(issue[2])}`;
        // Exactly what GitHub does for a repository outside the token's
        // scope: 404, indistinguishable from "no such repository".
        if (outOfScope(key)) {
          send(404, { message: "Not Found" });
          return;
        }
        const stored = opts.issues?.[`${key}#${issue[3]}`];
        if (stored === undefined) {
          send(404, { message: "Not Found" });
          return;
        }
        send(200, {
          number: Number(issue[3]),
          title: stored.title,
          body: stored.body ?? null,
          html_url: `https://github.com/${key}/issues/${issue[3]}`,
        });
        return;
      }

      send(404, { message: "Not Found" });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    granted,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The grant GitHub reports: never more than the App holds. A key the
 * App holds at `read` where `write` was asked comes back as `read`; a
 * key it does not hold at all is left off the map entirely, which is the
 * answer only reachable with `narrowSilently` (the 422 branch above
 * intercepts it otherwise). */
function narrow(asked: Record<string, string>, held: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, level] of Object.entries(asked)) {
    if (held[key] === undefined) continue;
    out[key] = held[key] === "read" ? "read" : level;
  }
  return out;
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === "string" ? value : null;
}
