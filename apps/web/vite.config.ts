import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Port dédié : 5173 est utilisé par d'autres projets.
  server: { port: 5180, strictPort: true },
  preview: { port: 5180, strictPort: true },
});
