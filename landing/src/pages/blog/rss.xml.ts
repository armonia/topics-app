import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

/**
 * The feed carries no SEO weight of its own — it is the channel developer
 * aggregators and a chunk of this audience still read, and it costs nine lines.
 */
export async function GET(context: APIContext) {
  const posts = (await getCollection('blog', ({ data }) => !data.draft))
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());

  return rss({
    title: 'Topics',
    description:
      'What we measured while building a desktop workspace for coding agents: memory footprints, token costs, terminal internals, and the things that broke on the way.',
    site: context.site!,
    items: posts.map((p) => ({
      title: p.data.title,
      description: p.data.description,
      pubDate: p.data.pubDate,
      link: `/blog/${p.id}/`,
    })),
    customData: '<language>en</language>',
  });
}
