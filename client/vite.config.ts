import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'
import { execSync } from 'node:child_process'

// Plugin: swap icons/manifest to dev versions in dev mode only
function devIconPlugin(): Plugin {
  return {
    name: 'dev-icon-swap',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith('/icons/')) {
          res.setHeader('Cache-Control', 'public, max-age=86400');
        }
        next();
      });
    },
    transformIndexHtml(html) {
      return html
        .replace(/\/icons\/icon-180\.png/g, '/icons/icon-180-dev.png')
        .replace(/\/icons\/icon-192\.png/g, '/icons/icon-192-dev.png')
        .replace('/manifest.json', '/manifest-dev.json');
    },
  };
}

// Plugin: track last source file change time, serve via /@last-change
function lastChangePlugin(): Plugin {
  let lastChange = new Date().toISOString();
  return {
    name: 'last-change-tracker',
    handleHotUpdate() {
      lastChange = new Date().toISOString();
    },
    configureServer(server) {
      server.middlewares.use('/@last-change', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ time: lastChange }));
      });
    },
  };
}

// App version is the source-of-truth root package version (kept in lockstep with
// the Tauri conf + Cargo.toml) — surfaced in the status bar so you can tell at a
// glance which build is running.
// Git short-hash of the checkout at build time (+ '*' when the tree is dirty)
// — the ONLY reliable freshness signal: the semver only changes on release
// bumps, so locally-delivered builds all share it. Shown in the version popover.
const __buildSha = (() => {
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
    const dirty = execSync('git status --porcelain --untracked-files=no', { cwd: __dirname }).toString().trim() ? '*' : '';
    return sha + dirty;
  } catch {
    return '';
  }
})();

const __appVersion = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'),
    ).version as string;
  } catch {
    return '0.0.0';
  }
})();

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __APP_VERSION__: JSON.stringify(__appVersion),
    __BUILD_SHA__: JSON.stringify(__buildSha),
  },
  plugins: [devIconPlugin(), lastChangePlugin(), react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'markdown': ['react-markdown', 'remark-gfm'],
          'editor': ['@codemirror/view', '@codemirror/state', '@codemirror/language', '@codemirror/commands', '@codemirror/theme-one-dark'],
          'icons': ['lucide-react'],
        },
      },
    },
  },
  optimizeDeps: {
    include: [
      '@codemirror/merge',
      '@codemirror/view',
      '@codemirror/state',
      '@codemirror/language',
      '@codemirror/lang-javascript',
      '@codemirror/lang-html',
      '@codemirror/lang-css',
      '@codemirror/lang-json',
      '@codemirror/lang-markdown',
      '@codemirror/lang-python',
      '@codemirror/theme-one-dark',
    ],
  },
  server: {
    https: fs.existsSync(path.resolve(__dirname, 'certs/key.pem')) ? {
      key: fs.readFileSync(path.resolve(__dirname, 'certs/key.pem')),
      cert: fs.readFileSync(path.resolve(__dirname, 'certs/fullchain.pem')),
    } : undefined,
    port: 3332,
    host: '0.0.0.0',
    // DNS-rebinding protection: allow localhost + any Tailscale MagicDNS host
    // (*.ts.net, how we reach the dev box from a phone) instead of the previous
    // `true` wildcard, which accepted every Host header. IP-literal access
    // (e.g. a raw 100.x Tailscale addr) bypasses this check in Vite anyway.
    allowedHosts: ['localhost', '127.0.0.1', '.ts.net'],
    proxy: {
      '/api': { target: 'https://localhost:3330', secure: false, changeOrigin: true },
      '/preview': { target: 'https://localhost:3330', secure: false, changeOrigin: true },
      '/ws': {
        target: 'https://localhost:3330',
        ws: true,
        secure: false,
      },
    },
  },
})