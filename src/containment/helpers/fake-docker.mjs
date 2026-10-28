#!/usr/bin/env node
// Test-only: a stand-in for the `docker` CLI's network commands, so
// task-networks.ts can be driven with no Docker daemon anywhere near
// it. Same mechanism as src/relay/container/helpers/fake-docker.mjs
// (see notes/20261017-fix-the-relay-s-failure-path-cleanup-in-ph.md,
// "Faking the `docker` CLI: copy a shim onto PATH as `docker`"): a test
// copies this file onto a throwaway directory as `docker`, marks it
// executable and puts that directory first on PATH, so the production
// code's own `execFile("docker", ...)` reaches it with no seam added
// for testability and the argv asserted on is the exact argv a real
// daemon would have received.
//
// `FABRICA_FAKE_DOCKER` points at a directory holding:
//   config.json - { networks: [{ Name, Labels, Containers }], failLs }
//                 every field optional. `failLs` makes every
//                 `network ls` exit non-zero, the way the real CLI does
//                 with no daemon to answer.
//   state.json  - this fake's own live copy of `networks`, so a removal
//                 in one call is visible to the next.
//   calls.jsonl - one JSON argv array per call, in arrival order.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const stateDir = process.env.FABRICA_FAKE_DOCKER;
if (!stateDir) {
  // Loud, not silent: a test whose PATH shim is in place but whose env
  // var isn't would otherwise look like docker answering oddly.
  process.stderr.write("fake docker: FABRICA_FAKE_DOCKER is not set\n");
  process.exit(64);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(readFileSync(join(stateDir, name), "utf8"));
  } catch {
    return fallback;
  }
}

const config = readJson("config.json", {});
const statePath = join(stateDir, "state.json");
let networks = existsSync(statePath) ? readJson("state.json", []) : (config.networks ?? []);

const args = process.argv.slice(2);
appendFileSync(join(stateDir, "calls.jsonl"), `${JSON.stringify(args)}\n`);

function save() {
  writeFileSync(statePath, JSON.stringify(networks));
}

function flagValue(flag) {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

function fail(message) {
  process.stderr.write(`Error response from daemon: ${message}\n`);
  process.exit(1);
}

if (args[0] !== "network") {
  process.stderr.write(`fake docker: unexpected command ${JSON.stringify(args)}\n`);
  process.exit(1);
}

switch (args[1]) {
  case "ls": {
    if (config.failLs) fail("Cannot connect to the Docker daemon");
    const filter = flagValue("--filter") ?? "";
    let matched = networks;
    if (filter.startsWith("name=")) {
      const needle = filter.slice("name=".length);
      matched = networks.filter((n) => n.Name.includes(needle));
    } else if (filter.startsWith("label=")) {
      const [key, value] = filter.slice("label=".length).split("=");
      matched = networks.filter((n) => (n.Labels ?? {})[key] === value);
    }
    process.stdout.write(matched.map((n) => `${n.Name}\n`).join(""));
    process.exit(0);
  }
  case "inspect": {
    const names = args.slice(2).filter((arg) => !arg.startsWith("-"));
    const found = names.map((name) => networks.find((n) => n.Name === name)).filter(Boolean);
    if (found.length !== names.length) fail("network not found");
    process.stdout.write(`${JSON.stringify(found)}\n`);
    process.exit(0);
  }
  case "rm": {
    const names = args.slice(2).filter((arg) => !arg.startsWith("-"));
    const force = args.includes("-f") || args.includes("--force");
    for (const name of names) {
      const network = networks.find((n) => n.Name === name);
      // `-f` on the real CLI means "do not error if the network does
      // not exist" - it does NOT remove a network something is still
      // attached to. Without it, a missing network is an error, and
      // modelling that is the whole point: a caller that relies on a
      // missing network being tolerated has to say so, or be seen
      // failing here the way it would fail against a real daemon.
      if (!network) {
        if (force) continue;
        fail(`network ${name} not found`);
      }
      if (Object.keys(network.Containers ?? {}).length > 0) {
        fail(`error while removing network: network ${name} has active endpoints`);
      }
      networks = networks.filter((n) => n.Name !== name);
    }
    save();
    process.exit(0);
  }
  case "disconnect": {
    const positional = args.slice(2).filter((arg) => !arg.startsWith("-"));
    const [name, container] = positional;
    const network = networks.find((n) => n.Name === name);
    if (!network) fail(`network ${name} not found`);
    // A container nothing can force off the network - the one case
    // that leaves a network genuinely stuck, and the one the Client
    // has to be told about.
    if (config.failDisconnect) fail(`container ${container} is not connected to network ${name}`);
    delete (network.Containers ?? {})[container];
    save();
    process.exit(0);
  }
  case "create": {
    if (config.createFailure) fail(config.createFailure);
    const name = args[args.length - 1];
    const labels = {};
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] !== "--label") continue;
      const [key, ...rest] = args[i + 1].split("=");
      labels[key] = rest.join("=");
    }
    networks.push({ Name: name, Labels: labels, Containers: {} });
    save();
    process.stdout.write(`${name}\n`);
    process.exit(0);
  }
  default:
    process.stderr.write(`fake docker: unexpected network command ${JSON.stringify(args)}\n`);
    process.exit(1);
}
