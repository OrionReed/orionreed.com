// Dark Mode Toggle Custom Element
class DarkModeToggle extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
    this.setupEventListeners();
    this.loadTheme();
  }

  render() {
    if (this.shadowRoot) {
      this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }
        
        .toggle-button {
          background: var(--bg-color, #ffffff);
          border: 1px solid var(--border-color, #ddd);
          border-radius: 50%;
          width: 40px;
          height: 40px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.3s ease;
        }

        .toggle-button:hover {
          transform: scale(1.05);
          border-color: var(--text-color, #24292e);
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
          .toggle-button {
            width: 36px;
            height: 36px;
          }
        }
      </style>
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
  }

  setupEventListeners() {
    const button = this.shadowRoot?.querySelector('.toggle-button');
    if (button) {
      button.addEventListener('click', () => this.toggleTheme());
    }
  }

  loadTheme() {
    const savedTheme = localStorage.getItem('theme');
    const theme = savedTheme || 'light';
    this.setTheme(theme);
  }

  toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    this.setTheme(newTheme);
  }

  setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    this.setAttribute('data-theme', theme);
  }
}

// Register the custom element
customElements.define('dark-mode-toggle', DarkModeToggle); 