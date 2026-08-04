// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';
import { unified } from '@astrojs/markdown-remark';
import { remarkWikilink } from './src/lib/remark-wikilink.mjs';

/**
 * Static output, deployed to Cloudflare Workers assets exactly as before — no
 * adapter, no server, no Worker invocation. The site is still a folder of files;
 * what changes is that the folder is now generated, which is the only way a
 * sitemap, an RSS feed, per-article OG images and 200 pages of blog and wiki
 * stop being hand-maintained code.
 *
 * What stays in `public/` is what a browser must fetch at a fixed URL and what
 * no build step improves: styles.css, the demo build under app/, the product
 * images, robots.txt, llms.txt, agents.md. The behaviour that used to live
 * beside them as `app.js` and `changelog.js` moved into `src/scripts/*.ts`,
 * where it is typechecked and bundled per page — served from `public/` it was
 * none of those things, and every page paid for all of it.
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

  markdown: {
    // `markdown.remarkPlugins` still works and is deprecated in Astro 7: the
    // plugin list moved onto the processor itself, which is the object the
    // renderer actually holds. Same pipeline, no warning, and it will survive
    // the major that drops the old field.
    //
    // `smartypants: false` is the interesting one. It is on by default, and it
    // was rewriting every straight quote in the sources into a curly one at
    // build time: measured, zero curly quotes across 35 content files and 109
    // in the rendered pages. Curly quotes are one of the listed tells of
    // machine-written prose, so the build was manufacturing a signal the author
    // never wrote, on a site whose whole credibility argument is that a person
    // wrote it. Off, and typography is whatever the source says it is.
    processor: unified({ remarkPlugins: [remarkWikilink], smartypants: false }),
  },

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
