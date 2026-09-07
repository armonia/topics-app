/**
 * Where a local file gets resolved INSIDE THE DESKTOP SHELL, which is the one
 * host where the origin showing the UI is not the origin serving it.
 *
 * The bug: `open_browser_pane('file:///…/spec.pdf')` answered
 * `tauri://localhost/api/media?path=…` and the pane stayed white. The rewrite
 * to `/api/media` was right; resolving that reference against
 * `window.location.origin` was not, because under Tauri that origin is the
 * asset protocol and no HTTP server answers there.
 *
 * Why a separate file, and why the mock: `isTauri` (`shell/index.ts`) is a
 * module-load constant, false under `bun test` where Tauri's globals do not
 * exist - so the shell branch is unreachable by construction unless the module
 * is replaced in the registry. Same technique, and same careful restore, as
 * `shell/net.tauri.test.ts`.
 *
 * @covers BROWSER-01
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';

const PROXY = 'http://127.0.0.1:13333';
const MEDIA = '/api/media?path=%2FUsers%2Fx%2FDanceRooms-Spec.pdf';

let realIndex: {
  isTauri: boolean;
  isDesktop: boolean;
  shellKind: 'tauri' | 'web';
  detectShell: () => 'tauri' | 'web';
};

// The names are spelled out rather than spread from the namespace: an opaque
// whole-module reference blinds the dead-code gate to every export of that file
// (`bun run check:deadcode-blindspots`).
async function loadNav() {
  const { resolveBrowserNavigateUrl, toNavigableUrl, normalizeUrl } = await import('./browserNavUrl');
  return { resolveBrowserNavigateUrl, toNavigableUrl, normalizeUrl };
}
let nav: Awaited<ReturnType<typeof loadNav>>;

const realWindow = (globalThis as { window?: unknown }).window;

beforeAll(async () => {
  // The shell's own origin, the one that has no server behind it.
  (globalThis as { window?: unknown }).window = {
    location: { hostname: 'localhost', protocol: 'tauri:', origin: 'tauri://localhost' },
  };
  const { isTauri, isDesktop, shellKind, detectShell } = await import('./shell/index');
  realIndex = { isTauri, isDesktop, shellKind, detectShell };
  mock.module('./shell/index', () => ({
    ...realIndex,
    isTauri: true,
    isDesktop: true,
    shellKind: 'tauri' as const,
    detectShell: () => 'tauri' as const,
  }));
  nav = await loadNav();
});

afterAll(() => {
  // `mock.module` is process-wide and `mock.restore()` does not withdraw it:
  // the only way back is to re-mock with the photograph taken above.
  mock.module('./shell/index', () => realIndex);
  mock.restore();
  if (realWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = realWindow;
});

describe('local file resolution under the desktop shell', () => {
  test('an agent navigation to a media reference targets the data server, not the shell', () => {
    const out = nav.resolveBrowserNavigateUrl(MEDIA);
    expect(out).toBe(`${PROXY}${MEDIA}`);
    // The whole defect in one assertion: this is what the pane used to be sent to.
    expect(out.startsWith('tauri://')).toBe(false);
  });

  test('a file:// typed in the address bar becomes a served URL on the data server', () => {
    expect(nav.toNavigableUrl('file:///Users/x/DanceRooms-Spec.pdf')).toBe(`${PROXY}${MEDIA}`);
  });

  test('a bare absolute path is the same document, not a search', () => {
    expect(nav.toNavigableUrl('/Users/x/DanceRooms-Spec.pdf')).toBe(`${PROXY}${MEDIA}`);
  });

  test('normalizeUrl resolves an app path on the server origin', () => {
    expect(nav.normalizeUrl(MEDIA)).toBe(`${PROXY}${MEDIA}`);
  });

  test('an ordinary web address is left alone', () => {
    expect(nav.resolveBrowserNavigateUrl('https://example.com/')).toBe('https://example.com/');
    expect(nav.normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });
});
