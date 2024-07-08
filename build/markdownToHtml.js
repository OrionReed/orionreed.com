import MarkdownIt from "markdown-it";
// import markdownItLatex from "markdown-it-latex";
import markdownLatex from "markdown-it-latex2img";

const md = new MarkdownIt({
	html: true,
	breaks: true,
	linkify: true,
});

md.use(
	markdownLatex,
	// {style: "width: 200%; height: 200%;",}
);

// const mediaSrc = (folderName, fileName) => {
// 	return `/posts/${folderName}/${fileName}`;
// };

md.renderer.rules.code_block = (tokens, idx, options, env, self) => {
	console.log("tokens", tokens);
	return `<code>${tokens[idx].content}</code>`;
};
md.renderer.rules.image = (tokens, idx, options, env, self) => {
	const token = tokens[idx];
	const src = token.attrGet("src");
	const alt = token.content;
	const postName = env.postName;
	const formattedSrc = `/posts/${postName}/${src}`;

	if (src.endsWith(".mp4") || src.endsWith(".mov")) {
		return `<video controls>
              <source src="${formattedSrc}" type="video/mp4">
            </video>`;
	}

	return `<img src="${formattedSrc}" alt="${alt}" />`;
};

export function markdownToHtml(postName, content) {
	return md.render(content, { postName: postName });
}
