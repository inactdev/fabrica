// The relay container runs bootstrap.mjs with a stock `node` and the
// checkout mounted read-only - no tsx, nothing from node_modules. This
// proves that by copying only src/relay's .mjs files into an empty
// directory (no node_modules, no .ts files anywhere near it) and
// starting the relay from there with plain `node`, then driving one
// refused CONNECT so the way a refusal leaves the container is proven
// too: one line on stdout, and nothing written anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RELAY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

test("bootstrap.mjs starts the relay with plain node and only src/relay's .mjs files present", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "fabrica-relay-plain-js-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const relayCopy = join(root, "relay");
  cpSync(RELAY_DIR, relayCopy, { recursive: true, filter: (src) => !src.endsWith(".ts") });
  const copied = readdirSync(relayCopy, { recursive: true }).map(String);
  assert.ok(copied.every((p) => !p.endsWith(".ts")), "no TypeScript file may be copied");

  const config = { port: 0, tunnelAllowlist: [{ host: "github.com" }] };
  const child = spawn(process.execPath, [join(relayCopy, "container", "bootstrap.mjs")], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", FABRICA_RELAY_CONFIG: JSON.stringify(config) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));

  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.on("data", () => {
      const match = stdout.match(/FABRICA-RELAY-LISTENING (\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.once("exit", (code) => reject(new Error(`relay exited with ${code} before listening: ${stderr}`)));
  });

  const status = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write("CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n"));
    socket.once("error", reject);
    socket.once("data", (chunk: Buffer) => {
      resolve(chunk.toString("utf8").split("\r\n")[0] ?? "");
      socket.destroy();
    });
  });
  assert.equal(status, "HTTP/1.1 403 Forbidden");

  // How a refusal leaves the container: one line on stdout, for the host
  // side to append as this task's "network-refused" event
  // (launch.ts). The container itself knows no record home and writes
  // nothing - it used to append the event in here, which is how an
  // unwritable path could kill the relay (see server.mjs's header).
  const refusal = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`no refusal line in: ${stdout}`)), 2_000);
    const look = () => {
      const match = stdout.match(/FABRICA-RELAY-REFUSAL (.+)/);
      if (!match) return;
      clearTimeout(deadline);
      resolve(match[1]!);
    };
    child.stdout.on("data", look);
    look();
  });
  assert.deepEqual(JSON.parse(refusal), { host: "evil.example", port: 443 });

  // Nothing beyond the copied .mjs files: no record, no stray file the
  // relay decided to write on its own.
  assert.deepEqual(readdirSync(root).sort(), ["relay"]);
  assert.ok(!existsSync(join(root, "events.jsonl")));
});
