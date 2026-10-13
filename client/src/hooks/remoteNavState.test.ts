/**
 * Where a remote pane's page is and where it is going, message by message.
 *
 * @covers BROWSER-LOAD-01
 */
import { describe, expect, test } from 'bun:test';
import { applyContextInfo, applyNavMessage, isBlankPage, startNavigation, type RemoteNavFields } from './remoteNavState';

const blank: RemoteNavFields = {
  url: '', title: '', loading: false, error: null, errorUrl: null,
  loadingSince: null, pageUrl: '', consoleEntries: [],
};

describe('remoteNavState (BROWSER-LOAD-01)', () => {
  test('a socket that opens in the middle of a load dates it from the server count', () => {
    const s = applyNavMessage(blank, { type: 'nav', phase: 'loading', url: 'http://127.0.0.1:4444/x', elapsedMs: 12_000 }, 100_000);
    expect(s).toMatchObject({ url: 'http://127.0.0.1:4444/x', loading: true, loadingSince: 88_000, pageUrl: '' });
  });

  test('the failure ends the wait and keeps the url to retry, the page stays blank', () => {
    const asked = startNavigation(blank, 'http://127.0.0.1:4444/x', 5);
    const s = applyNavMessage(asked, { type: 'nav', phase: 'error', url: 'http://127.0.0.1:4444/x', error: 'goto: Timeout 30000ms exceeded.' }, 30_005);
    expect(s).toMatchObject({ loading: false, loadingSince: null, errorUrl: 'http://127.0.0.1:4444/x', pageUrl: '' });
    expect(isBlankPage(s.pageUrl)).toBe(true);
  });

  test('a loaded page is the page: the wait and the error both go', () => {
    const failed = { ...blank, error: 'x', errorUrl: 'http://a.test/' };
    const s = applyNavMessage(startNavigation(failed, 'http://a.test/', 1), { type: 'nav', phase: 'response', url: 'http://a.test/' }, 2);
    expect(s).toMatchObject({ url: 'http://a.test/', pageUrl: 'http://a.test/', loading: false, loadingSince: null, error: null });
    expect(isBlankPage(s.pageUrl)).toBe(false);
  });

  test('the context info of a blank page neither ends a load nor erases where it goes', () => {
    const loading = applyNavMessage(blank, { type: 'nav', phase: 'loading', url: 'http://a.test/', elapsedMs: 0 }, 10);
    const s = applyContextInfo(loading, { url: 'about:blank', title: '' });
    expect(s).toMatchObject({ url: 'http://a.test/', loading: true, loadingSince: 10, pageUrl: 'about:blank' });
  });

  test('asking again for the url on its way keeps its clock, another url starts a new one', () => {
    const told = applyNavMessage(blank, { type: 'nav', phase: 'loading', url: 'http://a.test/', elapsedMs: 9_000 }, 10_000);
    expect(startNavigation(told, 'http://a.test/', 12_000).loadingSince).toBe(1_000);
    expect(startNavigation(told, 'http://b.test/', 12_000).loadingSince).toBe(12_000);
  });

  test('the context info of a real page is the page', () => {
    const s = applyContextInfo(startNavigation(blank, 'http://a.test/', 1), { url: 'http://b.test/', title: 'B' });
    expect(s).toMatchObject({ url: 'http://b.test/', pageUrl: 'http://b.test/', title: 'B', loading: false, loadingSince: null });
  });
});
