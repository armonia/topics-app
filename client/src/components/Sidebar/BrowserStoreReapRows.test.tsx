/**
 * THE SWITCHES SAY WHAT THE REAPER WILL DO, AND SAVE WHAT WAS PRESSED.
 *
 * The cleanup of closed browsers' data has two levels (Attilio, on #425): the
 * cache of closed browsers, on by default, and under it "also delete logins and
 * history", off by default, which removes whole stores for good. The rows that
 * control them have one job: show the state the reaper is going to read, and
 * save exactly the field that was touched. A switch drawn inverted (OFF on
 * screen, ON on disk) is the worst defect they can have, and so is a press on
 * the first level that writes the second one.
 *
 * No DOM here (jsdom/happy-dom are not dependencies, as `VersionChip.test.tsx`
 * says). The rows are split in two for this: `BrowserStoreReapRows` holds the
 * request and the state, `BrowserStoreReapControls` is a function of its props
 * with no hooks, so it is called and its tree inspected, the technique of
 * `Settings/IdentitySection.test.tsx`, and rendered with `renderToStaticMarkup`
 * for what reaches the screen.
 *
 * The container is tested too, because it is the half that saves: after a PUT
 * the switch must show what the server answered, and a failed save must say so.
 * It is mounted through `test/reactHarness` (the hook runtime that re-renders),
 * with `appSettingsApi.get` and `.update` replaced in place, the way
 * `hooks/useBoardFeed.test.ts` replaces `boardApi.list`: no request leaves the
 * process, so nothing reaches a real server.
 *
 * @covers BROWSER-STORE-REAP-06
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { t } from '../../lib/i18n';
import { appSettingsApi, type AppBehaviorSettings } from '../../lib/api';
import { mount, type Harness, type HostNode } from '../../test/reactHarness';
import { SwitchRow } from './PreferenceRow';
import { BrowserStoreReapControls, BrowserStoreReapRows } from './BrowserStoreReapRows';

type Stored = Pick<
  AppBehaviorSettings,
  'browserStoreCacheReapEnabled' | 'browserStoreReapEnabled' | 'browserStoreReapAfterDays'
>;
type Patch = Partial<AppBehaviorSettings>;

const tr = (key: string) => t(key, 'it');

/** Flattens the tree a component returns into a list of elements. */
function elementsOf(node: ReactNode, into: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) elementsOf(n as ReactNode, into);
    return into;
  }
  if (!node || typeof node !== 'object' || !('type' in node)) return into;
  const el = node as ReactElement<{ children?: ReactNode }>;
  into.push(el);
  elementsOf(el.props?.children, into);
  return into;
}

type SwitchProps = { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void };

interface Drawn {
  saves: Patch[];
  typed: Array<string | null>;
  /** Level 1: the cache of closed browsers. */
  cacheRow: ReactElement<SwitchProps>;
  /** Level 2: also logins and history, under the first. */
  wholeRow: ReactElement<SwitchProps>;
  input: ReactElement<{
    value: string;
    disabled: boolean;
    onBlur: (e: { target: { value: string } }) => void;
    onChange: (e: { target: { value: string } }) => void;
    onKeyDown: (e: { key: string; currentTarget: { blur: () => void } }) => void;
  }>;
  html: string;
}

function draw(stored: Stored, typed: string | null = null): Drawn {
  const saves: Patch[] = [];
  const typedLog: Array<string | null> = [];
  const props = {
    settings: stored,
    typed,
    saveFailed: false,
    tr,
    onType: (raw: string | null) => { typedLog.push(raw); },
    onSave: (patch: Patch) => { saves.push(patch); },
  };
  const tree = BrowserStoreReapControls(props);
  const all = elementsOf(tree);
  const rows = all.filter((e) => e.type === SwitchRow) as Array<ReactElement<SwitchProps>>;
  const input = all.find((e) => e.type === 'input') as Drawn['input'] | undefined;
  if (rows.length !== 2 || !input) throw new Error(`expected two switches and the days field, found ${rows.length} switches`);
  const [cacheRow, wholeRow] = rows;
  return { saves, typed: typedLog, cacheRow, wholeRow, input, html: renderToStaticMarkup(<BrowserStoreReapControls {...props} />) };
}

const NEVER_TOUCHED: Stored = { browserStoreCacheReapEnabled: null, browserStoreReapEnabled: null, browserStoreReapAfterDays: null };
/** Level 1 switched off: level 2 is dead under it, whatever it holds. */
const CACHE_OFF: Stored = { browserStoreCacheReapEnabled: false, browserStoreReapEnabled: false, browserStoreReapAfterDays: 90 };
const WHOLE_ON: Stored = { browserStoreCacheReapEnabled: true, browserStoreReapEnabled: true, browserStoreReapAfterDays: 30 };

