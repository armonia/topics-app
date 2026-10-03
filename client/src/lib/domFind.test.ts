/**
 * The DOM text finder, on a document made by hand (no DOM in bun:test here).
 *
 * @covers FILE-FIND-02
 * @covers BROWSER-FIND-04
 */
import { describe, expect, test } from 'bun:test';
import { collectText, findMatches, locate, type TextNodeLike } from './domFind';

const textNode = (v: string): TextNodeLike => ({ nodeType: 3, nodeName: '#text', nodeValue: v, childNodes: [] });
const el = (name: string, ...children: TextNodeLike[]): TextNodeLike => ({ nodeType: 1, nodeName: name, nodeValue: null, childNodes: children });

function count(root: TextNodeLike, q: string, matchCase = false) {
  const { text } = collectText(root);
  return findMatches(text, q, matchCase).length;
}

describe('collectText + findMatches', () => {
  const doc = el('DIV',
    el('H1', textNode('Installazione')),
    el('P', textNode('Prima di tutto, l\''), el('B', textNode('instal')), textNode('lazione '), el('EM', textNode('richiede')), textNode(' Bun.')),
    el('SCRIPT', textNode('installazione nel codice, non a schermo')),
    el('P', textNode('Prezzi e prezzi.')),
  );

  test('count is case-insensitive and finds a word split across inline nodes', () => {
    expect(count(doc, 'installazione')).toBe(2);
  });

  test('match case narrows it', () => {
    expect(count(doc, 'Installazione', true)).toBe(1);
  });

  test('two blocks never glue into a word that is not there', () => {
    // «Installazione» + «Prima» would read «InstallazionePrima» without a boundary.
    expect(count(doc, 'zioneprima')).toBe(0);
  });

  test('script text is not read', () => {
    expect(count(doc, 'codice')).toBe(0);
  });

  test('order is document order', () => {
    const { text, segments } = collectText(doc);
    const hits = findMatches(text, 'prezzi', false);
    expect(hits.length).toBe(2);
    const first = locate(segments, hits[0]![0], false)!;
    const second = locate(segments, hits[1]![0], false)!;
    expect(first.node).toBe(second.node);
    expect(first.offset).toBe(0);
    expect(second.offset).toBe(9);
  });

  test('a match across two nodes starts in one and ends in the other', () => {
    const { text, segments } = collectText(doc);
    const [s, e] = findMatches(text, 'installazione', false)[1]!;
    const a = locate(segments, s, false)!;
    const b = locate(segments, e, true)!;
    expect((a.node as TextNodeLike).nodeValue).toBe('instal');
    expect((b.node as TextNodeLike).nodeValue).toBe('lazione ');
    expect(b.offset).toBe(7);
  });

  test('a recount after a mutation sees the new text', () => {
    const p = el('P', textNode('Prezzi'));
    const root = el('BODY', p);
    expect(count(root, 'prezzi')).toBe(1);
    (p.childNodes as TextNodeLike[]).push(textNode(' e altri prezzi'));
    expect(count(root, 'prezzi')).toBe(2);
  });

  test('an empty query finds nothing', () => {
    expect(findMatches('abc', '', false)).toEqual([]);
  });
});
