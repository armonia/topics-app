/**
 * The strip at the foot of the sidebar: nothing before the hub was ever read,
 * a sentence and numbers while it answers, one quiet line once it stops.
 * Rendered with `renderToStaticMarkup` (no DOM in this bench), fed through the
 * same store the socket feeds.
 * @covers HUBBR-04
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SystemStrip } from './SystemStrip';
import { _adoptForTests, _resetForTests } from '../../state/hubLive';

afterEach(() => _resetForTests());

const render = () => renderToStaticMarkup(createElement(SystemStrip));

describe('HUBBR-04: the status strip', () => {
  test('renders nothing while the hub was never read', () => {
    expect(render()).toBe('');
    _adoptForTests({ type: 'hub:live', topic: 'mac', error: 'hub not reachable', at: 1 });
    expect(render()).toBe('');
  });

  test('one sentence, the services down and the numbers while the hub answers', () => {
    _adoptForTests({ type: 'hub:live', topic: 'mac', data: { swapUsedGB: 1.26, effort: { parts: [{ key: 'cpu', pct: 34 }] } }, at: 1 });
    _adoptForTests({ type: 'hub:live', topic: 'services', data: { services: [{ id: 'docs', name: 'Docs', state: 'spento' }] }, at: 1 });
    _adoptForTests({ type: 'hub:live', topic: 'pace', data: [{ provider: 'claude', account: 'a', active: true, used: 62 }], at: 1 });
    const html = render();
    expect(html).toContain('data-testid="system-strip"');
    expect(html).toContain('data-state="attention"');
    expect(html).toContain('data-testid="system-strip-numbers"');
    expect(html).toContain('>34<');
    expect(html).toContain('1.3G');
    expect(html).toContain('data-testid="system-strip-quota"');
    expect(html).toContain('>62<');
  });

  test('a hub that stops answering keeps the strip but drops every number', () => {
    _adoptForTests({ type: 'hub:live', topic: 'mac', data: { swapUsedGB: 1, effort: { parts: [{ key: 'cpu', pct: 34 }] } }, at: 1 });
    _adoptForTests({ type: 'hub:live', topic: 'mac', error: 'hub not reachable', at: 2 });
    const html = render();
    expect(html).toContain('data-state="down"');
    expect(html).not.toContain('system-strip-numbers');
    expect(html).not.toContain('>34<');
  });
});
