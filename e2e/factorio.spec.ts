import { test } from "@playwright/test";
import { E2E_NAMESPACE, E2E_PASSWORD } from "./support/env.ts";
import { cleanupNamespace } from "./support/docker.ts";
import { runWorldLifecycle, type WorldGame } from "./support/world-lifecycle.ts";

const factorio: WorldGame = {
  label: "Factorio",
  service: "factorio.service",
  saveDir: "/opt/factorio/saves",
  installTimeoutMs: 10 * 60_000,
};

test.beforeAll(() => cleanupNamespace(E2E_NAMESPACE));
test.afterAll(() => cleanupNamespace(E2E_NAMESPACE));

test("Factorio world survives save & stop and restore", async ({ page }) => {
  await runWorldLifecycle({
    page,
    game: factorio,
    namespace: E2E_NAMESPACE,
    password: E2E_PASSWORD,
    worldName: "e2e-factorio",
  });
});
