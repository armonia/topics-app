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
        'app-hover': 'var(--bg-hover)',
        'app-panel': 'var(--bg-panel)',
        'app-input': 'var(--bg-input)',
        'app-inset': 'var(--bg-inset)',
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
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
