// cli.log is where a detached task's own output goes (spawn-detached.ts).
// Every line in it carries a timestamp and the task's id (Client ruling
// 2026-10-10), so a line can be tied back to its task long after the
// terminal that started it is gone. A line written before the task is
// registered says so instead of an id.

const NO_TASK_YET = "(no-task-yet)";

/** Prefixes every line this process writes to stdout and stderr. Returns
 * the setter for the task id, to call once the task is registered. */
export function prefixTaskLog(): (taskId: string) => void {
  let taskId: string | undefined;
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;
    let atLineStart = true;
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      let out = "";
      for (const piece of text.split(/(?<=\n)/)) {
        if (piece.length === 0) continue;
        if (atLineStart) out += `${new Date().toISOString()} ${taskId ?? NO_TASK_YET} `;
        out += piece;
        atLineStart = piece.endsWith("\n");
      }
      return write(out, ...rest);
    }) as typeof stream.write;
  }
  return (id) => {
    taskId = id;
  };
}
