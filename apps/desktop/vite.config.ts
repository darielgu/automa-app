import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // The packaged app loads index.html over file://, where an absolute
  // "/assets/..." resolves to the filesystem root and the window comes up
  // blank. Relative asset URLs are required for a working build.
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  server: {
    port: 5173
  }
});
