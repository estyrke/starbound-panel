import { LOCAL_PANEL_PASSWORD } from "../../dev/local-defaults.ts";

// Ports, namespace and password the e2e run uses (own values so it can run
// beside a developer's own `pnpm dev:local`).
export const E2E_PANEL_PORT = 3100;
export const E2E_UPSTREAMS_PORT = 4011;
export const E2E_NAMESPACE = "e2e";
export const E2E_PASSWORD = LOCAL_PANEL_PASSWORD;
