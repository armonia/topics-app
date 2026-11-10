import { build, defineConfig, type Plugin, type Rollup } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import fs from 'fs';

/**
 * Landing-demo build: the REAL Topics client, bundled to run with NO backend.
 *
 * It is the exact same entry as production (index.html → src/main.tsx → <App/>);
 * the ONLY difference is an inlined boot script (src/demo/boot.ts) injected as
 * the first <head> script. It seeds the browser storage and stubs fetch and
 * WebSocket with the data of a SCENARIO (src/demo/scenarios/, `?scenario=` in
 * the URL, acme by default), so the embedded hero demo IS the real app — no
 * forked component tree, no module-mock drift. The scenarios answer with the
 * client's own types: an endpoint that changes shape fails the typecheck
 * instead of breaking the demo in the page. Output goes to landing/public/app/ —
 * a gitignored build directory, not a committed snapshot — from where `astro
 * build` copies it into landing/dist/app/, which is what the Cloudflare Worker
 * serves. `bun run build:site` (and therefore `deploy:landing`) runs this build
 * first, so the published demo is always the current client; run it by hand
 * with `bun run build:landing` when you want the demo in a local `dev:site`.
 */

/* The boot must stay a CLASSIC script that runs before the app bundle: a module
 * script is deferred, and the app would read an empty localStorage and call a
 * server that is not there. So boot.ts and its imports are bundled into one
 * IIFE by a nested vite build (no extra dependency, no file written). */
async function compileBoot(): Promise<string> {
  const frameB64 = fs.readFileSync(path.resolve(__dirname, 'src/demo/browser-frame.b64.txt'), 'utf8').trim();
  // The rrweb Meta + FullSnapshot the Browser pane replays. Generated from
  // src/demo/browser-page.html by scripts/gen-browser-snapshot.mjs; the pane
  // paints from dom_events, not from the JPEG, which the app now treats as a
  // bootstrap signal and never renders.
  const domSnapshot = fs.readFileSync(path.resolve(__dirname, 'src/demo/browser-dom-snapshot.json'), 'utf8').trim();
  const out = await build({
    configFile: false,
    logLevel: 'warn',
    define: { __DEMO_BROWSER_FRAME__: JSON.stringify(frameB64), __DEMO_DOM_SNAPSHOT__: domSnapshot },
    build: {
      write: false,
      minify: false,
      emptyOutDir: false,
      copyPublicDir: false,
      lib: { entry: path.resolve(__dirname, 'src/demo/boot.ts'), formats: ['iife'], name: 'topicsDemoBoot' },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const outputs = (Array.isArray(out) ? out : [out]) as Rollup.RollupOutput[];
  const chunk = outputs.flatMap((o) => o.output).find((o): o is Rollup.OutputChunk => o.type === 'chunk');
  if (!chunk) throw new Error('landing demo: src/demo/boot.ts compiled to nothing');
  // An inline <script> ends at the first "</script", wherever it appears.
  return chunk.code.replace(/<\/script/gi, '<\\/script');
}

function inlineBootShim(): Plugin {
  return {
    name: 'landing-boot-shim',
    async transformIndexHtml(html) {
      const shim = await compileBoot();
      // Ghost mouse-cursor choreography: a second inline classic script at BODY
      // END (after the app root) that animates a macOS-style pointer driving
      // the real UI — tab switches + divider drags via synthetic MouseEvents.
      const cursorSrc = fs.readFileSync(path.resolve(__dirname, 'src/demo/landing-cursor.js'), 'utf8');
      return {
        html,
        tags: [
          {
            tag: 'script',
            children: shim,
            injectTo: 'head-prepend',
          },
          {
            tag: 'script',
            children: cursorSrc,
            injectTo: 'body',
          },
        ],
      };
    },
  };
}

export default defineConfig({
  define: {
    // Must be a parseable date: the sidebar status bar runs formatBuildTime(new
    // Date(__BUILD_TIME__)) and a non-date ('landing-demo') yields "NaNd".
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [inlineBootShim(), react(), tailwindcss()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: '../landing/public/app',
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
});
