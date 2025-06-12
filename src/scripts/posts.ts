import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { markdownToHtml } from "./mdToHtml";

const POSTS_DIR = "src/posts";
const OUTPUT_DIR = process.env.POSTS_OUTPUT_DIR || "dist/posts";

// Add a lock to prevent multiple simultaneous generations
let isGenerating = false;

interface Post {
  postName: string;
  title: string;
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.access(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }
}

async function copyAssets(postName: string): Promise<void> {
  const assetsDir = path.join(POSTS_DIR, postName);
  const outputAssetsDir = path.join(OUTPUT_DIR, postName);

  try {
    await fs.access(assetsDir);
    await ensureDir(outputAssetsDir);
    await fs.cp(assetsDir, outputAssetsDir, { recursive: true });
  } catch {
    // No assets directory for this post
  }
}

async function generatePostHtml(filename: string): Promise<Post> {
  const filePath = path.join(POSTS_DIR, filename);
  const content = await fs.readFile(filePath, "utf-8");
  const { data, content: markdownContent } = matter(content);
  const postName = path.basename(filename, ".md");

  // Generate HTML content
  const htmlContent = markdownToHtml(postName, markdownContent);

  // Create the full HTML document
  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${data.title || postName} - Orion Reed</title>
    <link rel="icon" type="image/x-icon" href="/favicon.ico?v=4">
    <link rel="shortcut icon" type="image/x-icon" href="/favicon.ico?v=4">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Recursive:slnt,wght,CASL,CRSV,MONO@-15..0,300..1000,0..1,0..1,0..1&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/css/reset.css">
    <link rel="stylesheet" href="/css/style.css">
    <script data-goatcounter="https://orion.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>
</head>
<body>
    <main>
        <header><a href="/">Orion Reed</a></header>
        <article>
            ${htmlContent}
        </article>
    </main>
</body>
</html>`;

  // Write the HTML file with .html extension
  const outputPath = path.join(OUTPUT_DIR, `${postName}.html`);
  await fs.writeFile(outputPath, fullHtml);

  // Copy any assets
  await copyAssets(postName);

  return { postName, title: data.title || postName };
}

async function generatePosts(): Promise<void> {
  // If already generating, wait for it to complete
  if (isGenerating) {
    console.log("Post generation already in progress, skipping...");
    return;
  }

  try {
    isGenerating = true;
    console.log("Starting post generation...");
    console.log("Posts directory:", POSTS_DIR);
    console.log("Output directory:", OUTPUT_DIR);

    // Ensure output directory exists
    await ensureDir(OUTPUT_DIR);
    console.log("Output directory ensured");

    // Get all markdown files
    const files = await fs.readdir(POSTS_DIR);
    console.log("Found files:", files);
    const markdownFiles = files.filter((f: string) => f.endsWith(".md"));
    console.log("Markdown files:", markdownFiles);

    if (markdownFiles.length === 0) {
      console.log("No markdown files found to process");
      return;
    }

    // Generate HTML for each post
    console.log("Generating HTML for posts...");
    const posts = await Promise.all(
      markdownFiles.map((filename: string) => generatePostHtml(filename))
    );

    // Generate index of posts
    const postsIndex = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Posts - Orion Reed</title>
    <link rel="icon" type="image/x-icon" href="/favicon.ico?v=4">
    <link rel="shortcut icon" type="image/x-icon" href="/favicon.ico?v=4">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Recursive:slnt,wght,CASL,CRSV,MONO@-15..0,300..1000,0..1,0..1,0..1&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/css/reset.css">
    <link rel="stylesheet" href="/css/style.css">
    <script data-goatcounter="https://orion.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>
</head>
<body>
    <main>
        <header><a href="/">Orion Reed</a></header>
        <h1>Posts</h1>
        <ol reversed>
            ${posts
              .map(
                (post: Post) => `
            <li>
                <a href="/posts/${post.postName}">${post.title}</a>
            </li>
            `
              )
              .join("")}
        </ol>
    </main>
</body>
</html>`;

    // Write posts index
    await fs.writeFile(path.join(OUTPUT_DIR, "index.html"), postsIndex);

    console.log(
      "Generated posts:",
      posts.map((p: Post) => p.postName).join(", ")
    );
  } catch (error) {
    console.error("Error generating posts:", error);
    process.exit(1);
  } finally {
    isGenerating = false;
  }
}

// Only run immediately if this file is being run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("Script starting...");
  generatePosts().catch(console.error);
}

export { generatePosts };
