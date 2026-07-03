import { defineConfig } from "vite";

// relative base so the build works regardless of the host path
export default defineConfig({
  base: "./",
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 1500,
  },
});
