import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import fs from 'fs';

/**
 * Landing-demo build: the REAL Topics client, bundled to run with NO backend.
 *
 * It is the exact same entry as production (index.html → src/main.tsx → <App/>);
 * the ONLY difference is an inlined boot shim (src/demo/landing-boot.js) injected
 * as the first <head> script. The shim seeds localStorage (dark theme + a
 * multi-pane split layout) and stubs fetch/WebSocket with generic mock data, so
 * the embedded hero demo IS the real app — no forked component tree, no
 * module-mock drift. Output is committed to landing/app/ and served by the
 * Cloudflare Worker. Rebuild: `npm run build:landing`.
 */
function inlineBootShim(): Plugin {
  return {
    name: 'landing-boot-shim',
    transformIndexHtml(html) {
      const shimSrc = fs.readFileSync(path.resolve(__dirname, 'src/demo/landing-boot.js'), 'utf8');
      const frameB64 = fs.readFileSync(path.resolve(__dirname, 'src/demo/browser-frame.b64.txt'), 'utf8').trim();
      const shim = shimSrc.replace('__BROWSER_FRAME_B64__', frameB64);
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
    outDir: '../landing/app',
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
