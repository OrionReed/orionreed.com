import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { vitePluginMdToHTML } from 'vite-plugin-md-to-html'

export default defineConfig({
  plugins: [
    preact(),
    vitePluginMdToHTML({
      resolveImageLinks: true,
    }),
  ],
})
