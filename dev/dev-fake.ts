// `pnpm dev:fake`: starts the fake upstreams and the panel's dev server wired
// to them. Every credential is a throwaway value set here explicitly, so a
// real token in a local .env can never be used (existing env wins over .env).

import { spawn } from "node:child_process";
import { startFakeUpstreams } from "./fake-upstreams.ts";

const PORT = Number(process.env.FAKE_UPSTREAMS_PORT ?? 4010);
const ACTION_DELAY_MS = Number(process.env.FAKE_ACTION_DELAY_MS ?? 2500);
const PASSWORD = "fake";

const fake = await startFakeUpstreams({ port: PORT, hetzner: { actionDelayMs: ACTION_DELAY_MS } });

console.log(`[dev:fake] fake upstreams on http://127.0.0.1:${fake.port}`);
console.log(`[dev:fake] DNS records: http://127.0.0.1:${fake.port}/gandi/_debug/records`);
console.log(`[dev:fake] panel password: ${PASSWORD}`);

const vite = spawn("pnpm", ["exec", "vite", "dev"], {
  stdio: "inherit",
  env: {
    ...process.env,
    ...fake.env,
    HETZNER_API_TOKEN: "fake-hetzner-token",
    GANDI_API_KEY: "fake-gandi-key",
    GANDI_DOMAIN: "fake.test",
    GANDI_RECORD_STARBOUND: "play",
    GANDI_RECORD_FACTORIO: "factorio",
    STEAM_USER: "fake",
    STEAM_PASS: "fake",
    PANEL_PASSWORD: PASSWORD,
    SESSION_SECRET: "fake-session-secret-for-local-dev-only-0123456789",
  },
});

const stop = (code: number) => {
  vite.kill();
  void fake.close().finally(() => process.exit(code));
};
vite.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
