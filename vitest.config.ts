import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const minimRoot = fileURLToPath(new URL("./src/minim", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@minim": minimRoot },
  },
  test: {
    include: ["src/minim/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/_anim_lab/**", "**/setup.ts"],
    environment: "node",
    setupFiles: ["src/minim/_anim_alt/_test/setup.ts"],
  },
});
