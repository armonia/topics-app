/**
 * THE PREVIEW THAT DREW THE APP INSTEAD OF THE FILE.
 *
 * Opening a PDF from a project's file tree showed Topics inside the editor tab.
 * The viewer built its address as a relative `/preview<path>`, and an `<iframe
 * src>` is resolved by the browser, not by the `fetch` shim (which rewrites
 * `fetch` and `EventSource` only). In the desktop shell the UI is served from
 * `tauri://localhost`, whose asset resolver answers an unknown path with the
 * SPA `index.html`: the tab got a second full copy of the app, and an image got
 * a broken icon.
 *
 * The mount is `renderToStaticMarkup` (jsdom is not a dependency here) and the
 * origin is moved by replacing `shell/net` in the registry, because `isTauri`
 * is a constant computed at load time and is always false under `bun test`.
 *
 * @covers FILEPREVIEW-01
 */
import { describe, expect, test, afterAll, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

const PROXY = 'http://127.0.0.1:13333';
const PDF = '/Users/somebody/docs/contract.pdf';

// The real module, photographed BEFORE it is replaced: the only way to put it
// back (the replacement is process-wide, and `mock.restore()` does not undo a
// `mock.module`). Named one by one rather than spread from the namespace, which
// would make the module opaque to the dead-code gate.
const { serverHttpBase, serverWsBase, isAppLoopbackOrigin, installNetShim, __resetNetShimForTests } =
  await import('../../lib/shell/net');
const realNet = { serverHttpBase, serverWsBase, isAppLoopbackOrigin, installNetShim, __resetNetShimForTests };

// Read at call time, so one mock serves both hosts.
let base = '';
mock.module('../../lib/shell/net', () => ({ ...realNet, serverHttpBase: () => base }));

const { MediaViewer, HtmlPreview } = await import('./fileMedia');

afterAll(() => {
  mock.module('../../lib/shell/net', () => realNet);
});

function srcOf(html: string): string {
  return /src="([^"]*)"/.exec(html)?.[1] ?? '';
}

describe('the address of a file preview', () => {
  test('on the desktop shell it carries the data server origin', () => {
    base = PROXY;
    const html = renderToStaticMarkup(
      <MediaViewer filePath={PDF} mediaType="pdf" filename="contract.pdf" />,
    );

    expect(srcOf(html)).toBe(`${PROXY}/preview${PDF}`);
  });

  test('an image is served by the same origin, not by the shell', () => {
    base = PROXY;
    const html = renderToStaticMarkup(
      <MediaViewer filePath="/Users/somebody/shot.png" mediaType="image" filename="shot.png" />,
    );

    expect(html).toContain(`${PROXY}/preview/Users/somebody/shot.png`);
    expect(html).not.toContain('src="/preview');
  });

  test('the HTML preview follows the same rule', () => {
    base = PROXY;
    const html = renderToStaticMarkup(
      <HtmlPreview filePath="/Users/somebody/page.html" filename="page.html" />,
    );

    expect(srcOf(html)).toBe(`${PROXY}/preview/Users/somebody/page.html`);
  });

  test('on the web, where the server serves the UI, it stays relative', () => {
    base = '';
    const html = renderToStaticMarkup(
      <MediaViewer filePath={PDF} mediaType="pdf" filename="contract.pdf" />,
    );

    expect(srcOf(html)).toBe(`/preview${PDF}`);
  });
});
