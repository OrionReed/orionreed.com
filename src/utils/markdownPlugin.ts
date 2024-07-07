import { Plugin } from 'vite'
import matter from 'gray-matter';
import { markdownToHtml } from './markdownToHtml';
import path from 'path';

export const markdownPlugin: Plugin = {
  name: 'markdown-plugin',
  enforce: 'pre',
  transform(code, id) {
    if (id.endsWith('.md')) {
      const { data, content } = matter(code);
      const filename = path.basename(id, '.md');
      const html = markdownToHtml(filename, content);
      const htmlString = JSON.stringify({ html });
      return `export default ${htmlString};`;
    }
  },
};