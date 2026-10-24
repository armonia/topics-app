/**
 * THE SWITCH SAYS WHAT THE REAPER WILL DO, AND SAVES WHAT WAS PRESSED.
 *
 * The cleanup of closed browsers' data removes stores for good, so the row that
 * controls it has one job: show the state the reaper is going to read, and save
 * exactly the field that was touched. A switch drawn inverted (OFF on screen,
 * ON on disk) is the worst defect it can have, because the person who switched
 * it off to keep their logins sees it off and stops looking.
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

type Stored = Pick<AppBehaviorSettings, 'browserStoreReapEnabled' | 'browserStoreReapAfterDays'>;
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

interface Drawn {
  saves: Patch[];
  typed: Array<string | null>;
  switchRow: ReactElement<{ checked: boolean; onChange: (v: boolean) => void }>;
  input: ReactElement<{
    value: string;
    disabled: boolean;
    onBlur: (e: { target: { value: string } }) => void;
    onChange: (e: { target: { value: string } }) => void;
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
  const switchRow = all.find((e) => e.type === SwitchRow) as Drawn['switchRow'] | undefined;
  const input = all.find((e) => e.type === 'input') as Drawn['input'] | undefined;
  if (!switchRow || !input) throw new Error('the switch or the days field is missing');
  return { saves, typed: typedLog, switchRow, input, html: renderToStaticMarkup(<BrowserStoreReapControls {...props} />) };
}

const NEVER_TOUCHED: Stored = { browserStoreReapEnabled: null, browserStoreReapAfterDays: null };
const OFF: Stored = { browserStoreReapEnabled: false, browserStoreReapAfterDays: 90 };

describe('the switch shows the state the reaper reads', () => {
  test('never touched: on, 60 days, and the field can be changed', () => {
    const d = draw(NEVER_TOUCHED);
    expect(d.switchRow.props.checked).toBe(true);
    expect(d.input.props.value).toBe('60');
    expect(d.input.props.disabled).toBe(false);
    expect(d.html).toContain('aria-checked="true"');
  });

  test('switched off: the switch is off and the days field is disabled', () => {
    const d = draw(OFF);
    expect(d.switchRow.props.checked).toBe(false);
    expect(d.input.props.value).toBe('90');
    expect(d.input.props.disabled).toBe(true);
    expect(d.html).toContain('aria-checked="false"');
    expect(d.html).toMatch(/<input[^>]*disabled=""/);
  });

  test('the copy decided for it is the copy on screen', () => {
    const d = draw(NEVER_TOUCHED);
    expect(d.html).toContain('Pulisci i dati dei browser chiusi');
    expect(d.html).toContain('Cancella per sempre cookie e dati dei browser che non apri più');
    expect(d.html).toContain('dopo');
    expect(d.html).toContain('giorni senza uso');
  });
});

describe('pressing the switch saves the switch, and only the switch', () => {
  test('on → off saves browserStoreReapEnabled: false', () => {
    const d = draw(NEVER_TOUCHED);
    d.switchRow.props.onChange(false);
    expect(d.saves).toEqual([{ browserStoreReapEnabled: false }]);
  });

  test('off → on saves browserStoreReapEnabled: true', () => {
    const d = draw(OFF);
    d.switchRow.props.onChange(true);
    expect(d.saves).toEqual([{ browserStoreReapEnabled: true }]);
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
    for (const typed of ['60', '', '  ', 'tanti']) {
      const d = draw(NEVER_TOUCHED);
      d.input.props.onBlur({ target: { value: typed } });
      expect(d.saves).toEqual([]);
    }
  });

  test('typing is held as typed until it is committed, then let go', () => {
    const draft = draw(NEVER_TOUCHED, '12');
    expect(draft.input.props.value).toBe('12');
    draft.input.props.onChange({ target: { value: '120' } });
    draft.input.props.onBlur({ target: { value: '120' } });
    expect(draft.typed).toEqual(['120', null]);
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
   *  or throws the way `request()` does on a non-2xx answer. */
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
  const switchOf = (h: Harness) => hostOf(h, (n) => n.props.role === 'switch');
  const daysOf = (h: Harness) => hostOf(h, (n) => n.type === 'input');
  const press = (h: Harness) => (switchOf(h).props.onClick as () => void)();
  const saveFailedLine = () => tr('browser.storeReap.saveFailed');

  afterEach(() => {
    harness?.unmount();
    harness = null;
    appSettingsApi.get = realGet;
    appSettingsApi.update = realUpdate;
  });

  test('off, then on again: each PUT answer is what the switch shows', async () => {
    fakeServer(NEVER_TOUCHED);
    const h = await mountRows();
    expect(switchOf(h).props['aria-checked']).toBe(true);

    press(h);
    await settle();
    expect(puts).toEqual([{ browserStoreReapEnabled: false }]);
    expect(switchOf(h).props['aria-checked']).toBe(false);
    expect(daysOf(h).props.disabled).toBe(true);

    // The way back: a switch that cannot be turned on again no longer governs
    // the reaper, whatever it shows.
    press(h);
    await settle();
    expect(puts).toEqual([{ browserStoreReapEnabled: false }, { browserStoreReapEnabled: true }]);
    expect(switchOf(h).props['aria-checked']).toBe(true);
    expect(daysOf(h).props.disabled).toBe(false);
    expect(h.last().text).not.toContain(saveFailedLine());
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
    fakeServer({ browserStoreReapEnabled: false, browserStoreReapAfterDays: 30 });
    const h = await mountRows();
    expect(h.last().text).not.toContain(saveFailedLine());

    putFails = true;
    press(h);
    await settle();
    expect(puts).toEqual([{ browserStoreReapEnabled: true }]);
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
