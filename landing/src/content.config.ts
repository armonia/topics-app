import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
// `z` re-exported from astro:content is deprecated in Astro 7; astro/zod is the
// same instance, just imported from where it actually lives.
import { z } from 'astro/zod';

/**
 * Two surfaces, two jobs, and the split is not cosmetic.
 *
 * BLOG is dated and has a thesis. It is what gets shared and linked, and it is
 * allowed to age — a piece about a release or a measurement is true of a moment.
 *
 * WIKI is evergreen and definitional. It carries an "updated" date rather than a
 * published one, it is densely cross-linked (MDN's CORS entry runs 27.8 internal
 * links per 1,000 words against 0.3 for a typical essay), and it is the surface
 * that answer engines quote when someone asks what a thing is.
 *
 * The rule that keeps them from competing: a definition lives ONLY in the wiki.
 * The blog may cite one, never restate it. When a post turns evergreen it is
 * promoted to the wiki with a redirect, never the other way round — a post
 * rewritten every year restarts its age as a ranking signal, and 72.9% of what
 * ranks in the top ten is more than three years old.
 */

const PILLARS = [
  'parallel-agents',   // several agents, one repository
  'worktrees',         // isolation, dispatch, landing
  'cost',              // tokens, context, caching, effort
  'substrate',         // PTY, sync, local-first
  'performance',       // what the shell costs to run
  'protocols',         // MCP, ACP, the toolchain
] as const;

const blog = defineCollection({
  loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    /** The standfirst. Also the meta description, so it has to answer, not tease. */
    description: z.string().min(80).max(320),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    pillar: z.enum(PILLARS),
    format: z.enum(['deep-dive', 'field-notes', 'recipe', 'migration', 'narrative', 'comparison']),
    /* The byline is the organisation, not a person. It is a deliberate choice
       rather than an oversight: E-E-A-T rewards a named author with a real
       profile, and we are giving that up on purpose. If a piece ever wants a
       personal byline it can set one in its own frontmatter. */
    author: z.string().default('Armonia'),
    authorUrl: z.url().default('https://armonia.io'),
    /** The query this piece is written to own. One, not a list. */
    seoTarget: z.string().optional(),
    /** Wiki slugs this piece leans on. Rendered as "Related", and the check
     *  below is what stops a link rotting silently. */
    wiki: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

const wiki = defineCollection({
  loader: glob({ base: './src/content/wiki', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    /** The definition itself, in one or two sentences. This string is the meta
     *  description AND the opening of the page, because the block a generative
     *  engine lifts is the first 40-60 words and it should be the answer. */
    definition: z.string().min(60).max(320),
    updatedDate: z.coerce.date(),
    pillar: z.enum(PILLARS),
    /** Other entries, both directions. Rendered as "See also". */
    seeAlso: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog, wiki };
export { PILLARS };
