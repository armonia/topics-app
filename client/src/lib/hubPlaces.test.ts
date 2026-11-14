/**
 * The hub's old bookmarks: `:3360/#<page>` sends to Topics keeping its
 * fragment, and the fragment opens the place of Topics that took the page
 * (hub-tutto-in-topics, C2), then leaves the address.
 *
 * @covers HUBBR-03
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { consumeHubBookmarkFromUrl, hubBookmarkTarget } from './hubPlaces';

// In bun there is no window: a fake one records the events and the address.
const fired: string[] = [];
let address = { pathname: '/', search: '', hash: '' };
const replaced: string[] = [];
(globalThis as { window?: unknown }).window = {
  dispatchEvent: (e: { type: string; detail?: unknown; init?: { detail?: unknown } }) => {
    const d = e.detail ?? e.init?.detail;
    fired.push(d ? `${e.type}:${JSON.stringify(d)}` : e.type);
    return true;
  },
  get location() { return address; },
  history: {
    state: null,
    replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url); address = { ...address, hash: '' }; },
  },
};
const hadCustomEvent = 'CustomEvent' in globalThis;
const hadEvent = 'Event' in globalThis;
class FakeEvent { constructor(readonly type: string, readonly init?: unknown) {} }
(globalThis as { CustomEvent?: unknown }).CustomEvent ??= FakeEvent;
(globalThis as { Event?: unknown }).Event ??= FakeEvent;

afterAll(() => {
  delete (globalThis as { window?: unknown }).window;
  if (!hadCustomEvent) delete (globalThis as { CustomEvent?: unknown }).CustomEvent;
  if (!hadEvent) delete (globalThis as { Event?: unknown }).Event;
});

beforeEach(() => { fired.length = 0; replaced.length = 0; });

describe('hub bookmarks', () => {
  test('every page of the hub maps to its place, an automation to its key', () => {
    expect(hubBookmarkTarget('#automations')).toEqual({ place: { kind: 'utility', type: 'automations' } });
    expect(hubBookmarkTarget('#automations/wf%3Anightly')).toEqual({ automationKey: 'workflow:nightly' });
    expect(hubBookmarkTarget('#accounts')).toEqual({ place: { kind: 'utility', type: 'accounts' } });
    expect(hubBookmarkTarget('#journal')).toEqual({ place: { kind: 'bell', tab: 'history' } });
    expect(hubBookmarkTarget('#overview')).toEqual({ place: { kind: 'bell', tab: 'now' } });
    expect(hubBookmarkTarget('#work/in-corso')).toEqual({ place: { kind: 'menu', level: 'agents' } });
    expect(hubBookmarkTarget('#logs')).toEqual({ place: { kind: 'log' } });
  });

  test('an unknown fragment is not ours', () => {
    for (const hash of ['', '#', '#nowhere', '#Automations', '#/tab/x', 'automations']) expect(hubBookmarkTarget(hash)).toBeNull();
  });

  test('a bookmark opens its place and leaves the address, keeping path and query', () => {
    address = { pathname: '/', search: '?x=1', hash: '#accounts' };
    expect(consumeHubBookmarkFromUrl()).toBe(true);
    expect(fired).toEqual(['topics:open-utility:{"type":"accounts"}']);
    expect(replaced).toEqual(['/?x=1']);
  });

  test('the diary opens the bell on its History', () => {
    address = { pathname: '/', search: '', hash: '#journal' };
    expect(consumeHubBookmarkFromUrl()).toBe(true);
    expect(fired).toEqual(['topics:open-inbox:{"tab":"history"}']);
  });

  test('one automation opens Automazioni on it', () => {
    address = { pathname: '/', search: '', hash: '#automations/cron%3Abackup' };
    expect(consumeHubBookmarkFromUrl()).toBe(true);
    expect(fired).toEqual(['topics:open-utility:{"type":"automations"}', 'topics:automation-target:{"key":"cron:backup"}']);
  });

  test('an unknown fragment stays where it is', () => {
    address = { pathname: '/', search: '', hash: '#nowhere' };
    expect(consumeHubBookmarkFromUrl()).toBe(false);
    expect(fired).toEqual([]);
    expect(replaced).toEqual([]);
  });
});
