// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';

/**
 * Static output, deployed to Cloudflare Workers assets exactly as before — no
 * adapter, no server, no Worker invocation. The site is still a folder of files;
 * what changes is that the folder is now generated, which is the only way a
 * sitemap, an RSS feed, per-article OG images and 200 pages of blog and wiki
 * stop being hand-maintained code.
 *
 * The pieces that were hand-written and stay hand-written live in `public/`
 * verbatim: styles.css, app.js, changelog.js, the demo build under app/, the
 * product images. Astro copies them through untouched, so this migration cannot
 * change how a single one of them behaves. Hashing and bundling them is a later,
 * separate decision.
 */
export default defineConfig({
  site: 'https://topics.armonia.io',

  // English is the product's language and the one the audience searches in.
  // Italian exists for the handful of pieces where the smaller market is worth
  // winning, never as a mirror — `prefixDefaultLocale: false` keeps English at
  // the root so no existing URL moves.
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'it'],
    routing: { prefixDefaultLocale: false },
  },

  integrations: [
    mdx(),
    sitemap({
      // The demo is a whole second application living under /app/. It is a
      // build artefact, it has no content of its own, and 167 chunks in the
      // sitemap would bury the pages that matter.
      filter: (page) => !page.includes('/app/'),
    }),
  ],

  build: {
    // Directory format, so a post is /blog/slug/ rather than /blog/slug.html.
    // The one URL this would have moved — /changelog.html — is held in place by
    // a redirect in public/_redirects, because links to it already exist.
    format: 'directory',
  },

  // The site measured 12,741 bytes of HTML and a 168 ms TTFB against 45
  // competitors, and was the fastest of them. That is worth protecting: no
  // client framework, and inline anything small enough that a round trip costs
  // more than the bytes.
  vite: {
    build: { assetsInlineLimit: 2048 },
  },
});
