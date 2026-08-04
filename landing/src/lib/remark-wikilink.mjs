import { visit } from 'unist-util-visit';

/**
 * `[[slug]]` and `[[slug|the words you want]]` become links to /wiki/slug.
 *
 * A wiki is worth having only if the entries point at each other densely —
 * MDN's CORS page runs 27.8 internal links per 1,000 words against 0.3 for a
 * typical essay, and that difference is most of why one of them owns the query
 * and the other does not. Dense linking only happens if writing a link costs
 * almost nothing, which a full markdown URL does not.
 *
 * Rendering them is the easy half. The half that matters is that a link to an
 * entry that does not exist has to FAIL, not 404 quietly six months later —
 * that check lives in the wiki route, which is the only place that can see the
 * whole collection at once.
 */
export function remarkWikilink() {
  return (tree) => {
    visit(tree, 'text', (node, index, parent) => {
      if (!parent || typeof index !== 'number' || !node.value.includes('[[')) return;

      const out = [];
      let last = 0;
      const re = /\[\[([a-z0-9-]+)(?:\|([^\]]+))?\]\]/g;
      let m;
      while ((m = re.exec(node.value)) !== null) {
        if (m.index > last) out.push({ type: 'text', value: node.value.slice(last, m.index) });
        out.push({
          type: 'link',
          url: `/wiki/${m[1]}`,
          data: { hProperties: { 'data-wikilink': m[1] } },
          children: [{ type: 'text', value: m[2] ?? m[1].replace(/-/g, ' ') }],
        });
        last = m.index + m[0].length;
      }
      if (!out.length) return;
      if (last < node.value.length) out.push({ type: 'text', value: node.value.slice(last) });

      parent.children.splice(index, 1, ...out);
      return index + out.length;
    });
  };
}

/** The pattern the validation pass greps for. Kept here so the two cannot drift. */
export const WIKILINK_RE = /\[\[([a-z0-9-]+)(?:\|[^\]]+)?\]\]/g;
