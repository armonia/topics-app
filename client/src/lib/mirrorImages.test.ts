import { describe, expect, test } from 'bun:test';
import { createImageDeferral } from './mirrorImages';

/** @covers BROWSER-DOM-LAZY-01 */

const img = (id: number, attributes: Record<string, unknown>) => ({ type: 2, id, tagName: 'img', attributes, childNodes: [] as unknown[] });
const page = (...children: unknown[]) => ({ type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: 'body', attributes: {}, childNodes: children }] });
const snapshot = (...children: unknown[]) => ({ type: 2, data: { node: page(...children) } });

describe('createImageDeferral', () => {
  test('a lazy image reaches the mirror without its sources; one not marked lazy keeps them', () => {
    const deferral = createImageDeferral();
    const lazy = img(10, { srcset: '/a.png 2x', src: '/a.png', loading: 'LAZY', alt: 'a' });
    const plain = img(11, { src: '/b.png' });
    const eager = img(12, { src: '/c.png', loading: 'eager' });
    deferral.onEvent(snapshot(lazy, plain, eager));
    expect(lazy.attributes).toEqual({ 'data-topics-srcset': '/a.png 2x', 'data-topics-src': '/a.png', loading: 'LAZY', alt: 'a' });
    expect(plain.attributes).toEqual({ src: '/b.png' });
    expect(eager.attributes).toEqual({ src: '/c.png', loading: 'eager' });
  });

  test('a waiting image keeps a new src aside until it is revealed, then takes the next as is', () => {
    const deferral = createImageDeferral();
    deferral.onEvent({ type: 3, data: { source: 0, adds: [{ parentId: 2, node: img(20, { src: '/d.png', loading: 'lazy' }) }] } });
    const change = { id: 20, attributes: { src: '/e.png' } as Record<string, unknown> };
    deferral.onEvent({ type: 3, data: { source: 0, adds: [], attributes: [change] } });
    expect(change.attributes).toEqual({ 'data-topics-src': '/e.png' });

    deferral.revealed(20);
    const later = { id: 20, attributes: { src: '/f.png' } as Record<string, unknown> };
    deferral.onEvent({ type: 3, data: { source: 0, adds: [], attributes: [later] } });
    expect(later.attributes).toEqual({ src: '/f.png' });
  });

  test('images in a nested frame, and events other than mutations, are left alone', () => {
    const deferral = createImageDeferral();
    deferral.onEvent(snapshot({ type: 2, id: 30, tagName: 'iframe', attributes: {}, childNodes: [] }));
    // rrweb attaches the frame's document under the iframe, by mutation.
    const framed = img(32, { src: '/g.png', loading: 'lazy' });
    deferral.onEvent({ type: 3, data: { source: 0, adds: [{ parentId: 30, node: { type: 0, id: 31, childNodes: [framed] } }] } });
    expect(framed.attributes).toEqual({ src: '/g.png', loading: 'lazy' });

    const scroll = { type: 3, data: { source: 3, id: 1, x: 0, y: 10 } };
    deferral.onEvent(scroll);
    expect(scroll.data).toEqual({ source: 3, id: 1, x: 0, y: 10 });
  });
});
