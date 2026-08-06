/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: 'var(--primary)',
        'primary-hover': 'var(--primary-hover)',
        'primary-dark': 'var(--primary-dark)',
        surface: 'var(--bg-surface)',
        elevated: 'var(--bg-elevated)',
        'app-bg': 'var(--bg)',
        // La superficie del CHROME di navigazione (sidebar intera: header,
        // albero, barra di stato). Un gradino SOTTO `app-bg`; sotto Tauri/mac
        // lo stesso token porta l'alpha della vibrancy. Vedi --chrome-bg in
        // index.css: è lì che vive sia la tinta sia il grado di trasparenza.
        'app-chrome': 'var(--chrome-bg)',
        'app-hover': 'var(--bg-hover)',
        'app-panel': 'var(--bg-panel)',
        'app-input': 'var(--bg-input)',
        'app-inset': 'var(--bg-inset)',
        // Grigio di sistema della bolla dei propri messaggi — vedi index.css.
        'app-user-bubble': 'var(--bg-user-bubble)',
        'app-text': 'var(--text)',
        'app-text-secondary': 'var(--text-secondary)',
        'app-text-tertiary': 'var(--text-tertiary)',
        'app-text-muted': 'var(--text-muted)',
        'app-text-heading': 'var(--text-heading)',
        'app-text-body': 'var(--text-body)',
        'app-text-faint': 'var(--text-faint)',
        'app-text-hover': 'var(--text-hover)',
        'app-border': 'var(--border)',
        'app-border-light': 'var(--border-light)',
        'app-border-subtle': 'var(--border-subtle)',
        'app-border-input': 'var(--border-input)',
        'app-placeholder': 'var(--text-placeholder)',
        'app-code-bg': 'var(--bg-code)',
        'app-spinner': 'var(--spinner-track)',
        'app-disabled': 'var(--disabled-bg)',

        // Phase G · 3-layer token system. Components can opt in
        // incrementally — `--app-*` classes still work alongside.
        'dashboard-bg': 'hsl(var(--dashboard-bg-primary))',
        'dashboard-surface-light': 'hsl(var(--dashboard-surface-light))',
        'dashboard-surface-dark': 'hsl(var(--dashboard-surface-dark))',
        'dashboard-input': 'hsl(var(--dashboard-input-surface))',
        'dashboard-border': 'hsl(var(--dashboard-border))',
        'dashboard-text': 'hsl(var(--dashboard-text-primary))',
        'dashboard-text-secondary': 'hsl(var(--dashboard-text-secondary))',
        'dashboard-text-muted': 'hsl(var(--dashboard-text-muted))',

        'sidebar-bg': 'hsl(var(--sidebar-bg))',
        'sidebar-fg': 'hsl(var(--sidebar-foreground))',
        'sidebar-border-token': 'hsl(var(--sidebar-border))',
        'sidebar-search-bg': 'hsl(var(--sidebar-search))',
        'sidebar-hover-bg': 'hsl(var(--sidebar-hover))',
        'sidebar-selected-bg': 'hsl(var(--sidebar-selected))',
        'sidebar-footer-bg': 'hsl(var(--sidebar-footer-bg))',
        'sidebar-tree-line': 'hsl(var(--sidebar-tree-line))',

        'functional-positive': 'hsl(var(--color-functional-positive))',
        'functional-warning': 'hsl(var(--color-functional-warning))',
        'functional-negative': 'hsl(var(--color-functional-negative))',
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
        sm: 'var(--radius-sm)',
        xs: 'var(--radius-xs)',
      },
      transitionTimingFunction: {
        'standard': 'cubic-bezier(0.4, 0, 0.2, 1)',
        'decelerate': 'cubic-bezier(0, 0, 0.2, 1)',
        'accelerate': 'cubic-bezier(0.4, 0, 1, 1)',
      },
      fontFamily: {
        // Keep in sync with --font-ui in src/index.css (system stack, no Inter).
        sans: ['-apple-system', 'BlinkMacSystemFont', 'system-ui', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
