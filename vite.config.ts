import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import matter from 'gray-matter';
import { markdownToHtml } from './src/utils/markdownToHtml';

const markdownPlugin: Plugin = {
  name: 'markdown-plugin',
  enforce: 'pre',
  transform(code, id) {
    if (id.endsWith('.md')) {
      const { data, content } = matter(code);
      const html = markdownToHtml(content);
      const jsonContent = JSON.stringify({ ...data, html });
      return `export default ${jsonContent};`;
    }
  },
};

export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    markdownPlugin
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
