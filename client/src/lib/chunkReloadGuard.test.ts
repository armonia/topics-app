/**
 * A lazy chunk that fails to load is reported, never swallowed; a chunk that
 * loaded and threw is a bug, not a stale bundle; and a failed chunk can be
 * asked for again under a fresh URL.
 *
 * @covers BUNDLE-TOAST-02
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BUNDLE_STALE_EVENT } from './devBundleReload';
import { CHUNK_FAILURE_REASON, findChunkHref, initChunkReloadGuard, reimportChunk, reportLoadFailure } from './chunkReloadGuard';
import { warm } from './lazyWarm';

// The message WebKit gives a dynamic import that 404s (measured in Playwright
// WebKit, 2026-09-29), and the one Chromium gives.
const WEBKIT_404 = new TypeError('Importing a module script failed.');
const CHROMIUM_404 = new TypeError('Failed to fetch dynamically imported module: https://h/assets/X-abc.js');

type Globals = Record<string, unknown>;
const g = globalThis as unknown as Globals;
let saved: Globals;
let reasons: (string | undefined)[];
let logged: unknown[][];
const originalConsoleError = console.error;

/** A document holding these `<link rel="modulepreload">` hrefs, nothing else. */
function docWith(hrefs: string[]): ParentNode {
  return {
    querySelectorAll: (selector: string) =>
      (selector === 'link[rel="modulepreload"]' ? hrefs.map((href) => ({ href })) : []),
  } as unknown as ParentNode;
}

beforeEach(() => {
  saved = { window: g.window, document: g.document };
  reasons = [];
  logged = [];
  const target = new EventTarget();
  target.addEventListener(BUNDLE_STALE_EVENT, (event) => {
    reasons.push((event as CustomEvent<{ reason?: string }>).detail?.reason);
  });
  g.window = Object.assign(target, { location: { href: 'https://h/' } });
  g.document = docWith([]);
  console.error = (...args: unknown[]) => { logged.push(args); };
});

afterEach(() => {
  g.window = saved.window;
  g.document = saved.document;
  console.error = originalConsoleError;
});

describe('reportLoadFailure', () => {
  test('a chunk that did not load raises the reload prompt, marked as a chunk failure', () => {
    expect(reportLoadFailure(WEBKIT_404)).toBe(true);
    expect(reportLoadFailure(CHROMIUM_404)).toBe(true);
    expect(reasons).toEqual([CHUNK_FAILURE_REASON, CHUNK_FAILURE_REASON]);
    expect(logged).toEqual([]);
  });

  test('a chunk that loaded and threw is logged, and no reload is offered as a cure', () => {
    const bug = new TypeError('undefined is not an object (evaluating \'x.y\')');
    expect(reportLoadFailure(bug)).toBe(false);
    expect(reasons).toEqual([]);
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain(bug);
  });
});

/** The event Vite's preload helper dispatches, `payload` = what rejected. */
function preloadError(payload: unknown): Event {
  return Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload });
}

describe('initChunkReloadGuard: vite:preloadError', () => {
  // Vite fires it for ANY rejection of the wrapped import, including a chunk
  // that arrived and threw while evaluating. Only a chunk that did not arrive
  // is an old build.
  test('a chunk that did not arrive raises the prompt, one that threw does not', () => {
    const stop = initChunkReloadGuard();
    try {
      const w = g.window as EventTarget;
      w.dispatchEvent(preloadError(new Error('adv-eval-boom')));
      w.dispatchEvent(preloadError(new TypeError("undefined is not an object (evaluating 'x.y')")));
      expect(reasons).toEqual([]);
      w.dispatchEvent(preloadError(WEBKIT_404));
      w.dispatchEvent(preloadError(new Error('Unable to preload CSS for https://h/assets/Menu-abc.css')));
      expect(reasons).toEqual([CHUNK_FAILURE_REASON, CHUNK_FAILURE_REASON]);
    } finally {
      stop();
    }
  });
});

describe('warm', () => {
  test('a failed load is reported even when the caller swallows the rejection', async () => {
    const load = () => Promise.reject(WEBKIT_404);
    await warm(load).catch(() => {});
    // The report runs on warm's own chain, one microtask behind the caller's.
    await Promise.resolve();
    expect(reasons).toEqual([CHUNK_FAILURE_REASON]);
  });
});

describe('findChunkHref', () => {
  test('finds the chunk by its file name, not by a longer name that shares the prefix', () => {
    const doc = docWith([
      'https://h/assets/AiExecutionMenuOptionsExtra-aaa.js',
      'https://h/assets/AiExecutionMenuOptions-Bind-FmI.js',
      'https://h/assets/index-Cy.css',
    ]);
    expect(findChunkHref(doc, 'AiExecutionMenuOptions')).toBe('https://h/assets/AiExecutionMenuOptions-Bind-FmI.js');
    expect(findChunkHref(doc, 'CommandPalette')).toBeNull();
  });
});

describe('reimportChunk', () => {
  test('a failure that is not a chunk-load failure is rethrown as it is', async () => {
    const bug = new Error('boom');
    g.document = docWith(['https://h/assets/Menu-abc.js']);
    await expect(reimportChunk('Menu', bug)).rejects.toBe(bug);
  });

  test('a chunk with no known URL rethrows the original failure', async () => {
    await expect(reimportChunk('Menu', WEBKIT_404)).rejects.toBe(WEBKIT_404);
  });

  test('a failed chunk is imported again under a fresh URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reimport-'));
    const file = join(dir, 'Menu-abc.js');
    writeFileSync(file, 'export const value = 42;\n');
    const href = pathToFileURL(file).href;
    g.document = docWith([href]);
    const module = await reimportChunk<{ value: number }>('Menu', WEBKIT_404);
    expect(module.value).toBe(42);
  });
});
