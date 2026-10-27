// The three calls, against a stub GitHub that verifies the App's JWT
// and enforces the scope of every token it issues.
//
// The test issue #187 names - "a test proves the minted token cannot
// read a second repo" - is here, twice over: once on the request
// (`repositories` names exactly one repository, never omitted), and once
// on the outcome, by driving Fabrica's own issue reader with a minted
// token against a repository that token does not cover and watching it
// get the 404 GitHub really answers. This one runs on every `npm test`;
// the same proof against the real App and two real fixture
// repositories is `live.test.ts`, behind an environment flag.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubAppError } from "./errors.ts";
import { GITHUB_API_VERSION, appIdentity, describePermissions, installationIdFor, mintInstallationToken } from "./mint.ts";
import { defaultTokenMinter } from "./minter.ts";
import { PUBLISH_PERMISSIONS, READ_CHECKS_PERMISSIONS, READ_ISSUE_PERMISSIONS } from "./scopes.ts";
import { APP_ID_VAR, APP_KEY_VAR } from "./config.ts";
import { startStubGithub, type StubGithub, type StubGithubOptions } from "./helpers/stub-github.ts";
import { testKeyPair } from "./helpers/test-key.ts";
import { fetchIssue, fetchIssueComments } from "../github/index.ts";
import type { HttpFetch } from "../github/index.ts";

const APP_ID = "Iv1.stub";
const WIDGETS = { owner: "acme", repo: "widgets", permissions: PUBLISH_PERMISSIONS };
const VAULT = { owner: "acme", repo: "vault", permissions: PUBLISH_PERMISSIONS };

const KEYS = testKeyPair();

async function stub(overrides: Partial<StubGithubOptions> = {}): Promise<StubGithub> {
  return startStubGithub({
    publicKeyPem: KEYS.publicKeyPem,
    appId: APP_ID,
    installations: { 7: ["acme/widgets", "acme/vault"] },
    ...overrides,
  });
}

function credentials() {
  return { appId: APP_ID, keyPath: "/dev/null/fake.pem", privateKeyPem: KEYS.privateKeyPem };
}

test("GET /app carries the documented headers and a JWT GitHub accepts", async () => {
  const github = await stub();
  try {
    const identity = await appIdentity({ credentials: credentials(), apiRoot: github.baseUrl });

    assert.deepEqual(identity, { slug: "fabrica-stub", name: "Fabrica (stub)", installations: 1 });
    const request = github.requests.at(-1)!;
    assert.equal(request.method, "GET");
    assert.equal(request.path, "/app");
    assert.equal(request.accept, "application/vnd.github+json");
    assert.equal(request.apiVersion, GITHUB_API_VERSION);
    assert.equal(request.userAgent, "fabrica");
    assert.match(request.authorization ?? "", /^Bearer ey/);
  } finally {
    await github.close();
  }
});

test("the mint names exactly one repository and exactly the permissions asked for", async () => {
  const github = await stub();
  try {
    const minted = await mintInstallationToken({ credentials: credentials(), apiRoot: github.baseUrl, scope: WIDGETS });

    assert.equal(minted.owner, "acme");
    assert.equal(minted.repo, "widgets");
    assert.equal(minted.installationId, 7);
    assert.equal(minted.repositorySelection, "selected");
    assert.deepEqual(minted.permissions, { contents: "write", pull_requests: "write", statuses: "write" });
    assert.match(minted.expiresAt, /^\d{4}-\d\d-\d\dT/);

    const post = github.requests.find((r) => r.method === "POST")!;
    assert.equal(post.path, "/app/installations/7/access_tokens");
    assert.equal(post.contentType, "application/json");
    // `repositories` is never omitted: GitHub documents that omitting it
    // grants every repository the installation has.
    assert.deepEqual(JSON.parse(post.body), {
      repositories: ["widgets"],
      permissions: { contents: "write", pull_requests: "write", statuses: "write" },
    });
  } finally {
    await github.close();
  }
});

