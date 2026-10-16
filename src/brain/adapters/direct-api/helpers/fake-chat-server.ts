// A tiny stand-in for an OpenAI-compatible /chat/completions endpoint
// (what both OpenRouter and Ollama's own OpenAI-compatible surface speak
// - see direct-api.md), scripted with a fixed queue of responses. Lets
// worker-loop.mjs's own logic (the tool-calling loop, cost accounting,
// session persistence) be tested fast and deterministically, with no
// real network call and no Docker - the real HTTP shape only, verified
// against the real providers' documentation (direct-api.md records
// where).

import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface ScriptedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** One scripted assistant turn. `costUsd` omitted means the response
 * carries no `usage.cost` at all, standing in for a provider that didn't
 * report one - never assumed to be zero. */
export interface ScriptedResponse {
  content?: string | null;
  toolCalls?: ScriptedToolCall[];
  costUsd?: number;
}

export interface FakeChatServer {
  url: string;
  /** Every request body this server received, in order - so a test can
   * assert on what the loop actually sent (message history, tools). */
  requests: unknown[];
  close(): Promise<void>;
}

/** Starts the server and serves `responses` in order, one per POST - the
 * last one repeats for any call past the end of the queue (a test that
 * wants to assert "never called again" checks `requests.length` itself
 * rather than relying on the server to refuse). */
export async function startFakeChatServer(responses: ScriptedResponse[]): Promise<FakeChatServer> {
  const requests: unknown[] = [];
  let index = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: unknown = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        // An empty or unparseable body is still recorded as-is below.
      }
      requests.push(body);

      const scripted = responses[Math.min(index, responses.length - 1)];
      index += 1;

      const toolCalls = scripted?.toolCalls?.map((call, i) => ({
        id: `call_${requests.length}_${i}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      }));

      const payload = {
        id: `fake-${requests.length}`,
        choices: [
          {
            message: {
              role: "assistant",
              content: scripted?.content ?? null,
              ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
          },
        ],
        usage: scripted?.costUsd !== undefined ? { cost: scripted.costUsd } : {},
      };

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
