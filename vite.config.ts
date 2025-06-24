import { defineConfig } from "vite";
import { buildPosts } from "./scripts/build";
import mkcert from "vite-plugin-mkcert";

export default defineConfig({
  plugins: [
    mkcert(),
    {
      name: "posts-watcher",
      configureServer(server) {
        server.watcher.add("/src/posts/**/*");
        server.watcher.on("change", (file) => {
          if (file.includes("src/posts/")) {
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
