import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  environments: {
    pastekey: {
      build: {
        minify: true,
        sourcemap: true,
      },
    },
  },
  plugins: [react(), cloudflare()],
});
