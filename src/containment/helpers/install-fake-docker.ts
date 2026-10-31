// Puts helpers/fake-docker.mjs on PATH as `docker` for the duration of
// one test, and hands back a reader for what the code under test
// actually called. Shared by this module's network tests so there is
// one copy of the PATH/env dance and one copy of the restore.
//
// The production code gets no seam: it still calls
// `execFile("docker", ...)` by bare name, and the argv a test asserts
// on is the exact argv a real daemon would have received.

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_DOCKER = join(dirname(fileURLToPath(import.meta.url)), "fake-docker.mjs");

export interface FakeNetwork {
  Name: string;
  Labels?: Record<string, string>;
  Containers?: Record<string, unknown>;
}

export interface FakeImage {
  Name: string;
  Labels?: Record<string, string>;
}

export interface FakeDockerConfig {
  networks?: FakeNetwork[];
  /** Every `docker network ls` exits non-zero, the way the real CLI
   * does with no daemon to answer. */
  failLs?: boolean;
  /** What `docker network create` fails with, when it should fail. */
  createFailure?: string;
  /** Every `docker network disconnect` fails, leaving a network with an
   * attached container genuinely stuck. */
  failDisconnect?: boolean;
  /** The images the fake daemon starts with - what `docker image
   * inspect` finds, and what a `build`/`pull` adds to. */
  images?: FakeImage[];
  /** What `docker build` fails with, when it should fail. */
  buildFailure?: string;
  /** What `docker pull` fails with, when it should fail. */
  pullFailure?: string;
  /** What a successful `docker build` writes (to stderr, like the real
   * BuildKit). Defaults to a short progress-looking stand-in. */
  buildOutput?: string;
  /** What a successful `docker pull` writes (to stdout). */
  pullOutput?: string;
}

export interface FakeDocker {
  /** Every `docker` call made, argv only, in arrival order. */
  calls: () => string[][];
  /** The networks the fake daemon still has. */
  remaining: () => string[];
  /** The images the fake daemon has now, built and pulled ones
   * included. */
  images: () => string[];
}

/** `t` is a node:test context - the shim and the env are restored in
 * its `after` hook, so a test can never leak either. */
export function installFakeDocker(
  t: { after: (fn: () => void) => void },
  config: FakeDockerConfig
): FakeDocker {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "fabrica-fake-docker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const bin = join(root, "bin");
  const state = join(root, "state");
  for (const dir of [bin, state]) mkdirSync(dir);
  writeFileSync(join(state, "config.json"), JSON.stringify(config));

  const shim = join(bin, "docker");
  copyFileSync(FAKE_DOCKER, shim);
  chmodSync(shim, 0o755);

  // `dirname(process.execPath)` too, so the shim's own `#!/usr/bin/env
  // node` resolves to the runtime running this test rather than
  // depending on `node` being on the ambient PATH.
  const priorPath = process.env.PATH;
  const priorState = process.env.FABRICA_FAKE_DOCKER;
  process.env.PATH = [bin, dirname(process.execPath), priorPath ?? ""].join(delimiter);
  process.env.FABRICA_FAKE_DOCKER = state;
  t.after(() => {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorState === undefined) delete process.env.FABRICA_FAKE_DOCKER;
    else process.env.FABRICA_FAKE_DOCKER = priorState;
  });

  const callsFile = join(state, "calls.jsonl");
  const statePath = join(state, "state.json");
  const imagesPath = join(state, "images.json");
  return {
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, "utf8")
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => JSON.parse(line) as string[])
        : [],
    // The fake only writes its state file once something has changed,
    // so a run that removed nothing still reports what it started with.
    remaining: () => {
      const live = existsSync(statePath)
        ? (JSON.parse(readFileSync(statePath, "utf8")) as FakeNetwork[])
        : (config.networks ?? []);
      return live.map((network) => network.Name);
    },
    // Same reasoning, for images: nothing built or pulled means no
    // images.json, so what it started with is what it has.
    images: () => {
      const live = existsSync(imagesPath)
        ? (JSON.parse(readFileSync(imagesPath, "utf8")) as FakeImage[])
        : (config.images ?? []);
      return live.map((image) => image.Name);
    },
  };
}