describe('the switches show the state the reaper reads', () => {
  test('never touched: level 1 on, level 2 off and usable, 60 days, the field can be changed', () => {
    const d = draw(NEVER_TOUCHED);
    expect(d.cacheRow.props.checked).toBe(true);
    expect(d.cacheRow.props.disabled).toBeFalsy();
    expect(d.wholeRow.props.checked).toBe(false);
    expect(d.wholeRow.props.disabled).toBe(false);
    expect(d.input.props.value).toBe('60');
    expect(d.input.props.disabled).toBe(false);
    expect(d.html.match(/aria-checked="true"/g)?.length).toBe(1);
    expect(d.html.match(/aria-checked="false"/g)?.length).toBe(1);
  });

  test('level 1 switched off: level 2 and the days field are disabled', () => {
    const d = draw(CACHE_OFF);
    expect(d.cacheRow.props.checked).toBe(false);
    expect(d.wholeRow.props.disabled).toBe(true);
    expect(d.input.props.value).toBe('90');
    expect(d.input.props.disabled).toBe(true);
    // Both switches off on screen; the second and the field are really disabled.
    expect(d.html.match(/aria-checked="false"/g)?.length).toBe(2);
    expect(d.html).toMatch(/<button[^>]*data-testid="perf-browser-store-reap"[^>]*disabled=""|<button[^>]*disabled=""[^>]*data-testid="perf-browser-store-reap"/);
    expect(d.html).toMatch(/<input[^>]*disabled=""/);
  });

  test('level 2 left on under a level 1 turned off still shows what was chosen, disabled', () => {
    const d = draw({ browserStoreCacheReapEnabled: false, browserStoreReapEnabled: true, browserStoreReapAfterDays: 60 });
    expect(d.wholeRow.props.checked).toBe(true);
    expect(d.wholeRow.props.disabled).toBe(true);
  });

  test('both on: both switches on and nothing disabled', () => {
    const d = draw(WHOLE_ON);
    expect(d.cacheRow.props.checked).toBe(true);
    expect(d.wholeRow.props.checked).toBe(true);
    expect(d.wholeRow.props.disabled).toBe(false);
    expect(d.input.props.value).toBe('30');
  });

  test('the second row is indented under the first', () => {
    const d = draw(NEVER_TOUCHED);
    expect(d.html).toMatch(/<div class="pl-4"[^>]*data-testid="perf-browser-store-reap-whole"|<div[^>]*data-testid="perf-browser-store-reap-whole"[^>]*class="pl-4"/);
  });

  test('the copy decided for it is the copy on screen, with the labels exactly as decided', () => {
    const d = draw(NEVER_TOUCHED);
    expect(d.cacheRow.props.label).toBe('Svuota la cache dei browser chiusi');
    expect(d.wholeRow.props.label).toBe('Cancella anche accessi e cronologia');
    expect(d.html).toContain('Svuota la cache dei browser chiusi');
    expect(d.html).toContain('Cancella anche accessi e cronologia');
    expect(d.html).toContain('Accessi, cookie e dati dei siti restano');
    expect(d.html).toContain('Toglie per sempre anche accessi, cookie e dati dei siti');
    expect(d.html).toContain('dopo');
    expect(d.html).toContain('giorni senza uso');
  });
});

describe('pressing a switch saves that switch, and only that switch', () => {
  test('level 1 on → off saves browserStoreCacheReapEnabled: false and nothing else', () => {
    const d = draw(NEVER_TOUCHED);
    d.cacheRow.props.onChange(false);
    expect(d.saves).toEqual([{ browserStoreCacheReapEnabled: false }]);
  });

  test('level 1 off → on saves browserStoreCacheReapEnabled: true and nothing else', () => {
    const d = draw(CACHE_OFF);
    d.cacheRow.props.onChange(true);
    expect(d.saves).toEqual([{ browserStoreCacheReapEnabled: true }]);
  });

  test('level 1 pressed while level 2 is on does not write level 2', () => {
    const d = draw(WHOLE_ON);
    d.cacheRow.props.onChange(false);
    expect(d.saves).toEqual([{ browserStoreCacheReapEnabled: false }]);
  });

  test('level 2 off → on saves browserStoreReapEnabled: true and nothing else', () => {
    const d = draw(NEVER_TOUCHED);
    d.wholeRow.props.onChange(true);
    expect(d.saves).toEqual([{ browserStoreReapEnabled: true }]);
  });

  test('level 2 on → off saves browserStoreReapEnabled: false and nothing else', () => {
    const d = draw(WHOLE_ON);
    d.wholeRow.props.onChange(false);
    expect(d.saves).toEqual([{ browserStoreReapEnabled: false }]);
  });
});

