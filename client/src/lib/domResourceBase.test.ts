import { describe, expect, test } from 'bun:test';
import { baseProxiedResources } from './domResourceBase';

/** @covers BROWSER-DOM-RES-01 */

const P = '/api/browser/resource?ctx=a&u=http%3A%2F%2Flocalhost%3A3535%2F1.jpg';
const BASE = 'https://127.0.0.1:13333';

describe('baseProxiedResources', () => {
  test('in the desktop shell every proxied URL gets the server base', () => {
    const ev = { type: 2, data: { node: { attributes: { src: P, srcset: `${P} 1x, ${P} 2x`, style: `background:url("${P}")` } } } };
    baseProxiedResources(ev, BASE);
    const a = ev.data.node.attributes;
    expect(a.src).toBe(BASE + P);
    expect(a.srcset).toBe(`${BASE}${P} 1x, ${BASE}${P} 2x`);
    expect(a.style).toBe(`background:url("${BASE}${P}")`);
  });

  test('on the web (no base) the event is left as it is', () => {
    const ev = { data: { src: P } };
    baseProxiedResources(ev, '');
    expect(ev.data.src).toBe(P);
  });

  test('other URLs are not touched', () => {
    const ev = { data: { src: 'https://cdn.example.com/a.jpg', href: '/api/topics' } };
    baseProxiedResources(ev, BASE);
    expect(ev.data).toEqual({ src: 'https://cdn.example.com/a.jpg', href: '/api/topics' });
  });
});
