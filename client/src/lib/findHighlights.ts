/**
 * The two find highlights (`find-hit`, `find-current`) of a document, shared
 * by every pane that paints into it.
 *
 * `CSS.highlights` is ONE registry per document and the `::highlight()` rules
 * name a highlight, not an owner: two chats with their bars open would each
 * overwrite the other's `find-hit`. So every finder hands its ranges here
 * under its own key, and the registry entry is the union.
 */

interface HighlightRegistryLike { set(name: string, h: unknown): void; delete(name: string): void }
type HighlightClass = new (...r: Range[]) => unknown;

interface Owned { doc: Document; hits: Range[]; current: Range | null }

const owners = new Map<string, Owned>();

function api(doc: Document): { registry: HighlightRegistryLike; Highlight: HighlightClass } | null {
  const win = doc.defaultView as (Window & { CSS?: { highlights?: HighlightRegistryLike }; Highlight?: HighlightClass }) | null;
  const registry = win?.CSS?.highlights;
  const Highlight = win?.Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

function repaint(doc: Document): void {
  const a = api(doc);
  if (!a) return;
  const hits: Range[] = [];
  const current: Range[] = [];
  for (const o of owners.values()) {
    if (o.doc !== doc) continue;
    for (const r of o.hits) if (r !== o.current) hits.push(r);
    if (o.current) current.push(o.current);
  }
  if (hits.length) a.registry.set('find-hit', new a.Highlight(...hits));
  else a.registry.delete('find-hit');
  if (current.length) a.registry.set('find-current', new a.Highlight(...current));
  else a.registry.delete('find-current');
}

export function setFindHighlights(owner: string, doc: Document, hits: Range[], current: Range | null): void {
  const prev = owners.get(owner);
  owners.set(owner, { doc, hits, current });
  if (prev && prev.doc !== doc) repaint(prev.doc);
  repaint(doc);
}

export function clearFindHighlights(owner: string): void {
  const prev = owners.get(owner);
  if (!prev) return;
  owners.delete(owner);
  repaint(prev.doc);
}
