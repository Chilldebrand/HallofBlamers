import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/HallofBlamers/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
  build: { outDir: "dist", sourcemap: false },
  server: { host: "127.0.0.1", port: 4173 },
});
