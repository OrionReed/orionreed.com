import { defineConfig } from "vite";
import { buildPosts } from "./scripts/build";
import mkcert from "vite-plugin-mkcert";
import { fileURLToPath } from "node:url";

const minimRoot = fileURLToPath(new URL("./src/minim", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@minim": minimRoot,
    },
  },
  server: {
    port: 5555,
  },
  build: {
    minify: false,
    target: "esnext",
    rollupOptions: {
      input: {
        main: "index.html",
        elements: "src/elements/index.ts",
      },
      output: {
        format: "es",
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === "elements") {
            return "js/elements.js";
          }
          return "js/[name]-[hash].js";
        },
        chunkFileNames: "js/[name]-[hash].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css")) {
            return "css/[name]-[hash][extname]";
          }
          return "assets/[name]-[hash][extname]";
        },
      },
    },
  },
  esbuild: {
    keepNames: true,
  },
  plugins: [
    mkcert(),
    {
      name: "posts-watcher",
      configureServer(server) {
        server.watcher.add("/src/posts/**/*");
        server.watcher.add("/src/elements/**/*");
        server.watcher.on("change", (file) => {
          if (file.includes("src/posts/") || file.includes("src/elements/")) {
            buildPosts();
            server.ws.send({
              type: "full-reload",
            });
          }
        });
      },
    },
  ],
});
