// A per-task Docker network with no route to the internet (issue #186:
// "the worker box having no direct network" - so a worker's container
// has nothing to reach except what's explicitly mounted (the
// filesystem story the rest of this module already tells) and, now,
// nothing to reach on the network except another container also
// attached to this same network - see src/relay/container/launch.ts.
//
// docker's own reference docs describe `--internal` plainly: "Containers
// on an internal network may communicate between each other, but not
// with any other network, as no default route is configured and
// firewall rules are set up to drop all traffic to or from other
// networks" (https://docs.docker.com/reference/cli/docker/network/create/).
//
// An earlier version of this module additionally relied on the same
// page's "the host may communicate with any container IP directly" to
// bind a relay process on the *host* to this network's own gateway
// address, reasoning that the gateway IP is the host's own interface on
// the bridge. That is true on native Linux Docker - and false on Docker
// Desktop (Mac/Windows), proven on the Client's own Mac on 2026-10-17: a
// container on this network cannot reach the host at all, neither via
// the gateway address (the Docker Desktop VM owns it, not the Mac) nor
// via host.docker.internal (`--internal` strips the route Docker Desktop
// otherwise sets up for that name). The fix isn't a Mac-specific carve-
// out; it's dropping the host-process design entirely, since the
// `--internal` flag's own documented guarantee - containers on the
// network can reach each other - holds on both platforms. The relay is
// now always another *container* on this network (src/relay/
// container/launch.ts), never a process bound to the gateway address;
// this module no longer looks up or returns that address at all.
//
// No Docker daemon was available on the machine this file was last
// edited from to additionally verify the `--internal` behavior quoted
// above live - see src/relay/README.md's "What's verified, what isn't"
// for the honest, explicit record of that gap, matching the convention
// run.test.ts already follows for a missing daemon.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ContainmentError } from "./errors.ts";

const execFileAsync = promisify(execFile);

export interface IsolatedNetwork {
  name: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Creates a fresh, internet-less bridge network, named `name`. Throws
 * `ContainmentError("network-create-failed")` on any docker failure. */
export async function createIsolatedNetwork(name: string): Promise<IsolatedNetwork> {
  try {
    await execFileAsync("docker", ["network", "create", "--internal", "--driver", "bridge", name]);
  } catch (err) {
    throw new ContainmentError("network-create-failed", `could not create isolated network "${name}": ${errorMessage(err)}`);
  }
  return { name };
}

/** Removes a network created by `createIsolatedNetwork`. Throws
 * `ContainmentError("network-remove-failed")` on failure (e.g. a
 * container is still attached) rather than leaving it silently in
 * place. */
export async function removeIsolatedNetwork(name: string): Promise<void> {
  try {
    await execFileAsync("docker", ["network", "rm", name]);
  } catch (err) {
    throw new ContainmentError("network-remove-failed", `could not remove isolated network "${name}": ${errorMessage(err)}`);
  }
}
