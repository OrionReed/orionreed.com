import { defineConfig } from "vite";
import { buildPosts } from "./scripts/build";
import mkcert from "vite-plugin-mkcert";

export default defineConfig({
  server: {
    port: 5555,
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
