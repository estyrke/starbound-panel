import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 3000,
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tanstackStart(),
    nitro({
      // The Hetzner client reads hetzner-cloud.openapi.json from its own
      // directory at runtime, so trace the whole package into node_modules
      // instead of bundling only its JS.
      traceDeps: ["@small-tech/hetzner-cloud-openapi-client*"],
    }),
    // react's vite plugin must come after start's vite plugin
    viteReact(),
  ],
});
