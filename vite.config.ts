import { markdownPlugin } from './src/utils/markdownPlugin';
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { viteStaticCopy } from 'vite-plugin-static-copy';


export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    markdownPlugin,
    viteStaticCopy({
      targets: [
        {
          src: 'src/posts/!(*.md)', // Copy all files except .md files
          dest: 'posts'
        }
      ]
    })
  ],
  build: {
    sourcemap: true,
  },
  publicDir: 'src/public',
  resolve: {
    alias: {
      '@': '/src',
    },
  },
})
