// A task's Docker networks never outlive its round.
//
// A worker box runs on a throwaway `--internal` network, with a relay
// container on it as its only route out, and a second egress network
// behind the relay (src/brain/adapters/, src/containment/). The adapter
// removes both in its own `finally` - but that `finally` cannot run at
// all when the process is killed mid-round, and it fails outright when
// Docker has not finished reaping the relay container yet (see
// notes/20261017-fix-the-relay-s-failure-path-cleanup-in-ph.md: "a
// stopped container still holds the network"). Either way the network
// stays, and with it the Docker address pool it holds - enough of them
// and no task can create a network at all.
//
// So the Foreman sweeps: every round, on the way out, whatever outcome,
// the same place it tears the ProductionLine down. The sweep is keyed
// on the task's own Docker label, so it can only ever touch networks
// opened for this task - never a concurrent task's, never a
// hand-made one.
//
// This is the one place under src/foreman that reaches Docker, and it
// reaches it through src/containment rather than spawning anything
// itself (no-host-check.test.ts's rule stands: nothing here spawns a
// child process but git). Cleaning up a box Fabrica opened is not
// running a project's check on the host - no project code executes
// here, only `docker network rm`.

import { NETWORK_PRUNE_COMMAND, removeTaskNetworks } from "../containment/index.ts";

/** Removes every Docker network opened for `taskId`.
 *
 * Never throws and never fails a round: it runs in cleanup paths where
 * the round's own result (or its own error) is the thing worth
 * reporting. A machine with no Docker at all has nothing to sweep and
 * says nothing - that is not a silent skip, there is nothing there to
 * skip. A network that genuinely would not go away is a different
 * matter and is reported: the line lands in `<recordHome>/cli.log` with
 * this task's id on it (src/cli/task-log.ts), and whatever is left
 * behind is counted by `fabrica doctor`'s own leftover check, which
 * names the same prune command.
 */
export async function sweepTaskNetworks(taskId: string): Promise<void> {
  const sweep = await removeTaskNetworks(taskId);
  for (const { name, reason } of sweep.failed) {
    process.stderr.write(
      `fabrica: could not remove this task's docker network ${name}: ${reason}\n` +
        `fabrica: it still holds a docker address pool - clear leftovers with: ${NETWORK_PRUNE_COMMAND}\n`
    );
  }
}
