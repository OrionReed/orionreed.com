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
import markedKatex from "marked-katex-extension";
import markedFootnote from "marked-footnote";

const POSTS_DIR = "src/posts";
const DIST_DIR = "dist";
const ROOT_DIR = ".";

interface PostData {
  slug: string;
  title: string;
  content: string;
  frontmatter: any;
  readingTime: number;
}

function calculateReadingTime(content: string): number {
  // First remove script tags and their content
  const contentWithoutScripts = content.replace(
    /<script(?:\s[^>]*)?>[\s\S]*?<\/script>/gi,
    ""
  );
  // Then strip remaining HTML tags and count words
  const textContent = contentWithoutScripts.replace(/<[^>]*>/g, "");
  const wordCount = textContent.trim().split(/\s+/).length;
  // Average reading speed is ~250 words per minute (faster assumption)
  return Math.ceil(wordCount / 250);
}

function extractAndDeferScripts(htmlContent: string): {
  content: string;
  scripts: string[];
} {
  const scripts: string[] = [];
  const scriptRegex = /<script(?:\s[^>]*)?>[\s\S]*?<\/script>/gi;

  const contentWithoutScripts = htmlContent.replace(scriptRegex, (match) => {
    // Extract script content
    const scriptContent = match.replace(
      /<script(?:\s[^>]*)?>|<\/script>/gi,
      ""
    );
    if (scriptContent.trim()) {
      scripts.push(scriptContent.trim());
    }
    return ""; // Remove the script tag
  });

  return { content: contentWithoutScripts, scripts };
}

function generatePostHTML(
  post: PostData,
  isProduction: boolean = false
): string {
  // Format date if available
  const dateStr = post.frontmatter.date
    ? new Date(post.frontmatter.date).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  // Use different script paths for dev vs production
  const elementsScript = isProduction
    ? "/js/elements.js"
    : "/src/elements/index.ts";

  // Extract inline scripts and defer them
  const { content: contentWithoutScripts, scripts } = extractAndDeferScripts(
    post.content
  );

  // Create deferred script execution
  const deferredScripts =
    scripts.length > 0
      ? `
    <script type="module">
      
      // Execute extracted scripts
      ${scripts
        .map(
          (script) => `
        (async () => {
          ${script}
        })();
      `
        )
        .join("\n")}
    </script>
  `
      : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${post.title} - Orion Reed</title>
    <link rel="icon" type="image/x-icon" href="/favicon.ico?v=4" />
    <link rel="shortcut icon" type="image/x-icon" href="/favicon.ico?v=4" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Recursive:slnt,wght,CASL,CRSV,MONO@-15..0,300..1000,0..1,0..1,0..1&display=swap"
      rel="stylesheet"
    />
    <link
      rel="preload"
      href="https://fonts.googleapis.com/css2?family=Recursive:slnt,wght,CASL,CRSV,MONO@-15..0,300..1000,0..1,0..1,0..1&display=swap"
      as="style"
    />
    <link rel="stylesheet" href="/css/reset.css" />
    <link rel="stylesheet" href="/css/style.css" />
    
    <!-- Prevent flash of unstyled content by applying theme immediately -->
    <script>
      (function() {
        const savedTheme = localStorage.getItem('theme');
        const theme = savedTheme || 'light';
        document.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light';
      })();
    </script>

    <!-- KaTeX for LaTeX rendering -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css" integrity="sha384-GvrOXuhMATgEsSwCs4smul74iXGOixntILdUW9XmUC6+HX0sLNAK3q71HotJqlAn" crossorigin="anonymous">

    <!-- Social Meta Tags -->
    <meta
      name="description"
      content="${post.frontmatter.description || post.title}"
    />
    <meta property="og:url" content="https://orionreed.com/posts/${
      post.slug
    }/" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${post.title}" />
    <meta
      property="og:description"
      content="${post.frontmatter.description || post.title}"
    />
    <meta property="og:image" content="https://orionreed.com/website-embed.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta property="twitter:domain" content="orionreed.com" />
    <meta property="twitter:url" content="https://orionreed.com/posts/${
      post.slug
    }/" />
    <meta name="twitter:title" content="${post.title}" />
    <meta
      name="twitter:description"
      content="${post.frontmatter.description || post.title}"
    />
    <meta name="twitter:image" content="https://orionreed.com/website-embed.png" />

    <!-- Analytics -->
    <script
      data-goatcounter="https://orion.goatcounter.com/count"
      async
      src="//gc.zgo.at/count.js"
    ></script>
  </head>
  <body>
    <dark-mode-toggle></dark-mode-toggle>
    <main class="post">
      <header>
        <a href="/" style="text-decoration: none;">Orion Reed</a>
      </header>
      <div style="display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 1rem;">
        <h1 style="margin: 0;">${post.title}</h1>
        <span style="color: var(--text-secondary); font-size: 0.9em;">
          ${dateStr ? `${dateStr} • ` : ""}${post.readingTime} min read
        </span>
      </div>
      <style>
        @media (max-width: 767px) {
          .post header + div {
            flex-direction: column !important;
            align-items: flex-start !important;
          }
          .post header + div span {
            margin-top: 0.5rem;
          }
        }
      </style>
      ${contentWithoutScripts}
    </main>
    <script type="module" src="${elementsScript}"></script>
    ${deferredScripts}
  </body>
</html>`;
}

function processMarkdownFile(filePath: string): PostData {
  const content = readFileSync(filePath, "utf-8");
  const { content: markdownContent, data: frontmatter } = matter(content);
  const slug = basename(filePath, ".md");
  const title = frontmatter.title || slug;

  // Configure marked to handle media files and LaTeX
  marked
    .use(markedFootnote())
    .use(
      markedKatex({
        throwOnError: false,
      })
    )
    .use({
      renderer: {
        code(code: string, language?: string) {
          // Convert code blocks to md-syntax elements
          const lang = language ? ` lang="${language}"` : "";
          return `<md-syntax${lang}>${code}</md-syntax>`;
        },
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
  const readingTime = calculateReadingTime(htmlContent);

  return {
    slug,
    title,
    content: htmlContent,
    frontmatter,
    readingTime,
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
      const isProduction = outputDir === DIST_DIR;
      const html = generatePostHTML(post, isProduction);

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
