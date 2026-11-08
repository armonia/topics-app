/**
 * Stable React keys for the children of a split, so that reorganising the tree
 * moves subtrees instead of rebuilding them (SPLITPERF-01).
 *
 * A leaf has an identity of its own (its id), so it keys on it. A split does
 * not: the layout models (`gridRows`, the project's `rows`) carry no row id.
 * Keying a split on its INDEX among siblings remounted every pane below it the
 * moment a row was inserted above it, removed above it or swapped with its
 * neighbour: the index moved, React saw a different child, and a terminal,
 * a chat and a browser page were built again from nothing. Keying it on its
 * first leaf was worse in the other direction (closing the first column of a
 * row re-keyed the whole row).
 *
 * The identity of an anonymous split is therefore the CONTENT it carries,
 * followed from one render to the next: each current split inherits the key of
 * the previous split it shares the most leaves with. A row that moved keeps its
 * key, a row that lost its first column keeps its key, a brand new row gets a
 * new one. Pure, and kept out of the component so it can be tested alone.
 */
import { isLeaf, type LayoutNode, type SplitChild } from '../../state/layout/layoutTree';

/** The keys given to a split's children on one render, with what each carried. */
export interface SplitKeyState {
  readonly keys: readonly string[];
  /** Leaf ids under each child, index-aligned with `keys` (empty for a leaf child). */
  readonly contents: readonly ReadonlySet<string>[];
}

export const EMPTY_SPLIT_KEYS: SplitKeyState = { keys: [], contents: [] };

/** Placeholder leaves (`__skip:<row>:<col>`) are positional by construction: they
 *  are no evidence of identity and must not tie two splits together. */
const isPlaceholder = (id: string): boolean => id.startsWith('__skip:');

function leafIds(node: LayoutNode, out: Set<string>): Set<string> {
  if (isLeaf(node)) {
    if (!isPlaceholder(node.id)) out.add(node.id);
  } else {
    for (const c of node.children) leafIds(c.node, out);
  }
  return out;
}

/**
 * Assign keys to `children`, continuing from `prev` (the previous render of the
 * same split).
 *
 * Leaves key on `leaf:<id>`. Each split child takes the unused previous split
 * key with the largest leaf overlap; a tie goes to the one at the same index,
 * so a split that changed nothing stays where it was. A split with no overlap
 * at all (a new row, or one made only of placeholders) falls back to the
 * previous key at its own index if that one is still unused and was itself
 * empty, and otherwise gets a fresh key derived from its content, suffixed until
 * it is unique among the siblings.
 */
export function assignSplitKeys(prev: SplitKeyState, children: readonly SplitChild[]): SplitKeyState {
  const keys: string[] = new Array(children.length);
  const contents: ReadonlySet<string>[] = children.map((c) =>
    isLeaf(c.node) ? new Set<string>() : leafIds(c.node, new Set<string>()),
  );
  const used = new Set<string>();

  // Leaves first: their keys are fixed, and a split must never reuse one.
  children.forEach((c, i) => {
    if (isLeaf(c.node)) {
      keys[i] = `leaf:${c.node.id}`;
      used.add(keys[i]!);
    }
  });

  const prevSplits = prev.keys
    .map((key, i) => ({ key, i, content: prev.contents[i] ?? new Set<string>() }))
    .filter((p) => p.key.startsWith('split:'));

  // Greedy by best overlap, largest first: the split that shares the most with
  // an old one claims it before a weaker match can.
  const candidates: { child: number; prev: number; overlap: number }[] = [];
  children.forEach((c, i) => {
    if (isLeaf(c.node)) return;
    prevSplits.forEach((p, pi) => {
      let overlap = 0;
      for (const id of contents[i]!) if (p.content.has(id)) overlap += 1;
      if (overlap > 0) candidates.push({ child: i, prev: pi, overlap });
    });
  });
  candidates.sort((a, b) =>
    b.overlap - a.overlap
    || Number(prevSplits[b.prev]!.i === b.child) - Number(prevSplits[a.prev]!.i === a.child)
    || a.child - b.child,
  );
  for (const cand of candidates) {
    if (keys[cand.child] !== undefined) continue;
    const key = prevSplits[cand.prev]!.key;
    if (used.has(key)) continue;
    keys[cand.child] = key;
    used.add(key);
  }

  children.forEach((_c, i) => {
    if (keys[i] !== undefined) return;
    const same = prevSplits.find((p) => p.i === i);
    if (same && same.content.size === 0 && contents[i]!.size === 0 && !used.has(same.key)) {
      keys[i] = same.key;
    } else {
      const first = [...contents[i]!][0] ?? `empty${i}`;
      let key = `split:${first}`;
      for (let n = 2; used.has(key); n++) key = `split:${first}#${n}`;
      keys[i] = key;
    }
    used.add(keys[i]!);
  });

  return { keys, contents };
}
