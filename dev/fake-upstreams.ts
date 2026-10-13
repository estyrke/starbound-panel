// Local stand-ins for the external services the panel talks to (Hetzner,
// Gandi, factorio.com), served from one HTTP server with a router per
// upstream. Nothing here ever talks to a real service.

import { createServer, type Server } from "node:http";
import { createFakeFactorio } from "./fake-factorio.ts";
import { createFakeGandi } from "./fake-gandi.ts";
import { createFakeHetzner, type FakeHetznerOptions } from "./fake-hetzner.ts";
import type { FakeRouter } from "./types.ts";

export interface FakeUpstreamsOptions {
  port?: number;
  hetzner?: FakeHetznerOptions;
  log?: (line: string) => void;
}

export interface RunningFakeUpstreams {
  server: Server;
  port: number;
  // Base URLs to hand to the panel through its *_API_URL env vars.
  env: { HETZNER_API_URL: string; GANDI_API_URL: string; FACTORIO_API_URL: string };
  close: () => Promise<void>;
}

export async function startFakeUpstreams({
  port = 0,
  hetzner,
  log = console.log,
}: FakeUpstreamsOptions = {}): Promise<RunningFakeUpstreams> {
  const gandi = createFakeGandi({ log });
  const mounts: [string, FakeRouter][] = [
    ["/hetzner", createFakeHetzner({ log, ...hetzner })],
    ["/gandi", gandi.router],
    ["/factorio", createFakeFactorio()],
  ];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const mount = mounts.find(([prefix]) => url.pathname.startsWith(`${prefix}/`));

    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: unknown = undefined;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
    }

    const out = mount?.[1]({
      method: req.method ?? "GET",
      path: url.pathname.slice(mount[0].length),
      query: url.searchParams,
      headers: req.headers,
      body,
    });
    if (!out) {
      log(`[fake-upstreams] no route: ${req.method} ${url.pathname}`);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "no fake route" } }));
      return;
    }
    if (out.body === undefined) {
      res.writeHead(out.status).end();
      return;
    }
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actualPort = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${actualPort}`;

  return {
    server,
    port: actualPort,
    env: {
      HETZNER_API_URL: `${origin}/hetzner/v1/`,
      GANDI_API_URL: `${origin}/gandi/v5/livedns`,
      FACTORIO_API_URL: `${origin}/factorio/api/latest-releases`,
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
