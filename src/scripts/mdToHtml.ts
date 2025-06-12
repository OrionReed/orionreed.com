import MarkdownIt from "markdown-it";
// @ts-ignore
import markdownLatex from "markdown-it-latex2img";

const md = new MarkdownIt({
  html: true,
  breaks: true,
  linkify: true,
});

md.use(markdownLatex);

md.renderer.rules.code_block = (_tokens, idx, _options, _env, _self) => {
  const token = _tokens[idx];
  return `<code>${token.content}</code>`;
};

md.renderer.rules.image = (_tokens, idx, _options, env, _self) => {
  const token = _tokens[idx];
  const src = token.attrGet("src");
  const alt = token.content;
  const postName = (env as { postName: string }).postName;

  if (!src) return "";

  const formattedSrc = `/posts/${postName}/${src}`;

  if (src.endsWith(".mp4") || src.endsWith(".mov")) {
    return `<video controls loop><source src="${formattedSrc}" type="video/mp4"></video>`;
  }

  return `<img src="${formattedSrc}" alt="${alt}" />`;
};

export function markdownToHtml(postName: string, content: string): string {
  return md.render(content, { postName });
}
