// @ts-check
// The tools a direct-API worker actually works with. A CLI adapter gets
// these for free - the tool it wraps already has them (see
// ../README.md's "Two families of adapter"). A direct API returns text
// and tool-call requests and nothing else, so reading files, editing
// them and running commands is code *this* module runs, inside the box,
// against the ProductionLine worktree mounted at the process's own
// working directory.
//
// Every path is resolved against that one root and refused if it lands
// outside it. That is not the containment boundary - the container is
// (src/containment/, which mounts nothing else writable) - it is a plain
// mistake-catcher that turns a stray "../../etc/hosts" into an error the
// model can read and correct, instead of a write that silently goes
// nowhere useful.
//
// Plain JavaScript importing only `node:` built-ins; see client.mjs.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** The tool list, as OpenAI-compatible function definitions. The
 * write-up tool is added by the loop, from the schema the host built out
 * of src/brain/writeup.ts - this file never restates those fields. */
export const WORK_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description:
        "List the entries of a directory in the project. Directories are marked with a trailing slash. " +
        "Use this to find your way around before reading files.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", description: 'Path relative to the project root. Use "." for the root itself.' },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file in the project.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", description: "Path relative to the project root." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write a text file in the project, creating it and any missing parent directories, replacing it whole if it exists. " +
        "Prefer edit_file for a change to part of an existing file.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: { type: "string", description: "Path relative to the project root." },
          content: { type: "string", description: "The file's complete new contents." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace an exact piece of text in a file. The old text must appear exactly once unless replaceAll is true. " +
        "Include enough surrounding text to make it unique.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path", "oldText", "newText"],
        properties: {
          path: { type: "string", description: "Path relative to the project root." },
          oldText: { type: "string", description: "The exact text to replace." },
          newText: { type: "string", description: "What to put in its place." },
          replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command in the project root and get its output (stdout and stderr together) and exit code. " +
        "This is how you run the project's own checks. You cannot commit: the project's git directory is mounted read-only " +
        "and Fabrica commits your work for you.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["command"],
        properties: {
          command: { type: "string", description: "The command line to run." },
          timeoutMs: { type: "number", description: "Milliseconds to wait before giving up on the command." },
        },
      },
    },
  },
];

/** The name of the tool that ends a work loop. The loop owns its
 * behaviour (it is the finish line, not a side effect), so only the name
 * lives here, next to the others. */
export const WRITEUP_TOOL_NAME = "submit_writeup";

/**
 * Keeps both ends of an oversized output, naming what was dropped, so
 * nothing it is read from - a model's next turn, or the Client's
 * transcript - can mistake the piece for the whole.
 * @param {string} text
 * @param {number} maxChars
 */
export function clamp(text, maxChars) {
  if (text.length <= maxChars) return text;
  const half = Math.max(1, Math.floor((maxChars - 80) / 2));
  const dropped = text.length - half * 2;
  return `${text.slice(0, half)}\n\n[... ${dropped} characters dropped from the middle ...]\n\n${text.slice(-half)}`;
}

/**
 * A tool's path argument as a real absolute path inside `root`.
 * @param {string} root
 * @param {unknown} value
 * @returns {string}
 */
function resolveInside(root, value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("path must be a non-empty string");
  const target = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`"${value}" is outside the project - every path a tool takes must stay inside it`);
  }
  return target;
}

/**
 * @param {unknown} args
 * @returns {Record<string, unknown>}
 */
function asObject(args) {
  if (typeof args !== "object" || args === null) throw new Error("the tool's arguments must be a JSON object");
  return /** @type {Record<string, unknown>} */ (args);
}

/**
 * @param {string} root
 * @param {string} command
 * @param {number} timeoutMs
 * @returns {Promise<{ exitCode: number | null, output: string, timedOut: boolean }>}
 */
