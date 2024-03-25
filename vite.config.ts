import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait()
  ],
  build: {
    sourcemap: true, // Enable source maps for production
  },
  publicDir: 'src/public',
  resolve: {
    alias: {
      '@': '/src',
    },
  },
})
