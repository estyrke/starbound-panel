import { defineConfig } from "@playwright/test";
import { E2E_NAMESPACE, E2E_PANEL_PORT, E2E_UPSTREAMS_PORT } from "./e2e/support/env.ts";

// Real-game e2e: browser -> panel on `dev:local` -> Hetzner emulator -> Docker.
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  // Factorio download + map generation, plus a save & stop / start cycle.
  timeout: 20 * 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${E2E_PANEL_PORT}`,
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm dev:local",
    url: `http://localhost:${E2E_PANEL_PORT}`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      LOCAL_PANEL_PORT: String(E2E_PANEL_PORT),
      LOCAL_UPSTREAMS_PORT: String(E2E_UPSTREAMS_PORT),
      LOCAL_NAMESPACE: E2E_NAMESPACE,
    },
  },
});
