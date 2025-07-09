import { defineConfig } from "vite";
import { buildPosts } from "./scripts/build";
import mkcert from "vite-plugin-mkcert";

export default defineConfig({
  server: {
    port: 5555,
  },
  build: {
    minify: false,
    rollupOptions: {
      input: {
        main: "index.html",
        elements: "src/elements/index.ts",
      },
      output: {
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
