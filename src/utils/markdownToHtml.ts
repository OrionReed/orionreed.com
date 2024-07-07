import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
  html: true,
  breaks: true,
  linkify: true,
});

// Customize Markdown-to-HTML mapping here
md.renderer.rules.paragraph_open = () => '<p class="custom-paragraph">';
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const src = token.attrGet('src');
  const alt = token.content;
  return `<img src="${src}" alt="${alt}" class="custom-image" />`;
};

export function markdownToHtml(content: string): string {
  return md.render(content);
}