import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  statSync,
} from "fs";
import { join, extname, basename } from "path";
import matter from "gray-matter";
import { marked } from "marked";

const POSTS_DIR = "src/posts";
const DIST_DIR = "dist";
const ROOT_DIR = ".";

interface PostData {
  slug: string;
  title: string;
  content: string;
  frontmatter: any;
}

function generatePostHTML(post: PostData): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${post.title}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Recursive:slnt,wght,CASL,CRSV,MONO@-15..0,300..1000,0..1,0..1,0..1&display=swap&font-display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="/css/reset.css" />
    <link rel="stylesheet" href="/css/style.css" />
  </head>
  <body>
    <div id="root">
      <main>
        <header>
          <a href="/" style="text-decoration: none;">Orion Reed</a>
          <h1>${post.title}</h1>
        </header>
        ${post.content}
      </main>
    </div>
  </body>
</html>`;
}

function processMarkdownFile(filePath: string): PostData {
  const content = readFileSync(filePath, "utf-8");
  const { content: markdownContent, data: frontmatter } = matter(content);
  const slug = basename(filePath, ".md");
  const title = frontmatter.title || slug;

  // Configure marked to handle media files properly
  marked.use({
    renderer: {
      image(href: string, title: string | null, text: string) {
        const mediaPath = href.startsWith("/")
          ? href
          : `/posts/${slug}/${href}`;

        // For video files, use video tag
        if (mediaPath.match(/\.(mp4|mov)$/i)) {
          return `<video controls><source src="${mediaPath}" type="video/${
            mediaPath.endsWith(".mov") ? "quicktime" : "mp4"
          }">Your browser does not support the video tag.</video>`;
        }

        // For images, use img tag
        return `<img src="${mediaPath}" alt="${text || ""}"${
          title ? ` title="${title}"` : ""
        }>`;
      },
    },
  });

  const htmlContent = marked.parse(markdownContent) as string;

  return {
    slug,
    title,
    content: htmlContent,
    frontmatter,
  };
}

function copyMediaFiles(slug: string, outputDir: string) {
  const sourceMediaDir = join(POSTS_DIR, slug);
  const targetMediaDir = join(outputDir, "posts", slug);

  if (!existsSync(sourceMediaDir)) {
    return; // No media directory for this post
  }

  // Ensure target directory exists
  if (!existsSync(targetMediaDir)) {
    mkdirSync(targetMediaDir, { recursive: true });
  }

  // Copy all files from source media directory
  const files = readdirSync(sourceMediaDir);
  files.forEach((file) => {
    const sourcePath = join(sourceMediaDir, file);
    const targetPath = join(targetMediaDir, file);

    if (statSync(sourcePath).isFile()) {
      copyFileSync(sourcePath, targetPath);
    }
  });
}

export function buildPosts() {
  console.log("🔨 Building posts...");

  if (!existsSync(POSTS_DIR)) {
    console.log("No posts directory found, skipping...");
    return;
  }

  const files = readdirSync(POSTS_DIR);
  const markdownFiles = files.filter((file) => extname(file) === ".md");

  if (markdownFiles.length === 0) {
    console.log("No markdown files found in posts directory");
    return;
  }

  // For dev: build to root; for production: check if dist exists (after vite build)
  const outputDirs = existsSync(DIST_DIR) ? [ROOT_DIR, DIST_DIR] : [ROOT_DIR];

  outputDirs.forEach((outputDir) => {
    // Ensure posts directory exists
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
    if (!existsSync(join(outputDir, "posts"))) {
      mkdirSync(join(outputDir, "posts"), { recursive: true });
    }

    markdownFiles.forEach((file) => {
      const filePath = join(POSTS_DIR, file);
      const post = processMarkdownFile(filePath);
      const html = generatePostHTML(post);

      // Create directory for the post
      const postDir = join(outputDir, "posts", post.slug);
      if (!existsSync(postDir)) {
        mkdirSync(postDir, { recursive: true });
      }

      // Write the HTML file
      writeFileSync(join(postDir, "index.html"), html);

      // Copy media files for this post
      copyMediaFiles(post.slug, outputDir);
    });
  });

  console.log(`✅ Built ${markdownFiles.length} posts`);
}

// Always run when this file is executed
buildPosts();
