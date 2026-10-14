import { test } from "@playwright/test";
import { E2E_NAMESPACE, E2E_PASSWORD } from "./support/env.ts";
import { cleanupNamespace } from "./support/docker.ts";
import { runWorldLifecycle, type WorldGame } from "./support/world-lifecycle.ts";

// Values below come from the Starbound `user_data` in src/lib/games.ts:
// starbound.service runs as `steam` from /home/steam/starbound/linux, which
// keeps its universe under ../storage.
const starbound: WorldGame = {
  label: "Starbound",
  service: "starbound.service",
  saveDir: "/home/steam/starbound/storage",
  // apt + 32-bit steamcmd under emulation + ~1 GB game download.
  installTimeoutMs: 30 * 60_000,
};

// Local only: CI sets no Steam credentials, so no password is stored in GitHub.
const SKIP_REASON =
  "Starbound e2e needs STEAM_USER and STEAM_PASS (an account that owns Starbound, Steam Guard off or pre-authorised); CI does not set them";
const hasSteamCredentials = Boolean(process.env.STEAM_USER && process.env.STEAM_PASS);
// The list reporter does not print skip reasons, so say it out loud.
if (!hasSteamCredentials) console.log(`[e2e] Skipping Starbound: ${SKIP_REASON}`);
test.skip(!hasSteamCredentials, SKIP_REASON);

// A fresh install plus a restore (which reinstalls) is slow.
test.setTimeout(75 * 60_000);

test.beforeAll(() => cleanupNamespace(E2E_NAMESPACE));
test.afterAll(() => cleanupNamespace(E2E_NAMESPACE));

test("Starbound world survives save & stop and restore", async ({ page }) => {
  await runWorldLifecycle({
    page,
    game: starbound,
    namespace: E2E_NAMESPACE,
    password: E2E_PASSWORD,
    worldName: "e2e-starbound",
  });
});
