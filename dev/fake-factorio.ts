// Fake factorio.com: only the latest-releases lookup the panel uses.

import type { FakeRouter } from "./types.ts";

export const FAKE_FACTORIO_VERSION = "2.0.55";

export function createFakeFactorio(): FakeRouter {
  return (req) => {
    if (req.method === "GET" && req.path === "/api/latest-releases") {
      return {
        status: 200,
        body: {
          stable: {
            alpha: FAKE_FACTORIO_VERSION,
            demo: FAKE_FACTORIO_VERSION,
            headless: FAKE_FACTORIO_VERSION,
          },
          experimental: {
            alpha: FAKE_FACTORIO_VERSION,
            demo: FAKE_FACTORIO_VERSION,
            headless: FAKE_FACTORIO_VERSION,
          },
        },
      };
    }
    return undefined;
  };
}
