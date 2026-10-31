#!/usr/bin/env node
// Test-only: a stand-in for the `docker` CLI's network and image
// commands, so task-networks.ts and src/cli/image-repair.ts can be
// driven with no Docker daemon anywhere near them. Same mechanism as
// src/relay/container/helpers/fake-docker.mjs
// (see notes/20261017-fix-the-relay-s-failure-path-cleanup-in-ph.md,
// "Faking the `docker` CLI: copy a shim onto PATH as `docker`"): a test
// copies this file onto a throwaway directory as `docker`, marks it
// executable and puts that directory first on PATH, so the production
// code's own `execFile("docker", ...)` reaches it with no seam added
// for testability and the argv asserted on is the exact argv a real
// daemon would have received.
//
// `FABRICA_FAKE_DOCKER` points at a directory holding:
//   config.json - { networks: [{ Name, Labels, Containers }], failLs,
//                   images: [{ Name, Labels }], buildFailure,
//                   pullFailure, buildOutput, pullOutput }
//                 every field optional. `failLs` makes every
//                 `network ls` exit non-zero, the way the real CLI does
//                 with no daemon to answer; `buildFailure`/`pullFailure`
//                 do the same for `build`/`pull`, with that string as
//                 the daemon's own complaint.
//   state.json  - this fake's own live copy of `networks`, so a removal
//                 in one call is visible to the next.
//   images.json - the same for `images`, so an image built or pulled in
//                 one call is visible to the next call's
//                 `image inspect`. A separate file from state.json so
//                 that file's shape - a bare array of networks, which
//                 install-fake-docker.ts reads back - is unchanged.
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
const imagesPath = join(stateDir, "images.json");
let networks = existsSync(statePath) ? readJson("state.json", []) : (config.networks ?? []);
let images = existsSync(imagesPath) ? readJson("images.json", []) : (config.images ?? []);

const args = process.argv.slice(2);
appendFileSync(join(stateDir, "calls.jsonl"), `${JSON.stringify(args)}\n`);

function save() {
  writeFileSync(statePath, JSON.stringify(networks));
}

function saveImages() {
  writeFileSync(imagesPath, JSON.stringify(images));
}

function flagValue(flag) {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

function fail(message) {
  process.stderr.write(`Error response from daemon: ${message}\n`);
  process.exit(1);
}

function unexpected() {
  process.stderr.write(`fake docker: unexpected command ${JSON.stringify(args)}\n`);
  process.exit(1);
}

/** Every flag this fake has ever been handed that takes a separate
 * value, so the positional arguments can be told from a flag's value. */
const VALUE_FLAGS = new Set(["--format", "--build-arg", "-t", "--tag", "-f", "--file"]);

function positionalFrom(index) {
  const out = [];
  for (let i = index; i < args.length; i += 1) {
    if (VALUE_FLAGS.has(args[i])) {
      i += 1;
      continue;
    }
    if (args[i].startsWith("-")) continue;
    out.push(args[i]);
  }
  return out;
}

function buildArgValues() {
  const values = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--build-arg") continue;
    const [key, ...rest] = (args[i + 1] ?? "").split("=");
    values[key] = rest.join("=");
  }
  return values;
}

/** The labels a real `docker build` of this Dockerfile would stamp on
 * the image, for the one shape this project's own Dockerfile uses -
 * `LABEL <key>=$<ARG>`, resolved from the `--build-arg` values this
 * call was given. Read out of the Dockerfile the call names rather than
 * hardcoded here, so the label's own name lives in exactly one place
 * (the Dockerfile) and a rename there can never leave this fake
 * stamping a name nothing reads. An unreadable Dockerfile stamps
 * nothing. */
function labelsFromDockerfile(path, built) {
  if (!path) return {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const labels = {};
  for (const line of text.split("\n")) {
    const match = /^LABEL\s+([^\s=]+)=\$(\S+)$/.exec(line.trim());
    if (match) labels[match[1]] = built[match[2]] ?? "";
  }
  return labels;
}

switch (args[0]) {
  case "network":
    break; // handled by the switch below
  case "build": {
    if (config.buildFailure) fail(config.buildFailure);
    const tag = flagValue("-t") ?? flagValue("--tag");
    if (!tag) unexpected();
    const labels = labelsFromDockerfile(flagValue("-f") ?? flagValue("--file"), buildArgValues());
    images = images.filter((image) => image.Name !== tag).concat([{ Name: tag, Labels: labels }]);
    saveImages();
    // stderr, like the real BuildKit: every progress line of a real
    // `docker build` goes there, not to stdout, so anything reading
    // only stdout would see a silent build.
    process.stderr.write(config.buildOutput ?? `#1 [internal] load build definition\n#1 DONE 0.1s\nnaming to ${tag} done\n`);
    process.exit(0);
  }
  case "pull": {
    if (config.pullFailure) fail(config.pullFailure);
    const [name] = positionalFrom(1);
    if (!name) unexpected();
    images = images.filter((image) => image.Name !== name).concat([{ Name: name, Labels: {} }]);
    saveImages();
    process.stdout.write(config.pullOutput ?? `Pulling from library\nStatus: Downloaded newer image for ${name}\n`);
    process.exit(0);
  }
  case "image": {
    if (args[1] !== "inspect") unexpected();
    const names = positionalFrom(2);
    const found = names.map((name) => images.find((image) => image.Name === name));
    const missing = names.filter((_, at) => found[at] === undefined);
    // `docker image inspect` only ever looks locally and says exactly
    // this when it finds nothing - which is what every "is this image
    // here" probe in this project reads as absent.
    if (missing.length > 0) fail(`No such image: ${missing[0]}`);
    const format = flagValue("--format");
    if (format === undefined) {
      process.stdout.write(`${JSON.stringify(found.map((image) => ({ Config: { Labels: image.Labels ?? {} } })))}\n`);
      process.exit(0);
    }
    // The one Go template this fake understands: the exact one
    // src/brain/adapters/doctor-checks.ts asks for. Any other is a loud
    // failure rather than an invented answer.
    const label = /^\{\{index \.Config\.Labels "([^"]+)"\}\}$/.exec(format.trim());
    if (!label) {
      process.stderr.write(`fake docker: unsupported --format ${JSON.stringify(format)}\n`);
      process.exit(1);
    }
    const value = (found[0].Labels ?? {})[label[1]];
    // `<no value>` is what the real CLI prints for a label the image
    // does not carry at all; a label it carries empty prints empty.
    // Both are "no usable stamp" to every reader in this project, and
    // keeping them distinct here is what makes that provable.
    process.stdout.write(`${value === undefined ? "<no value>" : value}\n`);
    process.exit(0);
  }
  default:
    unexpected();
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
