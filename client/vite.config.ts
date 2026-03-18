import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'fs'

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

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
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
    allowedHosts: ['macbook', 'localhost', '127.0.0.1'],
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