function runShell(root, command, timeoutMs) {
  return new Promise((resolve_) => {
    // bash, not sh: the worker image installs a real bash (its own
    // Dockerfile says why), and a brief's own commands are routinely
    // written for one.
    const child = spawn("bash", ["-c", command], { cwd: root });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve_({ exitCode: null, output: `${output}\ncould not start the command: ${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve_({ exitCode: code, output, timedOut });
    });
  });
}

/**
 * Runs one tool call and returns what to feed back to the model. A
 * failure is a readable message with `isError`, never a thrown error:
 * the model's next turn is where a bad path or a missing file gets
 * corrected, and crashing the loop would throw away every turn already
 * paid for.
 * @param {{ root: string, maxToolOutputChars: number, bashTimeoutMs: number }} env
 * @param {string} name
 * @param {unknown} rawArgs
 * @returns {Promise<{ text: string, isError: boolean }>}
 */
export async function runTool(env, name, rawArgs) {
  try {
    const args = asObject(rawArgs);
    switch (name) {
      case "list_dir": {
        const path = resolveInside(env.root, args.path);
        const entries = readdirSync(path, { withFileTypes: true })
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .sort();
        const shown = relative(env.root, path) || ".";
        return { text: clamp(`${shown}:\n${entries.join("\n")}`, env.maxToolOutputChars), isError: false };
      }
      case "read_file": {
        const path = resolveInside(env.root, args.path);
        if (statSync(path).isDirectory()) throw new Error(`"${args.path}" is a directory - use list_dir`);
        return { text: clamp(readFileSync(path, "utf8"), env.maxToolOutputChars), isError: false };
      }
      case "write_file": {
        const path = resolveInside(env.root, args.path);
        if (typeof args.content !== "string") throw new Error("content must be a string");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, args.content);
        return { text: `wrote ${args.content.length} characters to ${relative(env.root, path)}`, isError: false };
      }
      case "edit_file": {
        const path = resolveInside(env.root, args.path);
        const { oldText, newText, replaceAll } = args;
        if (typeof oldText !== "string" || oldText.length === 0) throw new Error("oldText must be a non-empty string");
        if (typeof newText !== "string") throw new Error("newText must be a string");
        if (!existsSync(path)) throw new Error(`${relative(env.root, path)} does not exist`);
        const before = readFileSync(path, "utf8");
        const occurrences = before.split(oldText).length - 1;
        if (occurrences === 0) throw new Error(`that exact text is not in ${relative(env.root, path)}`);
        if (occurrences > 1 && replaceAll !== true) {
          throw new Error(
            `that text appears ${occurrences} times in ${relative(env.root, path)} - include more surrounding text, ` +
              `or pass replaceAll: true`,
          );
        }
        const after = replaceAll === true ? before.split(oldText).join(newText) : before.replace(oldText, newText);
        writeFileSync(path, after);
        return {
          text: `replaced ${occurrences === 1 ? "1 occurrence" : `${occurrences} occurrences`} in ${relative(env.root, path)}`,
          isError: false,
        };
      }
      case "bash": {
        if (typeof args.command !== "string" || args.command.length === 0) {
          throw new Error("command must be a non-empty string");
        }
        const timeoutMs =
          typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
            ? args.timeoutMs
            : env.bashTimeoutMs;
        const { exitCode, output, timedOut } = await runShell(env.root, args.command, timeoutMs);
        const head = timedOut
          ? `timed out after ${timeoutMs}ms and was killed`
          : `exit code ${exitCode === null ? "unknown" : exitCode}`;
        return { text: clamp(`${head}\n${output}`, env.maxToolOutputChars), isError: timedOut || exitCode !== 0 };
      }
      default:
        throw new Error(`there is no tool called "${name}"`);
    }
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
}

/** Where a session's message history is kept: under the box's own
 * `$HOME`, which src/containment/ mounts per task and keeps across the
 * calls of one task (that is what makes a warm fix round possible here -
 * a direct API holds no session of its own). `$HOME` unset means no
 * persisted home was mounted, in which case nothing is saved and a
 * resume simply starts cold.
 * @param {string} sessionId
 * @returns {string | undefined}
 */
export function sessionPath(sessionId) {
  const home = process.env.HOME;
  if (home === undefined || home === "" || home === "/") return undefined;
  return join(home, ".fabrica-sessions", `${sessionId}.json`);
}

/**
 * @param {string} sessionId
 * @returns {unknown[]}
 */
export function loadSession(sessionId) {
  const path = sessionPath(sessionId);
  if (path === undefined || !existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt or half-written session file is a cold start, never a
    // failed task: the brief a fix round carries already says what to
    // correct.
    return [];
  }
}

/**
 * @param {string} sessionId
 * @param {unknown[]} messages
 */
export function saveSession(sessionId, messages) {
  const path = sessionPath(sessionId);
  if (path === undefined) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(messages));
}

export { resolveInside };
