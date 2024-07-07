import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
  html: true,
  breaks: true,
  linkify: true,
});

const mediaSrc = (folderName: string, fileName: string) => {
  return `/posts/${folderName}/${fileName}`
}

// Customize Markdown-to-HTML mapping here
// md.renderer.rules.paragraph_open = () => '<p class="custom-paragraph">';
md.renderer.rules.code_block = (tokens, idx, options, env, self) => {
  console.log('tokens', tokens)
  return `<code>${tokens[idx].content}</code>`;
}
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  // console.log('env', env)
  const token = tokens[idx];
  const src = token.attrGet('src');
  const alt = token.content
  const postName = env.postName
  const formattedSrc = mediaSrc(postName, src)

  if (src.endsWith('.mp4')) {
    return `<video controls>
              <source src="${formattedSrc}" type="video/mp4">
              Your browser does not support the video tag.
            </video>`;
  }

  return `<img src="${formattedSrc}" alt="${alt}" />`;

};

export function markdownToHtml(postName: string, content: string): string {
  return md.render(content, { postName: postName });
}