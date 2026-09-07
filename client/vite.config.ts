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

// Plugin: KaTeX ships every font three times (woff2, woff, ttf) and its CSS lists
// them in that order. Every WebView this client runs in (WKWebView, WebView2,
// WebKitGTK, Chromium) takes the woff2 and never requests the other two, yet the
// build emitted all 40 legacy files (817 KB) into public/assets, and the Tauri
// bundle embeds public/ into the binary. Dropping them at generateBundle leaves
// the CSS untouched (the @font-face src lists still name them as fallbacks that
// are never fetched) and none of the bundle gates look at font src.
function dropLegacyKatexFonts(): Plugin {
  return {
    name: 'topics-drop-legacy-katex-fonts',
    apply: 'build',
    generateBundle(_, bundle) {
      for (const name of Object.keys(bundle)) {
        if (/KaTeX_[^/]*\.(ttf|woff)$/.test(name)) delete bundle[name];
      }
    },
  };
}

// Plugin: emit a .br and a .gz sibling next to every text asset.
//
// The server on :3333 had no Accept-Encoding branch at all, so anyone reaching
// it from LAN or Tailscale downloaded the critical path RAW: 2.001.221 bytes
// against 594 KB gzip and 543 KB brotli, once per device after every deploy.
// The relay path was never affected (Cloudflare compresses at the edge), which
// is why nobody saw it. Compressing on the fly per request would pay the CPU
// again for every client for bytes that never change between deploys, so the
// siblings are built ONCE here and `pickPrecompressed` (server/static-assets.ts)
// picks one when the client says it can take it.
//
// Both encodings, not brotli alone: over plain http (a LAN address without TLS)
// Firefox does not offer br, and gzip is what it falls back to.
function precompressAssets(): Plugin {
  // Under ~1 KB the sibling costs a file and saves nothing worth a round trip.
  const MIN_BYTES = 1024;
  const TEXT_ASSET = /\.(?:js|mjs|css|svg)$/;
  return {
    name: 'topics-precompress-assets',
    apply: 'build',
    // writeBundle, NOT generateBundle: Vite's own build plugins run their
    // generateBundle AFTER a normal-order user plugin, and one of them rewrites
    // the chunks (`__VITE_PRELOAD__` becomes the real dependency arrays).
    // Compressing there produced siblings 2.032 bytes shorter than the file
    // finally written - a brotli body that decodes to a DIFFERENT bundle than
    // the raw one, which is the worst possible failure here because every
    // client sees only one of the two. On disk there is nothing left to guess.
    async writeBundle(options, bundle) {
      const dir = options.dir;
      if (!dir) return;
      const zlib = await import('node:zlib');
      const { promisify } = await import('node:util');
      const fsp = await import('node:fs/promises');
      const brotli = promisify(zlib.brotliCompress);
      const gzip = promisify(zlib.gzip);
      await Promise.all(Object.keys(bundle).filter((n) => TEXT_ASSET.test(n)).map(async (name) => {
        const file = path.join(dir, name);
        let buf: Buffer;
        try {
          buf = await fsp.readFile(file);
        } catch {
          return; // dropped by another plugin (see dropLegacyKatexFonts)
        }
        if (buf.byteLength < MIN_BYTES) return;
        const [br, gz] = await Promise.all([
          brotli(buf, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
              [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.byteLength,
            },
          }),
          gzip(buf, { level: zlib.constants.Z_BEST_COMPRESSION }),
        ]);
        // A sibling that is not smaller than the original is not written: the
        // server would then send MORE bytes for saying it compressed them.
        if (br.byteLength < buf.byteLength) await fsp.writeFile(`${file}.br`, br);
        if (gz.byteLength < buf.byteLength) await fsp.writeFile(`${file}.gz`, gz);
      }));
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
  plugins: [devIconPlugin(), lastChangePlugin(), react(), tailwindcss(), dropLegacyKatexFonts(), precompressAssets()],
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