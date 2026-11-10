import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

/**
 * Gallery build of the UI layer (`client/src/ui/`): `ui.html` renders each
 * screen of the mockups with the real components and example data, one per
 * hash (`ui.html#w01`); `app.html` joins the same screens into one navigable
 * app (`app.html#/panoramica`); `sarim.html` and `consorzio.html` are the editions
 * of one organization each. No server, no demo boot: the layer takes
 * everything from props, so both pages need nothing but the components and
 * the CSS. Output in `client/dist-ui/` (ignored, like every `dist*`).
 *
 * `bun run build:ui` builds it, `bun run dev:ui` serves it with hot reload.
 *
 * Static files come from `public-ui/` (the originals of the example cases,
 * `public-ui/docs/`), not from the product's `public/`: the preview needs
 * none of the product's service worker, manifest or boot script.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  publicDir: 'public-ui',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: { open: '/ui.html' },
  build: {
    outDir: 'dist-ui',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        ui: path.resolve(__dirname, 'ui.html'),
        app: path.resolve(__dirname, 'app.html'),
        sarim: path.resolve(__dirname, 'sarim.html'),
        consorzio: path.resolve(__dirname, 'consorzio.html'),
      },
    },
  },
});
