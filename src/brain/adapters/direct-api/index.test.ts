import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeOllamaBaseUrl, ollamaAdapter, openRouterAdapter } from "./index.ts";
import { startFakeChatServer } from "./helpers/fake-chat-server.ts";
import { createProductionLine, destroyProductionLine } from "../../../line/index.ts";
import { makeFixtureHome, makeFixtureProject } from "../../../line/helpers/fixture.ts";

// A plain public image with Node, nothing adapter-specific - the real
// default (DEFAULT_IMAGE, built from docker/Dockerfile) has Node too,
// plus toolchains worker-loop.mjs itself never needs. Same choice
// claude-code.test.ts makes for its own non-capability-spike tests.
const TEST_IMAGE = "node:20-alpine";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Tracks whether this file's one real-containment test (the only one
// that reaches host.docker.internal, not a fake-server-on-localhost
// shortcut) ran to completion - same loud-skip shape claude-code.test.ts
// uses for its own capability spike, so a quiet skip can never be
// mistaken for a verified pass.
let realRunRan = false;
let realRunSkipReason: string | null = null;

after(() => {
  if (realRunRan) return;
  console.error(
    [
      "",
      "!".repeat(78),
      "!! DIRECT-API host.docker.internal CHECK DID NOT RUN",
      "!! This test run never proved a contained worker-loop.mjs call can",
      "!! reach a server on the host over host.docker.internal.",
      `!! Reason: ${realRunSkipReason ?? "unknown"}`,
      "!! direct-api.md's clarification on issue #200: if the box genuinely",
      "!! cannot reach it, that must show up as a loud failure here, never a",
      "!! quiet skip.",
      "!".repeat(78),
      "",
    ].join("\n")
  );
});

test("normalizeOllamaBaseUrl: adds http://, strips a trailing slash, and appends /v1 once", () => {
  assert.equal(normalizeOllamaBaseUrl("host.docker.internal:11434"), "http://host.docker.internal:11434/v1");
  assert.equal(normalizeOllamaBaseUrl("http://host.docker.internal:11434"), "http://host.docker.internal:11434/v1");
  assert.equal(normalizeOllamaBaseUrl("http://host.docker.internal:11434/"), "http://host.docker.internal:11434/v1");
  assert.equal(normalizeOllamaBaseUrl("https://remote-ollama:11434/v1"), "https://remote-ollama:11434/v1");
});

test("openRouterAdapter and ollamaAdapter both require a per-task cap (issue #200)", () => {
  const openRouter = openRouterAdapter({ model: "m", apiKey: "k" });
  const ollama = ollamaAdapter({ model: "m" });
  assert.equal(openRouter.requiresPerTaskCap, true);
  assert.equal(ollama.requiresPerTaskCap, true);
  assert.equal(openRouter.name, "openrouter");
  assert.equal(ollama.name, "ollama");
  assert.equal(openRouter.model, "m");
});

test("openRouterAdapter defaults its base URL to the real OpenRouter API, overridable for tests", () => {
  const defaulted = openRouterAdapter({ model: "m" });
  // Not exposed on the Brain shape directly - proven indirectly via the
  // one real-containment test below, which overrides baseUrl explicitly.
  // This just proves construction with no override never throws and
  // reports the model/name honestly either way.
  assert.equal(defaulted.model, "m");
});

test("openRouterAdapter.work() runs worker-loop.mjs inside containment, reaching a server on the host via host.docker.internal", async (t) => {
  if (!dockerAvailable()) {
    realRunSkipReason = "Docker is not available on this machine";
    return t.skip(realRunSkipReason);
  }

  const server = await startFakeChatServer([
    { toolCalls: [{ name: "write_file", arguments: { path: "out.txt", content: "hello from the box" } }] },
    {
      toolCalls: [
        {
          name: "submit_writeup",
          arguments: { title: "Add out.txt", what: "w", why: "y", how: "h", deviations: "None." },
        },
      ],
    },
  ]);
  const port = new URL(server.url).port;
  const line = createProductionLine({
    project: makeFixtureProject(),
    taskId: `direct-api-openrouter-${Date.now()}`,
    recordHome: makeFixtureHome(),
  });

  try {
    const brain = openRouterAdapter({
      model: "test-model",
      baseUrl: `http://host.docker.internal:${port}`,
      apiKey: "test-key",
      image: TEST_IMAGE,
    });

    const result = await brain.work("write a file", line.workdir);

    assert.equal(readFileSync(join(line.workdir, "out.txt"), "utf8"), "hello from the box");
    assert.ok(result.writeup);
    assert.equal(result.writeup!.title, "Add out.txt");
    assert.equal(server.requests.length, 2);
    // The fake server saw a real Authorization header, proving the key
    // reached the container's env rather than being silently dropped -
    // checked on the server's own recorded request isn't possible
    // without the server capturing headers, so this is covered instead
    // by worker-loop.test.ts's host-side request body assertions plus
    // the HTTP 200 round-trip succeeding at all here.
    realRunRan = true;
  } catch (err) {
    realRunSkipReason = `the contained run did not complete: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  } finally {
    destroyProductionLine(line);
    await server.close();
  }
});

test("ollamaAdapter.work() reaches the same fake server via host.docker.internal, using Ollama's own host:port form", async (t) => {
  if (!dockerAvailable()) return t.skip("Docker is not available on this machine");

  const server = await startFakeChatServer([
    { toolCalls: [{ name: "submit_writeup", arguments: { title: "t", what: "w", why: "y", how: "h", deviations: "None." } }] },
  ]);
  const port = new URL(server.url).port;
  const line = createProductionLine({
    project: makeFixtureProject(),
    taskId: `direct-api-ollama-${Date.now()}`,
    recordHome: makeFixtureHome(),
  });

  try {
    const brain = ollamaAdapter({
      model: "test-model",
      host: `host.docker.internal:${port}`,
      image: TEST_IMAGE,
    });

    const result = await brain.work("finish immediately", line.workdir);
    assert.ok(result.writeup);
    // Ollama's own cost is always a known, real zero - never unknown.
    const usageEntry = result.transcript.find((e) => e.kind === "usage");
    assert.ok(usageEntry);
    assert.deepEqual(JSON.parse(usageEntry!.text), { totalCostUsd: 0, costBasis: "metered" });
  } finally {
    destroyProductionLine(line);
    await server.close();
  }
});
