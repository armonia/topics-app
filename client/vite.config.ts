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
  // OUT-OF-TREE BUILDS HAVE NO GIT, and the catch below turns that into an empty
  // string: the one signal that tells you which commit a bundle came from goes
  // silent exactly where it is needed most. `scripts/e2e-isolated-bundle.sh`
  // builds from a `git archive` export, which has no .git at all, so the E2E
  // suite was running against a bundle nobody could identify afterwards. The
  // caller knows the sha; let it say so.
  const declared = (process.env.TOPICS_BUILD_SHA ?? '').trim();
  if (declared) return declared;
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
    // Wipe /public only for a ONE-SHOT build (a deploy: no stale hashed assets
    // left behind). NEVER in `--watch`: there /public is the bundle the prod
    // server on :3333 is serving right now, and emptying it opens a window —
    // seconds, on a loaded box — where index.html does not exist and every page
    // load answers 500. That window is the "l'app non si apre" of the
    // build-watch agent. Overwriting in place keeps a complete bundle on disk at
    // all times; the stale chunks a long watch session accumulates are swept by
    // the next one-shot build.
    emptyOutDir: process.env.TOPICS_BUILD_WATCH !== '1',
    rollupOptions: {
      output: {
        manualChunks: {
          // Object-form entries match only the exact resolved module: bare
          // 'react-dom' is a 1KB stub, the real renderer lives behind the
          // 'react-dom/client' subpath (and JSX compiles to react/jsx-runtime).
          // Without the subpaths the ~170KB renderer silently stays in the
          // main chunk and react-vendor ships 3KB.
          'react-vendor': ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
          'markdown': ['react-markdown', 'remark-gfm'],
          'editor': ['@codemirror/view', '@codemirror/state', '@codemirror/language', '@codemirror/commands', '@codemirror/theme-one-dark'],
          'icons': ['lucide-react'],
          // NO ENTRY FOR dnd-kit, and removing it is half the win.
          //
          // The comment that stood here said dnd-kit landed in the EAGER main
          // chunk "by the sidebar's TopicItem (useSortable)". True when it was
          // written, and false from the day topic reordering was deleted: that
          // hook has been inert ever since (see TopicItem.tsx).
          //
          // But removing the hook alone was worth 113 bytes, because THIS entry
          // was what kept the chunk alive. An object-form entry forces the chunk
          // to exist even when nothing imports it from an eager path, and Rollup
          // parks the react-dom CJS stub inside it - the same "1KB stub" the
          // `react-vendor` comment above names. The result: `react-vendor`
          // opened with a static `import` from `dnd-kit-*.js`, and the
          // `modulepreload` stayed in `index.html` for dead code.
          //
          // Without this entry dnd-kit lands whole, in a single copy, inside
          // `KanbanBoardPane-*.js`, which is already `lazy()`. Measured: the
          // critical path goes from 6 files to 5, -12.267 gz.
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
    fs: {
      // `client/src/schemas/ws-*.ts` importa il contratto WS da `shared/`, che
      // sta FUORI da questa root. In build Rollup lo risolve da sé; in dev
      // `fs.strict` lo servirebbe solo grazie all'inferenza della workspace
      // root (lockfile del repo). Dichiararlo esplicitamente evita che un
      // 403 in dev dipenda da un'euristica di Vite.
      allow: [path.resolve(__dirname), path.resolve(__dirname, '../shared')],
    },
    // Backend the dev bundle talks to. Default :3330 (staging convention); set
    // VITE_PROXY_TARGET to point elsewhere, e.g. the live prod server on :3333
    // (real data) when you want the dev chip/HMR against production data without
    // spinning a second backend (the daemon-singleton lock forbids a 2nd :3330
    // server alongside prod from the same TOPICS_HOME).
    proxy: (() => {
      const target = process.env.VITE_PROXY_TARGET || 'https://localhost:3330';
      return {
        '/api': { target, secure: false, changeOrigin: true },
        '/preview': { target, secure: false, changeOrigin: true },
        '/ws': { target, ws: true, secure: false },
      };
    })(),
  },
})