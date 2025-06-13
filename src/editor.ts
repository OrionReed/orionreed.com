import { marked } from "marked";
import markedKatex from "marked-katex-extension";

interface Post {
  filename: string;
  content: string;
  timestamp: string;
}

class MarkdownEditor {
  private editor: HTMLTextAreaElement;
  private preview: HTMLElement;
  private filenameInput: HTMLInputElement;

  private db: IDBDatabase | null = null;
  private autoSaveTimeout: number | null = null;

  constructor() {
    // Configure marked with KaTeX extension
    marked.use(
      markedKatex({
        throwOnError: false,
      })
    );

    // Configure marked for media files (similar to build script)
    marked.use({
      renderer: {
        image(href: string, title: string | null, text: string) {
          // For the editor, we'll just use the href as-is since we can't resolve local paths
          if (href.match(/\.(mp4|mov)$/i)) {
            return `<video controls><source src="${href}" type="video/${
              href.endsWith(".mov") ? "quicktime" : "mp4"
            }">Your browser does not support the video tag.</video>`;
          }
          return `<img src="${href}" alt="${text || ""}"${
            title ? ` title="${title}"` : ""
          }>`;
        },
      },
    });

    // Initialize DOM elements
    this.editor = document.getElementById("editor") as HTMLTextAreaElement;
    this.preview = document.getElementById("preview") as HTMLElement;
    this.filenameInput = document.getElementById(
      "filename"
    ) as HTMLInputElement;

    this.init();
  }

  private async init() {
    await this.initDB();
    this.setupEventListeners();
    this.loadFromLocalStorage();
    this.updatePreview();
  }

  private initDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("MarkdownEditor", 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        const objectStore = this.db!.createObjectStore("posts", {
          keyPath: "filename",
        });
        objectStore.createIndex("timestamp", "timestamp", { unique: false });
      };
    });
  }

  private async saveToIndexedDB(
    filename: string,
    content: string
  ): Promise<void> {
    if (!this.db) await this.initDB();

    const transaction = this.db!.transaction(["posts"], "readwrite");
    const objectStore = transaction.objectStore("posts");

    const post: Post = {
      filename: filename || "untitled",
      content: content,
      timestamp: new Date().toISOString(),
    };

    return new Promise((resolve, reject) => {
      const request = objectStore.put(post);
      request.onsuccess = () => {
        console.log(`Saved ${new Date().toLocaleTimeString()}`);
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }

  private async loadFromIndexedDB(filename: string): Promise<Post | null> {
    if (!this.db) await this.initDB();

    const transaction = this.db!.transaction(["posts"], "readonly");
    const objectStore = transaction.objectStore("posts");

    return new Promise((resolve, reject) => {
      const request = objectStore.get(filename);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  private async getAllPosts(): Promise<Post[]> {
    if (!this.db) await this.initDB();

    const transaction = this.db!.transaction(["posts"], "readonly");
    const objectStore = transaction.objectStore("posts");

    return new Promise((resolve, reject) => {
      const request = objectStore.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private updatePreview(): void {
    const markdown = this.editor.value;
    try {
      const html = marked.parse(markdown) as string;
      this.preview.innerHTML = html;
    } catch (error) {
      this.preview.innerHTML = `<p style="color: red;">Error parsing markdown: ${
        (error as Error).message
      }</p>`;
    }
  }

  private autoSave(): void {
    if (this.autoSaveTimeout) {
      clearTimeout(this.autoSaveTimeout);
    }

    this.autoSaveTimeout = window.setTimeout(async () => {
      const filename = this.filenameInput.value.trim() || "untitled";
      const content = this.editor.value;
      if (content.trim()) {
        try {
          await this.saveToIndexedDB(filename, content);
        } catch (error) {
          console.error("Auto-save error:", error);
        }
      }
    }, 2000);
  }

  private setupEventListeners(): void {
    // Editor input handling
    this.editor.addEventListener("input", () => {
      this.updatePreview();
      this.autoSave();
    });

    // Save button
    const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
    saveBtn.addEventListener("click", async () => {
      const filename = this.filenameInput.value.trim() || "untitled";
      const content = this.editor.value;

      try {
        await this.saveToIndexedDB(filename, content);
        alert("Post saved successfully!");
      } catch (error) {
        alert("Error saving post: " + (error as Error).message);
      }
    });

    // Load button
    const loadBtn = document.getElementById("load-btn") as HTMLButtonElement;
    loadBtn.addEventListener("click", async () => {
      try {
        const posts = await this.getAllPosts();
        if (posts.length === 0) {
          alert("No saved posts found.");
          return;
        }

        const filenames = posts.map((post) => post.filename);
        const selectedFilename = prompt(
          "Select a post to load:\n\n" +
            filenames.join("\n") +
            "\n\nEnter filename:"
        );

        if (selectedFilename) {
          const post = await this.loadFromIndexedDB(selectedFilename);
          if (post) {
            this.filenameInput.value = post.filename;
            this.editor.value = post.content;
            this.updatePreview();
          } else {
            alert("Post not found.");
          }
        }
      } catch (error) {
        alert("Error loading posts: " + (error as Error).message);
      }
    });

    // Download button
    const downloadBtn = document.getElementById(
      "download-btn"
    ) as HTMLButtonElement;
    downloadBtn.addEventListener("click", () => {
      const filename = (this.filenameInput.value.trim() || "untitled") + ".md";
      const content = this.editor.value;

      const blob = new Blob([content], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });

    // Save to localStorage as additional backup
    window.addEventListener("beforeunload", () => {
      localStorage.setItem("markdown-editor-content", this.editor.value);
      localStorage.setItem(
        "markdown-editor-filename",
        this.filenameInput.value
      );
    });
  }

  private loadFromLocalStorage(): void {
    const savedContent = localStorage.getItem("markdown-editor-content");
    const savedFilename = localStorage.getItem("markdown-editor-filename");

    if (savedContent && !this.editor.value) {
      this.editor.value = savedContent;
    }

    if (savedFilename && !this.filenameInput.value) {
      this.filenameInput.value = savedFilename;
    }
  }
}

// Initialize the editor when the DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  new MarkdownEditor();
});
