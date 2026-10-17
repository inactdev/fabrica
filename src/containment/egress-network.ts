// The opposite of isolated-network.ts, on purpose: a plain Docker bridge
// network (no `--internal`), so whatever is attached to it has a real
// route out to the internet through Docker's own NAT. The one caller is
// src/relay/container/launch.ts - a relay container needs exactly this
// as its second network leg, since its *first* leg (the isolated
// network it shares with a worker) has none by design. A worker is
// never attached to a network this module creates; see src/relay/
// README.md's "Why the relay is the container with two networks" for
// why that split, not the reverse, is the one with the smaller trust
// surface.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ContainmentError } from "./errors.ts";

const execFileAsync = promisify(execFile);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Creates a fresh bridge network with the ordinary default route out -
 * nothing special about it except that it exists to be the far side of
 * exactly one relay container's second network interface. Throws
 * `ContainmentError("network-create-failed")` on any docker failure. */
export async function createEgressNetwork(name: string): Promise<{ name: string }> {
  try {
    await execFileAsync("docker", ["network", "create", "--driver", "bridge", name]);
  } catch (err) {
    throw new ContainmentError("network-create-failed", `could not create egress network "${name}": ${errorMessage(err)}`);
  }
  return { name };
}

/** Removes a network created by `createEgressNetwork`. Throws
 * `ContainmentError("network-remove-failed")` on failure (e.g. a
 * container is still attached) rather than leaving it silently in
 * place. */
export async function removeEgressNetwork(name: string): Promise<void> {
  try {
    await execFileAsync("docker", ["network", "rm", name]);
  } catch (err) {
    throw new ContainmentError("network-remove-failed", `could not remove egress network "${name}": ${errorMessage(err)}`);
  }
}
