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

const PORT = Number(process.env.LOCAL_UPSTREAMS_PORT ?? 4010);
const PASSWORD = "local";

const docker = new Docker();
const problem = await checkDocker(docker);
if (problem) {
  console.error(`[dev:local] ${problem}`);
  process.exit(1);
}

const upstreams = await startFakeUpstreams({
  port: PORT,
  hetzner: createHetznerEmulator({ docker }),
});

console.log(`[dev:local] Hetzner emulator on ${upstreams.env.HETZNER_API_URL}`);
console.log(`[dev:local] panel password: ${PASSWORD}`);
if (!process.env.STEAM_USER) {
  console.log(
    "[dev:local] STEAM_USER / STEAM_PASS not set: new Starbound worlds will refuse to start"
  );
}

// FACTORIO_API_URL stays unset: the panel asks the real factorio.com.
const { HETZNER_API_URL } = upstreams.env;
const vite = spawn("pnpm", ["exec", "vite", "dev"], {
  stdio: "inherit",
  env: {
    ...process.env,
    HETZNER_API_URL,
    HETZNER_API_TOKEN: "local-hetzner-token",
    DNS_PROVIDER: "none",
    PANEL_PASSWORD: PASSWORD,
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
