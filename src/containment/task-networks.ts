// Which Docker network belongs to which task, and how one task's
// networks are swept up once its round is over.
//
// Every network this module's siblings create carries two labels - the
// task it was opened for and what it is (`fabrica.task`,
// `fabrica.role`) - because a name alone cannot answer either question:
// a network is named after a random per-call id (see the reference
// adapter's `connectThroughRelay`, under `../brain/adapters/`), not
// after the task, and nothing outside the process that created it could
// otherwise tell a live task's network from one left behind by a round
// that died. Labels are Docker's own answer to that
// (`docker network create --label`), they survive the process that set
// them, and `docker network ls --filter label=<k>=<v>` reads them back.
//
// Two readers, both here so neither drifts from how the labels are
// written: `removeTaskNetworks` (the Foreman's sweep at the end of a
// round - see `../foreman/task-networks.ts`) and `listWorkerNetworks`
// (`fabrica doctor`'s leftover count).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The task a network was opened for. Absent on a network opened with
 * no task in flight (a library-level caller or a test driving an
 * adapter directly) - which is exactly why a sweep keyed on a real
 * task id can never touch one of those. */
export const TASK_LABEL = "fabrica.task";

/** What the network is: `worker` (the task's own internet-less box
 * network) or `relay-egress` (the relay container's route out). */
export const ROLE_LABEL = "fabrica.role";

export type NetworkRole = "worker" | "relay-egress";

/** Every worker network is named with this prefix - the string
 * `fabrica doctor` counts leftovers of, and the one the Client sees in
 * `docker network ls`. */
export const WORKER_NETWORK_PREFIX = "fabrica-worker-";

/** The `--label` arguments a `docker network create` gets. Exported so
 * both network modules label identically, and so a test can assert on
 * the exact argv. */
export function networkLabelArgs(role: NetworkRole, taskId: string | undefined): string[] {
  const args = ["--label", `${ROLE_LABEL}=${role}`];
  if (taskId !== undefined && taskId !== "") args.push("--label", `${TASK_LABEL}=${taskId}`);
  return args;
}

/** What Docker said went wrong, preferring its own stderr over Node's
 * "Command failed: ..." wrapper around it. */
export function dockerSaid(err: unknown): string {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === "string" && stderr.trim() !== "") return stderr.trim();
  return err instanceof Error ? err.message : String(err);
}

/** One `fabrica-worker-*` network as Docker currently has it. */
export interface WorkerNetwork {
  name: string;
  /** The task it was opened for, or null when it carries no task label
   * (opened outside a task, or by a copy of Fabrica older than the
   * labels). */
  taskId: string | null;
  /** How many containers Docker still has attached to it. Anything
   * above zero is in use, whatever the record says. */
  attachedContainers: number;
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", args);
  return stdout;
}

function networkNames(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Every `fabrica-worker-*` network on this machine, with the task it
 * belongs to and how many containers are on it - or `null` when Docker
 * itself could not be asked (not installed, daemon down). `null` is
 * deliberately not an empty list: "there are no leftovers" and "nobody
 * could say" are different answers, and only one of them is worth
 * reporting as a clean machine. */
export async function listWorkerNetworks(): Promise<WorkerNetwork[] | null> {
  let names: string[];
  try {
    names = networkNames(await docker(["network", "ls", "--filter", `name=${WORKER_NETWORK_PREFIX}`, "--format", "{{.Name}}"]));
  } catch {
    return null;
  }
  // `--filter name=` is a substring match, so a network merely
  // containing the prefix would come back too - the real prefix is
  // checked here rather than trusted to the filter.
  names = names.filter((name) => name.startsWith(WORKER_NETWORK_PREFIX));
  if (names.length === 0) return [];

  let inspected: unknown;
  try {
    // No `--format`: `docker network inspect` renders a plain JSON
    // array by default, which needs no Go template to be right about
    // labels and attached containers.
    inspected = JSON.parse(await docker(["network", "inspect", ...names]));
  } catch {
    return null;
  }
  if (!Array.isArray(inspected)) return null;

  return inspected.map((entry) => {
    const network = entry as { Name?: unknown; Labels?: Record<string, unknown>; Containers?: Record<string, unknown> };
    const taskId = network.Labels?.[TASK_LABEL];
    return {
      name: typeof network.Name === "string" ? network.Name : "",
      taskId: typeof taskId === "string" && taskId !== "" ? taskId : null,
      attachedContainers: Object.keys(network.Containers ?? {}).length,
    };
  });
}

/** What a sweep did. `failed` is the only part worth telling the Client
 * about - see `../foreman/task-networks.ts`. */
export interface TaskNetworkSweep {
  removed: string[];
  failed: { name: string; reason: string }[];
  /** Docker could not be asked at all - no daemon, not installed. Then
   * there is no network anywhere for this task either, so this is
   * nothing to report. */
  dockerUnreachable: boolean;
}

async function attachedContainerIds(name: string): Promise<string[]> {
  try {
    const inspected = JSON.parse(await docker(["network", "inspect", name])) as { Containers?: Record<string, unknown> }[];
    return Object.keys(inspected[0]?.Containers ?? {});
  } catch {
    return [];
  }
}

/** Removes one network, including the case the notes warn about: a
 * container Docker has not finished reaping yet is still attached, and
 * Docker refuses to remove a network while anything is on it (`docker
 * network rm`'s own docs: "To remove a network, you must first
 * disconnect any containers connected to it"). Those containers are
 * this task's own throwaway worker box and relay, and this runs only
 * once the round is over, so they are forced off and the removal is
 * retried. Returns null when the network is gone, or Docker's reason
 * when it is still there. */
async function removeNetwork(name: string): Promise<string | null> {
  try {
    // `-f` here means "do not error if the network does not exist" (not
    // "remove it whatever is attached"), so a network another path
    // already removed is success, not a reported failure.
    await docker(["network", "rm", "-f", name]);
    return null;
  } catch {
    for (const container of await attachedContainerIds(name)) {
      await docker(["network", "disconnect", "-f", name, container]).catch(() => {});
    }
    try {
      await docker(["network", "rm", "-f", name]);
      return null;
    } catch (err) {
      return dockerSaid(err);
    }
  }
}

/** Removes every network opened for `taskId` - the worker's own
 * isolated network and the relay's egress network alike, since both are
 * this task's and both hold an address pool until they are gone. Never
 * throws: a sweep runs in a round's cleanup path, where throwing would
 * replace the round's own result with a plumbing error. */
export async function removeTaskNetworks(taskId: string): Promise<TaskNetworkSweep> {
  let names: string[];
  try {
    names = networkNames(await docker(["network", "ls", "--filter", `label=${TASK_LABEL}=${taskId}`, "--format", "{{.Name}}"]));
  } catch {
    return { removed: [], failed: [], dockerUnreachable: true };
  }

  const removed: string[] = [];
  const failed: { name: string; reason: string }[] = [];
  for (const name of names) {
    const reason = await removeNetwork(name);
    if (reason === null) removed.push(name);
    else failed.push({ name, reason });
  }
  return { removed, failed, dockerUnreachable: false };
}
