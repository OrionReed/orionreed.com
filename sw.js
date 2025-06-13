/// <reference lib="webworker" />

// Import marked from CDN since we can't use npm modules in a plain JS service worker
importScripts('https://cdn.jsdelivr.net/npm/marked/marked.min.js');
importScripts('https://cdn.jsdelivr.net/npm/gray-matter@4.0.3/dist/gray-matter.min.js');

// Transform markdown to HTML
async function transformPost(content, slug) {
  // Parse frontmatter and get title
  const { content: markdownContent, data: frontmatter } = matter(content);
  const title = frontmatter.title || slug;

  // Configure marked to always use absolute paths for media
  marked.use({
    renderer: {
      image(href, title, text) {
        const mediaFile = href.href;
        const mediaPath = `/posts/${slug}/${mediaFile}`;
        
        // For video files, use video tag
        if (mediaPath.match(/\.(mp4|mov)$/i)) {
          return `<video controls><source src="${mediaPath}" type="video/${mediaPath.endsWith('.mov') ? 'quicktime' : 'mp4'}">Your browser does not support the video tag.</video>`;
        }
        
        // For images, use img tag
        return `<img src="${mediaPath}" alt="${text || ''}"${title ? ` title="${title}"` : ''}>`;
      }
    }
  });

  const html = marked.parse(markdownContent);

  // Wrap the content in the expected structure with fonts
  return `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
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
          <h1>${title}</h1>
        </header>
        ${html}
      </main>
    </div>
  </body>
</html>`;
}

// Handle fetch events
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  
  // Pass through requests for non-post resources
  if (
    !url.pathname.startsWith('/posts/') || // Not a post request
    url.pathname.endsWith('.md') ||        // Markdown file
    url.pathname.endsWith('.css') ||       // CSS file
    url.pathname === '/favicon.ico'        // Favicon
  ) {
    return;
  }

  // Handle media files in /posts/ directory
  if (/\.(jpg|jpeg|png|gif|webp|svg|mp4|mov)$/i.test(url.pathname)) {
    return;
  }

  // Handle post requests
  event.respondWith(
    (async () => {
      try {
        const slug = url.pathname.slice("/posts/".length).replace(/\/$/, "");
        if (!slug) return;

        // Fetch and transform the markdown
        const response = await fetch(`/posts/${slug}.md`);
        if (!response.ok) return new Response("Post not found", { status: 404 });

        const markdown = await response.text();
        const html = await transformPost(markdown, slug);

        return new Response(html, {
          headers: {
            "Content-Type": "text/html",
            "Cache-Control": "no-store"
          },
        });
      } catch (err) {
        console.error("Error processing post:", err);
        return new Response("Error loading post", { status: 500 });
      }
    })()
  );
});

// Take control immediately
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim())); 