describe('the days field saves a whole number inside 7..365', () => {
  test('a number inside the range is saved as it is', () => {
    const d = draw(NEVER_TOUCHED);
    d.input.props.onBlur({ target: { value: '30' } });
    expect(d.saves).toEqual([{ browserStoreReapAfterDays: 30 }]);
  });

  test('outside the range it is brought to the nearest limit before it is saved', () => {
    const cases: Array<[string, number]> = [['3', 7], ['0', 7], ['400', 365], ['14.4', 14]];
    for (const [typed, kept] of cases) {
      const d = draw(NEVER_TOUCHED);
      d.input.props.onBlur({ target: { value: typed } });
      expect(d.saves).toEqual([{ browserStoreReapAfterDays: kept }]);
    }
  });

  test('the value already stored, an empty field or a word: nothing is saved', () => {
    // '60.4' rounds to the 60 already shown: the comparison is on the number
    // that would be saved, not on the one typed.
    for (const typed of ['60', '60.4', '', '  ', 'tanti']) {
      const d = draw(NEVER_TOUCHED);
      d.input.props.onBlur({ target: { value: typed } });
      expect(d.saves).toEqual([]);
    }
  });

  test('typing is held as typed until it is committed, then let go', () => {
    const draft = draw(NEVER_TOUCHED, '12');
    expect(draft.input.props.value).toBe('12');
    // Emptied while typing stays empty: the stored number does not jump back in.
    expect(draw(NEVER_TOUCHED, '').input.props.value).toBe('');
    draft.input.props.onChange({ target: { value: '120' } });
    draft.input.props.onBlur({ target: { value: '120' } });
    expect(draft.typed).toEqual(['120', null]);
  });
});

describe('Enter commits the days field', () => {
  test('Enter leaves the field, which commits it; another key does not', () => {
    const d = draw(NEVER_TOUCHED, '30');
    let blurs = 0;
    d.input.props.onKeyDown({ key: 'a', currentTarget: { blur: () => { blurs++; } } });
    expect(blurs).toBe(0);
    d.input.props.onKeyDown({ key: 'Enter', currentTarget: { blur: () => { blurs++; } } });
    expect(blurs).toBe(1);
  });
});

describe('nothing is drawn before the stored values are read', () => {
  test('the rows render empty while the request is out', () => {
    // On the server render no effect runs, so the GET never returns: this is
    // the state before it does. Drawing the default here would state a choice
    // nobody has seen.
    expect(renderToStaticMarkup(<BrowserStoreReapRows />)).toBe('');
  });
});

