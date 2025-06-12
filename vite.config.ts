import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";

export default defineConfig({
  plugins: [
    {
      name: "generate-posts",
      async closeBundle() {
        // Generate posts after build is complete
        const { generatePosts } = await import("./src/scripts/posts");
        await generatePosts();
      },
      configureServer(server) {
        // Watch posts directory and regenerate on changes
        const watcher = fs.watch("src/posts", { recursive: true }, async () => {
          const { generatePosts } = await import("./src/scripts/posts");
          await generatePosts();
          server.ws.send({ type: "full-reload" });
        });
        server.httpServer?.once("close", () => watcher.close());

        // Serve posts from dist/posts in development mode
        server.middlewares.use("/posts", (req, res, next) => {
          const url = req.url || "";
          // Remove trailing slash and ensure we're looking for an HTML file
          const postName = url.replace(/\/$/, "");
          const postPath = path.join(
            process.cwd(),
            "dist/posts",
            `${postName}.html`
          );

          try {
            if (fs.existsSync(postPath) && fs.statSync(postPath).isFile()) {
              res.setHeader("Content-Type", "text/html");
              fs.createReadStream(postPath).pipe(res);
            } else {
              next();
            }
          } catch (err) {
            next(err);
          }
        });
      },
    },
  ],
  // Ensure CSS is served from the correct location
  publicDir: "public",
});