// Issue #187's "done when": a test proves the minted token cannot read a
// second repo. Driven through src/github's real issue reader, so what is
// proved is what Fabrica actually does with a token, not what this
// module believes about it.
test("a token minted for one repository is refused on a second one the same installation covers", async () => {
  const github = await stub({
    issues: { "acme/widgets#1": { title: "widgets issue" }, "acme/vault#1": { title: "vault issue" } },
    // Both of the reader's calls are covered on purpose: an issue is
    // only readable if its comments are too (src/github/fetch-comments.ts
    // refuses a half-read issue), so a scope that let one through and
    // not the other would show up here rather than in a task.
    comments: { "acme/widgets#1": [{ author: "ari", postedAt: "2026-10-25T09:00:00Z", body: "an amendment" }] },
  });
  try {
    const { token } = await mintInstallationToken({
      credentials: credentials(),
      apiRoot: github.baseUrl,
      scope: { ...WIDGETS, permissions: READ_ISSUE_PERMISSIONS },
    });
    const read = (owner: string, repo: string) =>
      fetchIssue({ owner, repo, number: 1 }, { token, fetchImpl: fetch as HttpFetch, apiRoot: github.baseUrl });

    // The repository it was minted for: readable, comments and all.
    const widgets = await read("acme", "widgets");
    assert.equal(widgets.title, "widgets issue");
    assert.deepEqual(
      widgets.comments.map((c) => c.body),
      ["an amendment"]
    );

    // A second repository the SAME installation covers - so this is the
    // token's own scope turning it away, not the installation's.
    await assert.rejects(
      () => read("acme", "vault"),
      (err: unknown) => err instanceof Error && /no issue acme\/vault#1 this token can read/.test(err.message)
    );

    // And the reader's second call is refused on that repository in its
    // own right, not only because the first one failed first.
    await assert.rejects(
      () =>
        fetchIssueComments(
          { owner: "acme", repo: "vault", number: 1 },
          { token, fetchImpl: fetch as HttpFetch, apiRoot: github.baseUrl }
        ),
      (err: unknown) => err instanceof Error && /no comments on issue acme\/vault#1 this token can read/.test(err.message)
    );

    assert.deepEqual(github.granted.at(-1)!.repositories, ["acme/widgets"]);
  } finally {
    await github.close();
  }
});

test("GitHub narrowing a permission is recorded as what it granted, never as what was asked", async () => {
  // An App holding only `contents: read` cannot mint `contents: write`.
  const github = await stub({ appPermissions: { contents: "read", pull_requests: "write", statuses: "write" } });
  try {
    const minted = await mintInstallationToken({
      credentials: credentials(),
      apiRoot: github.baseUrl,
      scope: WIDGETS,
    });
    assert.deepEqual(minted.permissions, { contents: "read", pull_requests: "write", statuses: "write" });
  } finally {
    await github.close();
  }
});

test("a repository the App is not installed on refuses by name, with the install step", async () => {
  const github = await stub({ installations: { 7: ["someone-else/thing"] } });
  try {
    await assert.rejects(
      () => mintInstallationToken({ credentials: credentials(), apiRoot: github.baseUrl, scope: WIDGETS }),
      (err: unknown) =>
        err instanceof GithubAppError &&
        err.code === "app-not-installed" &&
        err.message.includes("acme/widgets") &&
        err.message.includes("Install App")
    );
  } finally {
    await github.close();
  }
});

test("a permission the App itself does not hold refuses, naming the permissions and how to grant them", async () => {
  const github = await stub({ appPermissions: { contents: "write" } });
  try {
    await assert.rejects(
      () =>
        mintInstallationToken({
          credentials: credentials(),
          apiRoot: github.baseUrl,
          scope: { ...WIDGETS, permissions: READ_CHECKS_PERMISSIONS },
        }),
      (err: unknown) =>
        err instanceof GithubAppError &&
        err.code === "mint-refused" &&
        err.message.includes("Repository permissions") &&
        // GitHub's own explanation, forwarded verbatim.
        err.message.includes("not granted to this installation")
    );
  } finally {
    await github.close();
  }
});

test("a rejected key refuses, naming the key file rather than the status alone", async () => {
  const github = await stub({ force: { "/app": { status: 401, body: JSON.stringify({ message: "Bad credentials" }) } } });
  try {
    await assert.rejects(
      () => appIdentity({ credentials: credentials(), apiRoot: github.baseUrl }),
      (err: unknown) =>
        err instanceof GithubAppError &&
        err.code === "mint-refused" &&
        err.message.includes("/dev/null/fake.pem") &&
        err.message.includes("Bad credentials")
    );
  } finally {
    await github.close();
  }
});

