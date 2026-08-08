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

        // (Qui stavano diciannove alias — `dashboard-*`, `sidebar-*`,
        // `functional-*` — verso altrettanti token di index.css. Erano rotti
        // alla nascita: avvolgevano il token in `hsl(...)` mentre il token
        // conteneva già `hsl(...)`, cioè generavano `hsl(hsl(0 0% 96%))`, che
        // il browser scarta. Nessuno li usava — zero occorrenze in src — e i
        // token che indicavano avevano il solo ramo chiaro. Cancellati insieme
        // ai token: vedi la nota in `:root`, index.css.)
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
