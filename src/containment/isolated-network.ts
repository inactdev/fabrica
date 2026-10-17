// A per-task Docker network with no route to the internet (issue #186:
// "the worker box having no direct network" - so a worker's container
// has nothing to reach except what's explicitly mounted (the
// filesystem story the rest of this module already tells) and, now,
// nothing to reach on the network except the one address src/relay/'s
// relay listens on.
//
// docker's own reference docs describe `--internal` plainly: "Containers
// on an internal network may communicate between each other, but not
// with any other network, as no default route is configured and
// firewall rules are set up to drop all traffic to or from other
// networks" (https://docs.docker.com/reference/cli/docker/network/create/).
// The same page also states, separately, that "the host may communicate
// with any container IP directly" - and that relationship is symmetric
// in exactly the direction this module depends on: the network's
// gateway IP *is* the host's own interface on that bridge, a direct L2
// neighbor of every container on it, so a container can reach that one
// address the same way the host can reach the container's, with no
// route "out" of the subnet involved either way. No Docker daemon was
// available on the machine these files were written on to additionally
// verify this live - see src/relay/README.md's "What's verified, what
// isn't" for the honest, explicit record of that gap, matching the
// convention run.test.ts already follows for a missing daemon.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ContainmentError } from "./errors.ts";

const execFileAsync = promisify(execFile);

export interface IsolatedNetwork {
  name: string;
  /** The host's own address on this network - reachable from a
   * container attached to it, even though the network itself has no
   * route anywhere else. Bind the relay's listener
   * (`src/relay/server.ts`'s `bindAddress`) here. */
  gatewayIp: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Creates a fresh, internet-less bridge network, named `name`. Throws
 * `ContainmentError("network-create-failed")` on any docker failure,
 * including one it hits while reading the new network's own gateway
 * address back (in which case it also removes the half-created network
 * rather than leaking it). */
export async function createIsolatedNetwork(name: string): Promise<IsolatedNetwork> {
  try {
    await execFileAsync("docker", ["network", "create", "--internal", "--driver", "bridge", name]);
  } catch (err) {
    throw new ContainmentError("network-create-failed", `could not create isolated network "${name}": ${errorMessage(err)}`);
  }

  let gatewayIp: string;
  try {
    const { stdout } = await execFileAsync("docker", [
      "network",
      "inspect",
      name,
      "--format",
      "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
    ]);
    gatewayIp = stdout.trim();
  } catch (err) {
    await removeIsolatedNetwork(name).catch(() => {});
    throw new ContainmentError(
      "network-create-failed",
      `created isolated network "${name}" but could not read its gateway address: ${errorMessage(err)}`
    );
  }

  if (gatewayIp === "") {
    await removeIsolatedNetwork(name).catch(() => {});
    throw new ContainmentError("network-create-failed", `isolated network "${name}" reported no gateway address`);
  }

  return { name, gatewayIp };
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
