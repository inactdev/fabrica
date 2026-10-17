// RELAY_IMAGE (launch.ts) is deliberately the same pinned digest as
// src/brain/adapters/docker/Dockerfile's own `FROM node@sha256:...`
// line, reused rather than looked up fresh - this proves the two never
// silently drift apart, the same way other modules in this repo prove a
// documented fact by reading the real source rather than trusting a
// comment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RELAY_IMAGE } from "./launch.ts";

const DOCKERFILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "brain", "adapters", "docker", "Dockerfile");

test("RELAY_IMAGE's digest matches the worker image Dockerfile's node base image", () => {
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  const match = dockerfile.match(/^FROM (node@sha256:[0-9a-f]+)\b/m);
  assert.ok(match, "expected the Dockerfile to pin a node@sha256:... base image on its own FROM line");
  assert.equal(RELAY_IMAGE, match[1]);
});
