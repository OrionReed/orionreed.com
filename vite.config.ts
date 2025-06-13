import { defineConfig } from "vite";
import mkcert from "vite-plugin-mkcert";

export default defineConfig({
  plugins: [mkcert()],
  build: {
    // Simple build config
    rollupOptions: {
      input: {
        main: "index.html",
      },
    },
  },
  server: {
    headers: {
      "Service-Worker-Allowed": "/",
    },
  },
});
