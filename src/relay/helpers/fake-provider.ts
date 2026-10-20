// A stand-in for "the model provider" (issue #186's own test setup: "a
// fake worker and a fake provider"). Plain HTTP, not HTTPS - the
// relay's gateway forwarding code path is identical either way
// (`node:https`'s request() has the same shape as `node:http`'s), and a
// fast test has no business standing up a throwaway TLS certificate
// just to prove header-swapping logic. Records every request it
// receives so a test can assert on exactly what crossed the wire -
// in particular, that the real credential arrived and the fake one
// never did.

import * as http from "node:http";

export interface FakeProviderRequest {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface FakeProviderHandle {
  readonly port: number;
  readonly requests: readonly FakeProviderRequest[];
  close(): Promise<void>;
}

export async function startFakeProvider(
  opts: {
    status?: number;
    body?: string;
    /** Response headers this provider sends back, by request count
     * (1-based) - a provider whose own rate-limit headers move between
     * responses, which is the shape issue #189's reading comes from.
     * Omitted, only content-type is sent. */
    responseHeaders?: (call: number) => Record<string, string>;
  } = {}
): Promise<FakeProviderHandle> {
  const requests: FakeProviderRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(opts.status ?? 200, {
        "content-type": "text/plain",
        ...(opts.responseHeaders?.(requests.length) ?? {}),
      });
      res.end(opts.body ?? "ok");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake provider listened but reported no port");

  return {
    port: address.port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
