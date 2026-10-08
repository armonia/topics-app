/**
 * THE BOX OF A PICTURE BEFORE ITS BYTES: the style the size gives, and the real
 * `MessageContent` rendered to markup with and without the sizes of its row.
 * @covers CHAT-MEDIA-BOX-01
 */
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageContent } from '../MessageContent';
import { MediaSizesContext, mediaBoxStyle, mergeMediaSizes, type MediaSizes } from './mediaBox';

const render = (content: string, sizes: MediaSizes | undefined, role: 'user' | 'assistant' = 'assistant') =>
  renderToStaticMarkup(createElement(MediaSizesContext.Provider, { value: sizes },
    createElement(MessageContent, { content, role, sessionKey: 'topic:x', messageId: 'm-1' })));

/** The `<img>` of the picture, as markup. */
const imgOf = (html: string) => /<img data-testid="media-image"[^>]*>/.exec(html)?.[0] ?? '';

describe('the style a size gives', () => {
  test('the smaller of its own width and the width at max-h-80 (the column is the class\'s max-w-full); the height from the ratio', () => {
    expect(mediaBoxStyle([1600, 900])).toEqual({
      width: 'min(1600px, calc(var(--spacing, 0.25rem) * 80 * 1600 / 900))',
      aspectRatio: '1600 / 900',
    });
  });

  test('no size, or one no picture can have: no style, the picture as before', () => {
    for (const bad of [undefined, null, [], [0, 10], [10, -1], [Number.NaN, 3], ['1', '2'], [1, 2, 3], [1e9, 10]]) {
      expect(mediaBoxStyle(bad)).toBeUndefined();
    }
  });

  test('the sizes of `message:media` add to the ones the row had', () => {
    expect(mergeMediaSizes({ '/a.png': [1, 2] }, { '/b.png': [3, 4] })).toEqual({ '/a.png': [1, 2], '/b.png': [3, 4] });
    expect(mergeMediaSizes(undefined, { '/b.png': [3, 4] })).toEqual({ '/b.png': [3, 4] });
    const a: MediaSizes = { '/a.png': [1, 2] };
    expect(mergeMediaSizes(a, undefined)).toBe(a);
  });
});

describe('a picture of a message', () => {
  test('the server marker, with its size: the box is drawn before the bytes', () => {
    const img = imgOf(render('Done.\nMEDIA:/uploads/shot.png', { '/uploads/shot.png': [1600, 900] }));
    expect(img).toContain('aspect-ratio:1600 / 900');
    expect(img).toContain('width:min(1600px');
  });

  test('a person\'s attachment, with its size', () => {
    const img = imgOf(render('[Attached file: /uploads/me.jpg]', { '/uploads/me.jpg': [300, 400] }, 'user'));
    expect(img).toContain('aspect-ratio:300 / 400');
  });

  test('a local markdown image, by the path the renderer draws it under', () => {
    const img = imgOf(render('See ![chart](uploads/chart.png)', { '/uploads/chart.png': [640, 480] }));
    expect(img).toContain('aspect-ratio:640 / 480');
  });

  test('no size for this picture: the same `<img>` as before, with no style', () => {
    const img = imgOf(render('MEDIA:/uploads/other.png', { '/uploads/shot.png': [1600, 900] }));
    expect(img).not.toBe('');
    expect(img).not.toContain('style=');
    expect(imgOf(render('MEDIA:/uploads/other.png', undefined))).not.toContain('style=');
  });
});
