// The other half of issue #186's "a project declares its allowed hosts
// in projects.toml": reading the declaration back out of a real config
// file and matching it to the project a task is running against.
// src/relay/policy.test.ts covers what is then done with it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { networkPolicyFor } from "./network-policy.ts";

function home(projectsToml?: string): string {
  const recordHome = mkdtempSync(join(tmpdir(), "fabrica-network-policy-home-"));
  if (projectsToml !== undefined) writeFileSync(join(recordHome, "projects.toml"), projectsToml);
  return recordHome;
}

function project(): string {
  return mkdtempSync(join(tmpdir(), "fabrica-network-policy-project-"));
}

test("a registered project's hosts and limits are the policy", () => {
  const path = project();
  const recordHome = home(
    `[projects.demo]\npath = "${path}"\ncheck = "./check.sh"\n` +
      `hosts = ["registry.npmjs.org", "*.example.com:8443"]\n` +
      `maxRequestBytes = 2048\nmaxCallsPerTask = 7\n`
  );

  assert.deepEqual(networkPolicyFor(recordHome, "t1", path), {
    recordHome,
    taskId: "t1",
    hosts: ["registry.npmjs.org", "*.example.com:8443"],
    maxRequestBytes: 2048,
    maxCallsPerTask: 7,
  });
});

test("a registered project that declares nothing declares nothing - not nothing allowed", () => {
  const path = project();
  const recordHome = home(`[projects.demo]\npath = "${path}"\ncheck = "./check.sh"\n`);

  const policy = networkPolicyFor(recordHome, "t1", path);
  assert.deepEqual(policy.hosts, []);
  assert.equal(policy.maxRequestBytes, undefined, "an undeclared limit leaves the relay's own default in force");
  assert.equal(policy.maxCallsPerTask, undefined);
});

test("an unregistered project, and a record home with no projects.toml at all, behave the same", () => {
  const path = project();
  const unregistered = home(`[projects.other]\npath = "${project()}"\ncheck = "./check.sh"\nhosts = ["nope.example"]\n`);

  assert.deepEqual(networkPolicyFor(unregistered, "t1", path), { recordHome: unregistered, taskId: "t1", hosts: [] });

  const bare = home();
  assert.deepEqual(networkPolicyFor(bare, "t1", path), { recordHome: bare, taskId: "t1", hosts: [] });
});

test("the task id on the policy is the task the refusal will be written to", () => {
  const path = project();
  const recordHome = home(`[projects.demo]\npath = "${path}"\ncheck = "./check.sh"\n`);

  assert.equal(networkPolicyFor(recordHome, "task-42", path).taskId, "task-42");
  assert.equal(networkPolicyFor(recordHome, "task-42", path).recordHome, recordHome);
});

test("a malformed projects.toml leaves the policy empty rather than killing the round here", () => {
  const path = project();
  const recordHome = home("this is not toml at all [[[");

  // resolve-check.ts runs first in every round and refuses a malformed
  // config properly, with its own message; a second, worse-worded
  // version of that refusal from here would only ever hide it.
  assert.deepEqual(networkPolicyFor(recordHome, "t1", path), { recordHome, taskId: "t1", hosts: [] });
});
