// Fake Gandi LiveDNS: stores A/AAAA records in memory, logs every update and
// exposes them at GET /_debug/records.

import type { FakeRouter } from "./types.ts";

export interface FakeGandiOptions {
  log?: (line: string) => void;
}

export interface FakeGandi {
  router: FakeRouter;
  records: () => Record<string, { values: string[]; ttl: number }>;
}

export function createFakeGandi({ log = console.log }: FakeGandiOptions = {}): FakeGandi {
  const store = new Map<string, { values: string[]; ttl: number }>();

  const router: FakeRouter = (req) => {
    if (req.method === "GET" && req.path === "/_debug/records") {
      return { status: 200, body: Object.fromEntries(store) };
    }

    const m = /^\/v5\/livedns\/domains\/([^/]+)\/records\/([^/]+)\/(A|AAAA)$/.exec(req.path);
    if (m && req.method === "PUT") {
      const auth = req.headers.authorization;
      if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
        return { status: 401, body: { message: "Missing or invalid Authorization header" } };
      }
      const body = req.body as { rrset_values?: unknown; rrset_ttl?: unknown } | null;
      if (
        !Array.isArray(body?.rrset_values) ||
        !body.rrset_values.every((v) => typeof v === "string")
      ) {
        return { status: 400, body: { message: "rrset_values must be an array of strings" } };
      }
      const [, domain, record, type] = m;
      const key = `${record}.${domain} ${type}`;
      const ttl = typeof body.rrset_ttl === "number" ? body.rrset_ttl : 300;
      store.set(key, { values: body.rrset_values as string[], ttl });
      log(`[fake-gandi] ${key} -> ${(body.rrset_values as string[]).join(", ")} (ttl ${ttl})`);
      return { status: 201, body: { message: "DNS Record Created" } };
    }
    return undefined;
  };

  return { router, records: () => Object.fromEntries(store) };
}
