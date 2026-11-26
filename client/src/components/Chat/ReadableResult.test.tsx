/**
 * A JSON tool result gets a Readable / Original switch; the original text the
 * caller draws is passed through untouched, and plain text gets no switch.
 *
 * @covers READABLE-VIEW-03
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReadableResult } from './ReadableResult';
import { parseJsonResult } from '../../lib/jsonResult';
import { setReadableViewPrefs } from '../../state/readableViewPrefs';

const TASK = JSON.stringify({ id: '458c16a6', title: 'Fix the thing', status: 'review' });
const original = <pre data-testid="orig">{TASK}</pre>;

describe('ReadableResult', () => {
  test('readable mode lays out the fields and offers the switch', () => {
    setReadableViewPrefs({ mode: 'readable' });
    const html = renderToStaticMarkup(<ReadableResult text={TASK} toolName="topics__task_get" original={original} />);
    expect(html).toContain('data-testid="readable-card"');
    expect(html).toContain('Fix the thing');
    expect(html).toContain('data-testid="readable-mode-original"');
    expect(html).not.toContain('data-testid="orig"');
  });
  test('original mode shows the caller\'s text byte for byte', () => {
    setReadableViewPrefs({ mode: 'original' });
    const html = renderToStaticMarkup(<ReadableResult text={TASK} toolName="topics__task_get" original={original} />);
    expect(html).toContain(renderToStaticMarkup(original));
    expect(html).not.toContain('data-testid="readable-card"');
  });
  test('plain text has no switch', () => {
    const html = renderToStaticMarkup(<ReadableResult text="just words" toolName="x__y" original={original} />);
    expect(html).toBe(renderToStaticMarkup(original));
  });
  test('parseJsonResult only accepts objects and arrays', () => {
    expect(parseJsonResult('42')).toBeUndefined();
    expect(parseJsonResult('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonResult('{broken')).toBeUndefined();
  });
});

describe('typed cells', () => {
  beforeEach(() => setReadableViewPrefs({ mode: 'readable' }));

  test('a task object renders as a card with status and label chips, no raw JSON array', () => {
    const json = JSON.stringify({ id: 'x1', title: 'Hello', status: 'in_progress', labels: ['ui', 'chat'] });
    const html = renderToStaticMarkup(<ReadableResult text={json} toolName="topics__task_get" original={<pre>orig</pre>} />);
    expect(html).toContain('readable-card');
    expect(html).toContain('in progress');
    expect(html).not.toContain('[&quot;ui');
  });

  test('a table renders both the wide table and the narrow per-row cards', () => {
    const json = JSON.stringify([{ id: 'a1', status: 'todo' }, { id: 'b2', status: 'review' }]);
    const html = renderToStaticMarkup(<ReadableResult text={json} toolName="topics__task_list" original={<pre>orig</pre>} />);
    expect(html).toContain('readable-table"');
    expect(html).toContain('readable-table-cards');
  });
});
