import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const minimRoot = fileURLToPath(new URL("./src/minim", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@minim": minimRoot },
  },
  test: {
    include: ["src/minim/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/_bench/**"],
    environment: "node",
    setupFiles: ["src/minim/_test/setup.ts"],
  },
});
