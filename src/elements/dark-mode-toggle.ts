import { BaseElement, css } from "./base-element.ts";

export class DarkModeToggle extends BaseElement {
  static styles = css`
    :host {
      display: block;
      position: fixed;
      top: 2rem;
      right: 2rem;
      z-index: 1000;
    }

    .toggle-button {
      background: none;
      border: none;
      width: 40px;
      height: 40px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: opacity 0.3s ease;
      opacity: 0.6;
    }

    .toggle-button:hover {
      opacity: 1;
    }

    .icon {
      width: 20px;
      height: 20px;
      stroke: var(--text-color, #24292e);
      fill: none;
      transition: stroke 0.3s ease;
    }

    .sun-icon {
      display: none;
    }

    :host([data-theme="dark"]) .moon-icon {
      display: none;
    }

    :host([data-theme="dark"]) .sun-icon {
      display: block;
    }

    @media (max-width: 600px) {
      :host {
        top: 1rem;
        right: 1rem;
      }

      .toggle-button {
        width: 36px;
        height: 36px;
      }
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.setupEventListeners();
    this.loadTheme();
  }

  protected render(): void {
    this.shadow.innerHTML = `
      <button class="toggle-button" aria-label="Toggle dark mode">
        <!-- Moon icon from Feather Icons CDN -->
        <svg class="icon moon-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
        </svg>
        <!-- Sun icon from Feather Icons CDN -->
        <svg class="icon sun-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="5"></circle>
          <line x1="12" y1="1" x2="12" y2="3"></line>
          <line x1="12" y1="21" x2="12" y2="23"></line>
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
          <line x1="1" y1="12" x2="3" y2="12"></line>
          <line x1="21" y1="12" x2="23" y2="12"></line>
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
        </svg>
      </button>
    `;
  }

  private setupEventListeners(): void {
    const button = this.shadow.querySelector(".toggle-button");
    if (button) {
      button.addEventListener("click", () => this.toggleTheme());
    }
  }

  private loadTheme(): void {
    const savedTheme = localStorage.getItem("theme");

    if (savedTheme) {
      this.setTheme(savedTheme);
    } else {
      // Use system preference if no saved theme
      const prefersDark = window.matchMedia(
        "(prefers-color-scheme: dark)"
      ).matches;
      const theme = prefersDark ? "dark" : "light";
      this.setTheme(theme);
    }
  }

  private toggleTheme(): void {
    const currentTheme = document.documentElement.getAttribute("data-theme");
    const newTheme = currentTheme === "dark" ? "light" : "dark";
    this.setTheme(newTheme);
  }

  private setTheme(theme: string): void {
    document.documentElement.setAttribute("data-theme", theme);
    // Set color-scheme for light-dark() CSS function to work
    document.documentElement.style.colorScheme =
      theme === "dark" ? "dark" : "light";
    localStorage.setItem("theme", theme);
    this.setAttribute("data-theme", theme);
  }
}
