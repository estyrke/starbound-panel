// `pnpm dev:local`: runs the panel against the Docker-backed Hetzner emulator,
// so new worlds are real local containers running the games' unchanged
// cloud-init user_data. Every panel secret is a throwaway value set here
// explicitly, so a real token in a local .env can never be used (existing env
// wins over .env). Steam credentials come from the developer's environment.

import { spawn } from "node:child_process";
import Docker from "dockerode";
import { checkDocker } from "./emulator/docker.ts";
import { createHetznerEmulator } from "./emulator/hetzner-emulator.ts";
import { startFakeUpstreams } from "./fake-upstreams.ts";
import { LOCAL_PANEL_PASSWORD } from "./local-defaults.ts";

const PORT = Number(process.env.LOCAL_UPSTREAMS_PORT ?? 4010);
// Overridable so the e2e tests can run beside a developer's own dev:local
// (own panel port, own container/snapshot namespace).
const PANEL_PORT = process.env.LOCAL_PANEL_PORT?.trim() || "3000";
const NAMESPACE = process.env.LOCAL_NAMESPACE?.trim() || undefined;

const docker = new Docker();
const problem = await checkDocker(docker);
if (problem) {
  console.error(`[dev:local] ${problem}`);
  process.exit(1);
}

// LOCAL_FACTORIO_VERSION pins what counts as the latest Factorio release, so a
// world can be created on an older version and then upgraded to the real latest.
const pinnedFactorio = process.env.LOCAL_FACTORIO_VERSION?.trim() || undefined;
if (pinnedFactorio && !/^\d+\.\d+\.\d+$/.test(pinnedFactorio)) {
  console.error(
    `[dev:local] LOCAL_FACTORIO_VERSION must look like 2.0.55, got "${pinnedFactorio}"`
  );
  process.exit(1);
}

const upstreams = await startFakeUpstreams({
  port: PORT,
  hetzner: createHetznerEmulator({ docker, namespace: NAMESPACE }),
  factorioVersion: pinnedFactorio,
});

console.log(`[dev:local] Hetzner emulator on ${upstreams.env.HETZNER_API_URL}`);
console.log(`[dev:local] panel password: ${LOCAL_PANEL_PASSWORD}`);
if (!process.env.STEAM_USER) {
  console.log(
    "[dev:local] STEAM_USER / STEAM_PASS not set: new Starbound worlds will refuse to start"
  );
}

// FACTORIO_API_URL stays unset (the panel asks the real factorio.com) unless
// the latest version is pinned.
const { HETZNER_API_URL, FACTORIO_API_URL } = upstreams.env;
if (pinnedFactorio) {
  console.log(`[dev:local] Factorio "latest" pinned to ${pinnedFactorio}`);
}
const vite = spawn("pnpm", ["exec", "vite", "dev", "--port", PANEL_PORT, "--strictPort"], {
  stdio: "inherit",
  env: {
    ...process.env,
    HETZNER_API_URL,
    ...(pinnedFactorio ? { FACTORIO_API_URL } : {}),
    HETZNER_API_TOKEN: "local-hetzner-token",
    DNS_PROVIDER: "none",
    PANEL_PASSWORD: LOCAL_PANEL_PASSWORD,
    SESSION_SECRET: "local-session-secret-for-local-dev-only-0123456789",
  },
});

const stop = (code: number) => {
  vite.kill();
  void upstreams.close().finally(() => process.exit(code));
};
vite.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
