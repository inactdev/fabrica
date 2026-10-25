// Why a `docker network create` failed, when Docker's own sentence is
// true but useless on its own.
//
// Docker hands out every task's network a subnet from a fixed set of
// predefined address pools (moby's `ipamutils`: 172.17-172.31, 192.168,
// 10.0.0.0/8 split into /24s). A network that is never removed keeps
// its pool, so a machine that has leaked enough of them stops being
// able to create any network at all - and the daemon's own answer
// ("all predefined address pools have been fully subnetted") names
// neither the cause a Client can act on nor the one command that
// clears it. Both strings below are taken from moby's own source, not
// guessed:
//
//   - "all predefined address pools have been fully subnetted" -
//     `ipamapi.ErrNoMoreSubnets`, daemon/libnetwork/ipamapi/contract.go
//     on current moby.
//   - "could not find an available, non-overlapping IPv4 address pool
//     among the defaults to assign to the network" - the same condition
//     in libnetwork/ipam/allocator.go up to moby v24, which plenty of
//     installed daemons still run.
//
// Matched case-insensitively and on a fragment rather than the whole
// sentence, so a reworded-but-recognisable message still lands here;
// anything we don't recognise is reported as Docker worded it, never
// guessed at.

/** The one command named whenever leftover networks are the problem -
 * `fabrica doctor`'s fix line and the create-failure message below both
 * use this, so the Client is never told two different things (Client
 * ruling: plain `docker network prune -f`, verbatim, not a new
 * `fabrica` subcommand). */
export const NETWORK_PRUNE_COMMAND = "docker network prune -f";

const POOL_EXHAUSTION_SIGNATURES = [
  "all predefined address pools have been fully subnetted",
  "non-overlapping ipv4 address pool",
  "non-overlapping ipv6 address pool",
];

/** Whether what Docker said is the address pools being used up, as
 * opposed to any other create failure. */
export function poolsExhausted(dockerSaid: string): boolean {
  const said = dockerSaid.toLowerCase();
  return POOL_EXHAUSTION_SIGNATURES.some((signature) => said.includes(signature));
}

/** The message a failed `docker network create` is reported with:
 * Docker's own words always, preceded by the cause and the command that
 * clears it whenever the cause is one we recognise. */
export function networkCreateFailureMessage(kind: string, name: string, dockerSaid: string): string {
  const opening = `could not create ${kind} network "${name}"`;
  if (!poolsExhausted(dockerSaid)) return `${opening}: ${dockerSaid}`;
  return (
    `${opening}: Docker has no address pool left to give it - every predefined subnet is ` +
    `already assigned, usually to networks left behind by earlier tasks. Remove the unused ` +
    `ones with: ${NETWORK_PRUNE_COMMAND} (docker said: ${dockerSaid})`
  );
}