describe('the container: what the server answered is what the switch shows', () => {
  const realGet = appSettingsApi.get;
  const realUpdate = appSettingsApi.update;
  let harness: Harness | null = null;
  let onDisk: Stored = NEVER_TOUCHED;
  let puts: Patch[] = [];
  let putFails = false;

  /** A server in memory: GET answers what is stored, PUT stores and answers it,
   *  or throws, as `request()` does when the status is an error. */
  function fakeServer(initial: Stored): void {
    onDisk = { ...initial };
    puts = [];
    putFails = false;
    appSettingsApi.get = async () => ({ ...onDisk } as AppBehaviorSettings);
    appSettingsApi.update = async (patch) => {
      puts.push(patch);
      if (putFails) throw new Error('503 settings unreadable');
      onDisk = { ...onDisk, ...patch } as Stored;
      return { ...onDisk } as AppBehaviorSettings;
    };
  }

  /** Lets the queued promise callbacks run (the GET, the PUT), no timers. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  async function mountRows(): Promise<Harness> {
    harness = mount(createElement(BrowserStoreReapRows));
    await settle();
    return harness;
  }

  const hostOf = (h: Harness, match: (n: HostNode) => boolean): HostNode => {
    const node = h.last().hosts.find(match);
    if (!node) throw new Error('the control is not drawn');
    return node;
  };
  /** Level 1 by default, level 2 by its test id. */
  const switchOf = (h: Harness, testId = 'perf-browser-store-cache-reap') =>
    hostOf(h, (n) => n.props.role === 'switch' && n.props['data-testid'] === testId);
  const WHOLE = 'perf-browser-store-reap';
  const daysOf = (h: Harness) => hostOf(h, (n) => n.type === 'input');
  const press = (h: Harness, testId?: string) => (switchOf(h, testId).props.onClick as () => void)();
  const saveFailedLine = () => tr('browser.storeReap.saveFailed');

  afterEach(() => {
    harness?.unmount();
    harness = null;
    appSettingsApi.get = realGet;
    appSettingsApi.update = realUpdate;
  });

  test('a GET that failed draws nothing, not the default', async () => {
    // Level 1 on at 60 days drawn over a stored OFF would state a choice
    // nobody made.
    fakeServer(NEVER_TOUCHED);
    appSettingsApi.get = async () => { throw new Error('503 settings unreadable'); };
    const h = await mountRows();
    expect(h.last().hosts.filter((n) => n.props.role === 'switch' || n.type === 'input')).toEqual([]);
    expect(puts).toEqual([]);
  });

  test('level 1 off, then on again: each PUT answer is what the switches show', async () => {
    fakeServer(NEVER_TOUCHED);
    const h = await mountRows();
    expect(switchOf(h).props['aria-checked']).toBe(true);
    expect(switchOf(h, WHOLE).props['aria-checked']).toBe(false);

    press(h);
    await settle();
    expect(puts).toEqual([{ browserStoreCacheReapEnabled: false }]);
    expect(switchOf(h).props['aria-checked']).toBe(false);
    expect(switchOf(h, WHOLE).props.disabled).toBe(true);
    expect(daysOf(h).props.disabled).toBe(true);

    // The way back: a switch that cannot be turned on again no longer governs
    // the reaper, whatever it shows.
    press(h);
    await settle();
    expect(puts).toEqual([{ browserStoreCacheReapEnabled: false }, { browserStoreCacheReapEnabled: true }]);
    expect(switchOf(h).props['aria-checked']).toBe(true);
    expect(switchOf(h, WHOLE).props.disabled).toBe(false);
    expect(daysOf(h).props.disabled).toBe(false);
    expect(h.last().text).not.toContain(saveFailedLine());
  });

  test('level 2 on, then off again: the PUT answers are what the second switch shows', async () => {
    fakeServer(NEVER_TOUCHED);
    const h = await mountRows();

    press(h, WHOLE);
    await settle();
    expect(puts).toEqual([{ browserStoreReapEnabled: true }]);
    expect(switchOf(h, WHOLE).props['aria-checked']).toBe(true);
    // Level 1 did not move.
    expect(switchOf(h).props['aria-checked']).toBe(true);

    press(h, WHOLE);
    await settle();
    expect(puts).toEqual([{ browserStoreReapEnabled: true }, { browserStoreReapEnabled: false }]);
    expect(switchOf(h, WHOLE).props['aria-checked']).toBe(false);
  });

  test('the days were changed elsewhere meanwhile: the field shows the answer, not the patch', async () => {
    // The answer can hold more than the patch. Here another device wrote 30
    // between the GET and this PUT: merging the patch into what was read
    // would keep 60 on screen over a stored 30.
    fakeServer(NEVER_TOUCHED);
    const h = await mountRows();
    expect(daysOf(h).props.value).toBe('60');
    onDisk = { ...onDisk, browserStoreReapAfterDays: 30 };

    press(h);
    await settle();
    expect(puts).toEqual([{ browserStoreCacheReapEnabled: false }]);
    expect(switchOf(h).props['aria-checked']).toBe(false);
    expect(daysOf(h).props.value).toBe('30');
  });

  test('the days field shows the number the server kept, not the one typed', async () => {
    fakeServer(NEVER_TOUCHED);
    const h = await mountRows();
    (daysOf(h).props.onChange as (e: { target: { value: string } }) => void)({ target: { value: '400' } });
    expect(daysOf(h).props.value).toBe('400');

    (daysOf(h).props.onBlur as (e: { target: { value: string } }) => void)({ target: { value: '400' } });
    await settle();
    expect(puts).toEqual([{ browserStoreReapAfterDays: 365 }]);
    expect(daysOf(h).props.value).toBe('365');
  });

  test('a save that failed is said on screen, and the switch stays where the disk is', async () => {
    fakeServer({ browserStoreCacheReapEnabled: false, browserStoreReapEnabled: false, browserStoreReapAfterDays: 30 });
    const h = await mountRows();
    expect(h.last().text).not.toContain(saveFailedLine());

    putFails = true;
    press(h);
    await settle();
    expect(puts).toEqual([{ browserStoreCacheReapEnabled: true }]);
    expect(hostOf(h, (n) => n.props.role === 'alert')).toBeDefined();
    expect(h.last().text).toContain(saveFailedLine());
    expect(switchOf(h).props['aria-checked']).toBe(false);

    // The next save that works takes the line away.
    putFails = false;
    press(h);
    await settle();
    expect(h.last().text).not.toContain(saveFailedLine());
    expect(switchOf(h).props['aria-checked']).toBe(true);
  });
});
