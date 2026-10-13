// A tiny, read-only HTTP server for watching what the factory is doing
// (issue #26). It never binds anywhere but the loopback interface, never
// takes any input from the page beyond which task id was clicked, and
// never writes anything to disk - every handler below only ever calls
// `readFileSync`/`readdirSync` (directly, or through src/index.ts).

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { TASK_ID_PATTERN } from "../../src/index.ts";
import { createRecordView } from "./record-view.ts";

export const DEFAULT_PORT = 7777;
/** Hardcoded, not a parameter anywhere in this module: there is no way to
 * ask this server to listen on anything but loopback. */
const HOST = "127.0.0.1";

const PUBLIC_DIR = fileURLToPath(new URL("./public", import.meta.url));

const STATIC_FILES: Record<string, { file: string; contentType: string }> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", contentType: "text/css; charset=utf-8" },
};

const TRANSCRIPT_PATH = /^\/api\/tasks\/([^/]+)\/transcript$/;

export interface LiveView {
  readonly port: number;
  /** The underlying Node server, so a caller (a test, mainly) can
   * confirm for itself exactly what address it bound - not just trust
   * that this module asked for the right one. */
  readonly server: ReturnType<typeof createServer>;
  close(): Promise<void>;
}

/** Starts the live view. Always on 127.0.0.1 - HOST above is not a
 * parameter anywhere in this function's signature, so there is no way
 * for a caller to ask for anything else. `port` defaults to 7777 (the
 * documented address) but tests pass 0 for an OS-assigned one so many
 * can run at once without colliding. */
export function startLiveView(opts: { recordHome: string; port?: number }): Promise<LiveView> {
  const view = createRecordView(opts.recordHome);
  const server = createServer((req, res) => handleRequest(req, res, view));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? DEFAULT_PORT, HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : (opts.port ?? DEFAULT_PORT);
      resolve({
        port,
        server,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function handleRequest(req: IncomingMessage, res: ServerResponse, view: ReturnType<typeof createRecordView>): void {
  const url = new URL(req.url ?? "/", `http://${HOST}`);

  if (req.method !== "GET") {
    send(res, 405, "text/plain; charset=utf-8", "This server only ever reads - only GET is supported.");
    return;
  }

  const staticFile = STATIC_FILES[url.pathname];
  if (staticFile) {
    send(res, 200, staticFile.contentType, readFileSync(join(PUBLIC_DIR, staticFile.file)));
    return;
  }

  if (url.pathname === "/api/state") {
    send(res, 200, "application/json", JSON.stringify(view.getState()));
    return;
  }

  const transcriptMatch = TRANSCRIPT_PATH.exec(url.pathname);
  if (transcriptMatch) {
    const taskId = decodeURIComponent(transcriptMatch[1]);
    if (!TASK_ID_PATTERN.test(taskId)) {
      send(res, 400, "text/plain; charset=utf-8", "Not a task id.");
      return;
    }
    const transcript = view.getTranscript(taskId);
    if (transcript === null) {
      send(res, 404, "text/plain; charset=utf-8", "No such task.");
      return;
    }
    send(res, 200, "application/json", JSON.stringify({ transcript }));
    return;
  }

  send(res, 404, "text/plain; charset=utf-8", "Not found.");
}

function send(res: ServerResponse, status: number, contentType: string, body: string | Buffer): void {
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(body);
}
