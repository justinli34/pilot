import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { loadConfig } from "./src/server/config.js";

export default defineConfig(async ({ command, mode }) => {
  const config =
    command === "serve" && mode !== "test" ? await loadConfig({ mode: "development" }) : undefined;

  return {
    plugins: [react()],
    build: {
      outDir: "dist/client",
      emptyOutDir: false,
      sourcemap: false,
      chunkSizeWarningLimit: 400,
    },
    ...(config
      ? {
          server: {
            host: config.host,
            proxy: {
              "/api": {
                target: `http://${config.host}:${config.port}`,
                ws: true,
              },
            },
          },
        }
      : {}),
  };
});
