// Issue #331: whether the `gh` login can publish one project's work.
//
// GitHub is a stand-in here (`HttpFetch` is the seam every other GitHub
// read in this repository fakes the same way) and `gh` is a real
// stand-in executable on a PATH of its own - so neither this machine's
// login nor its network decides whether a test passes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GH_STATUS_COMMAND, ghPublishAnswer } from "./gh-push.ts";
import { GH_LOGIN_COMMAND } from "./gh.ts";
import { fakeGh, noGh } from "./helpers/fake-gh.ts";
import type { HttpFetch } from "../github/index.ts";

/** A GitHub that answers one status and one body, and remembers what it
 * was asked - the URL and the headers both matter here. */
function stubGithub(status: number, body: string) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: HttpFetch = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return { status, text: async () => body };
  };
  return { fetchImpl, seen };
}

const LOGGED_IN = () => fakeGh("printf 'gho_abcdef\\n'");

test("the gh login can push: read from GitHub's own permissions, not from the login working", async () => {
  const gh = LOGGED_IN();
  const github = stubGithub(200, JSON.stringify({ permissions: { admin: false, push: true, pull: true } }));

  const answer = await ghPublishAnswer("acme", "widgets", {
    env: gh.env,
    fetchImpl: github.fetchImpl,
    apiRoot: "https://api.example.invalid",
  });

  assert.deepEqual(answer, { kind: "ok" });
  assert.equal(github.seen.length, 1);
  assert.equal(github.seen[0].url, "https://api.example.invalid/repos/acme/widgets");
  // The token `gh` printed is what the call carries - read for this one
  // call and nowhere else.
  assert.equal(github.seen[0].headers.Authorization, "Bearer gho_abcdef");
});

test("a login that cannot push is a definite no, naming the repository and the gh commands", async () => {
  const gh = LOGGED_IN();
  const github = stubGithub(200, JSON.stringify({ permissions: { push: false, pull: true } }));

  const answer = await ghPublishAnswer("acme", "widgets", { env: gh.env, fetchImpl: github.fetchImpl });

  assert.equal(answer.kind, "problem");
  assert.match(answer.kind === "problem" ? answer.detail : "", /cannot push to acme\/widgets/);
  assert.match(answer.kind === "problem" ? answer.fix : "", new RegExp(GH_STATUS_COMMAND.replace(/\./g, "\\.")));
  assert.match(answer.kind === "problem" ? answer.fix : "", /gh auth login/);
});

test("a token GitHub rejects outright says to log in again", async () => {
  const gh = LOGGED_IN();
  const github = stubGithub(401, JSON.stringify({ message: "Bad credentials" }));

  const answer = await ghPublishAnswer("acme", "widgets", { env: gh.env, fetchImpl: github.fetchImpl });

  assert.equal(answer.kind, "problem");
  assert.match(answer.kind === "problem" ? answer.detail : "", /Bad credentials/);
  assert.equal(answer.kind === "problem" ? answer.fix : "", GH_LOGIN_COMMAND);
});

for (const status of [403, 404]) {
  test(`HTTP ${status} is "this account cannot reach it", which is a definite answer`, async () => {
    // On a private repository GitHub answers 404 rather than admitting
    // it exists, so "cannot see it" and "cannot push to it" are one
    // answer to the Client - and both are definite, not unasked.
    const gh = LOGGED_IN();
    const github = stubGithub(status, "{}");

    const answer = await ghPublishAnswer("acme", "widgets", { env: gh.env, fetchImpl: github.fetchImpl });

    assert.equal(answer.kind, "problem");
    assert.match(answer.kind === "problem" ? answer.detail : "", /cannot reach acme\/widgets/);
  });
}

test("no gh at all is answered without GitHub ever being called", async () => {
  const github = stubGithub(200, JSON.stringify({ permissions: { push: true } }));

  const answer = await ghPublishAnswer("acme", "widgets", { env: noGh(), fetchImpl: github.fetchImpl });

  assert.equal(answer.kind, "problem");
  assert.match(answer.kind === "problem" ? answer.detail : "", /not installed/);
  assert.equal(github.seen.length, 0, "there is no token to make a call with");
});

// Evidence versus the absence of it (the ruling issue #304's own start
// gate was built on): a question nobody could ask is reported as
// unknown, never as "cannot push" - which would send the Client to fix
// access he already has, and would refuse his tasks every time the
// machine is offline.

test("GitHub unreachable is unknown, not a refusal", async () => {
  const gh = LOGGED_IN();
  const fetchImpl: HttpFetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  };

  const answer = await ghPublishAnswer("acme", "widgets", { env: gh.env, fetchImpl });

  assert.equal(answer.kind, "unknown");
  assert.match(answer.kind === "unknown" ? answer.detail : "", /ENOTFOUND/);
});

test("a 500 from GitHub is unknown", async () => {
  const gh = LOGGED_IN();
  const github = stubGithub(500, JSON.stringify({ message: "Server Error" }));

  const answer = await ghPublishAnswer("acme", "widgets", { env: gh.env, fetchImpl: github.fetchImpl });

  assert.equal(answer.kind, "unknown");
  assert.match(answer.kind === "unknown" ? answer.detail : "", /HTTP 500/);
});

test("an answer carrying no permissions block is unknown, never read as cannot-push", async () => {
  // `permissions` is optional in GitHub's own schema for this endpoint.
  const gh = LOGGED_IN();
  const github = stubGithub(200, JSON.stringify({ full_name: "acme/widgets" }));

  const answer = await ghPublishAnswer("acme", "widgets", { env: gh.env, fetchImpl: github.fetchImpl });

  assert.equal(answer.kind, "unknown");
  assert.match(answer.kind === "unknown" ? answer.detail : "", /no permissions/);
});

test("an answer that is not JSON is unknown", async () => {
  const gh = LOGGED_IN();
  const github = stubGithub(200, "<html>a proxy said something else</html>");

  const answer = await ghPublishAnswer("acme", "widgets", { env: gh.env, fetchImpl: github.fetchImpl });

  assert.equal(answer.kind, "unknown");
  assert.match(answer.kind === "unknown" ? answer.detail : "", /not JSON/);
});