test("an answer that is not JSON is unreachable, not a refusal to act on", async () => {
  const github = await stub({ force: { "/app": { status: 200, body: "<html>maintenance</html>" } } });
  try {
    await assert.rejects(
      () => appIdentity({ credentials: credentials(), apiRoot: github.baseUrl }),
      (err: unknown) => err instanceof GithubAppError && err.code === "mint-unreachable"
    );
  } finally {
    await github.close();
  }
});

test("GitHub unreachable at all is mint-unreachable naming the call, never the url's headers", async () => {
  await assert.rejects(
    () =>
      appIdentity({
        credentials: credentials(),
        apiRoot: "http://127.0.0.1:1",
        fetchImpl: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:1");
        },
      }),
    (err: unknown) =>
      err instanceof GithubAppError && err.code === "mint-unreachable" && err.message.includes("GET /app")
  );
});

test("the installation lookup happens once per repository, however many tokens are minted for it", async () => {
  const github = await stub();
  const dir = mkdtempSync(join(tmpdir(), "fabrica-gh-app-minter-"));
  const keyPath = join(dir, "key.pem");
  writeFileSync(keyPath, KEYS.privateKeyPem);
  chmodSync(keyPath, 0o600);
  try {
    const seen: string[] = [];
    const minter = defaultTokenMinter({
      recordHome: dir,
      env: { [APP_ID_VAR]: APP_ID, [APP_KEY_VAR]: keyPath },
      apiRoot: github.baseUrl,
      onMinted: (minted, purpose) => seen.push(`${purpose} ${minted.owner}/${minted.repo}`),
    });

    minter.requireConfigured();
    await minter.mint("publish", WIDGETS);
    await minter.mint("read-checks", { ...WIDGETS, permissions: READ_CHECKS_PERMISSIONS });
    await minter.mint("publish", VAULT);

    assert.deepEqual(seen, ["publish acme/widgets", "read-checks acme/widgets", "publish acme/vault"]);
    // Two repositories, two lookups - not one per mint. An installation
    // id is a public fact about the App, not a credential, so it is the
    // one thing worth remembering (see minter.ts).
    const lookups = github.requests.filter((r) => r.path.endsWith("/installation")).map((r) => r.path);
    assert.deepEqual(lookups, ["/repos/acme/widgets/installation", "/repos/acme/vault/installation"]);
    // Three mints, three distinct tokens: nothing is reused.
    assert.equal(new Set(github.granted.map((g) => g.token)).size, 3);
  } finally {
    await github.close();
  }
});

test("installationIdFor answers the id, and a non-numeric answer is unreachable rather than a guess", async () => {
  const github = await stub({
    force: { "/repos/acme/widgets/installation": { status: 200, body: JSON.stringify({ id: "seven" }) } },
  });
  try {
    assert.equal(await installationIdFor({ credentials: credentials(), apiRoot: github.baseUrl }, "acme", "vault"), 7);
    await assert.rejects(
      () => installationIdFor({ credentials: credentials(), apiRoot: github.baseUrl }, "acme", "widgets"),
      (err: unknown) => err instanceof GithubAppError && err.code === "mint-unreachable"
    );
  } finally {
    await github.close();
  }
});

test("describePermissions reads the same for the same set, whatever order it was built in", () => {
  assert.equal(describePermissions(PUBLISH_PERMISSIONS), "contents: write, pull_requests: write, statuses: write");
  assert.equal(describePermissions({ statuses: "write", pull_requests: "write", contents: "write" }), "contents: write, pull_requests: write, statuses: write");
  assert.equal(describePermissions({}), "no permissions");
});

test("the four permission sets are exactly what each call needs, and no set can write what it only reads", () => {
  assert.deepEqual(PUBLISH_PERMISSIONS, { contents: "write", pull_requests: "write", statuses: "write" });
  assert.deepEqual(READ_ISSUE_PERMISSIONS, { issues: "read" });
  assert.deepEqual(READ_CHECKS_PERMISSIONS, {
    pull_requests: "read",
    checks: "read",
    statuses: "read",
    actions: "read",
  });
  for (const set of [READ_ISSUE_PERMISSIONS, READ_CHECKS_PERMISSIONS]) {
    assert.ok(Object.values(set).every((level) => level === "read"), "a read-only call asked for write");
  }
});
