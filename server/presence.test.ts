/**
 * Tests for the pure cross-window presence snapshot builder. The contract:
 *   - sockets that haven't announced (no windowId) are skipped;
 *   - duplicate windowIds (reconnect race) collapse to the first;
 *   - each entry carries clientId + label + detached + topics + focus;
 *   - dropping a socket from the input drops it from the snapshot (self-heal).
  * @covers PRESENCE-12
 */
import { describe, test, expect } from 'bun:test';
import { buildPresenceSnapshot, type PresenceSource } from './presence';

const src = (over: Partial<PresenceSource> & { id: string }): PresenceSource => ({ ...over });

describe('buildPresenceSnapshot', () => {
  test('skips sockets that never announced a windowId', () => {
    const out = buildPresenceSnapshot([
      src({ id: 'sock-1' }),
      src({ id: 'sock-2', windowId: 'w2', presenceTopicIds: ['a'] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].windowId).toBe('w2');
    expect(out[0].clientId).toBe('sock-2');
    expect(out[0].topicIds).toEqual(['a']);
  });

  test('carries label, detached flag, and focused topic', () => {
    const out = buildPresenceSnapshot([
      src({
        id: 'sock-1',
        windowId: 'w1',
        windowLabel: 'detach-abc',
        detached: true,
        presenceTopicIds: ['t1', 't2'],
        presenceFocusedTopicId: 't2',
      }),
    ]);
    expect(out[0]).toEqual({
      windowId: 'w1',
      clientId: 'sock-1',
      windowLabel: 'detach-abc',
      detached: true,
      topicIds: ['t1', 't2'],
      focusedTopicId: 't2',
    });
  });

  test('collapses duplicate windowIds to the first (reconnect race)', () => {
    const out = buildPresenceSnapshot([
      src({ id: 'old', windowId: 'w1', presenceTopicIds: ['stale'] }),
      src({ id: 'new', windowId: 'w1', presenceTopicIds: ['fresh'] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].clientId).toBe('old');
  });

  test('empty topicIds default when none announced', () => {
    const out = buildPresenceSnapshot([src({ id: 's', windowId: 'w' })]);
    expect(out[0].topicIds).toEqual([]);
  });

  test('self-heals: a socket removed from input is absent from the snapshot', () => {
    const alive = [
      src({ id: 's1', windowId: 'w1' }),
      src({ id: 's2', windowId: 'w2' }),
    ];
    expect(buildPresenceSnapshot(alive).map((w) => w.windowId)).toEqual(['w1', 'w2']);
    // w2's socket died → next build omits it, no stale row.
    expect(buildPresenceSnapshot(alive.slice(0, 1)).map((w) => w.windowId)).toEqual(['w1']);
  });
});

// ── Le "4 finestre principali" quando ce n'è una ───────────────────────────
//
// Rilevato dal vivo il 03/08 con una sonda WS: quattro `windowId` distinti,
// tutti `windowLabel: "main"`, tutti sullo stesso `__board__`, con UNA sola
// finestra Tauri aperta. Due difetti indipendenti, tutti e due qui sotto.
describe("buildPresenceSnapshot — finestre fantasma", () => {
  const src = (over: Partial<PresenceSource> & { id: string }): PresenceSource => ({ ...over });

  test("un socket NON vivo non è una finestra", () => {
    const out = buildPresenceSnapshot([
      src({ id: "s1", windowId: "w1", alive: true }),
      src({ id: "s2", windowId: "w2", alive: false }),
    ]);
    expect(out.map((w) => w.windowId)).toEqual(["w1"]);
  });

  test("`alive` non dichiarato conta come vivo (chiamante non aggiornato)", () => {
    const out = buildPresenceSnapshot([src({ id: "s1", windowId: "w1" })]);
    expect(out).toHaveLength(1);
  });

  test("quattro socket vivi con lo stesso windowLabel = UNA finestra", () => {
    // Esattamente lo snapshot misurato: quattro contesti della stessa finestra.
    const out = buildPresenceSnapshot([
      src({ id: "s1", windowId: "2e2ca692", windowLabel: "main", alive: true }),
      src({ id: "s2", windowId: "ce71a49e", windowLabel: "main", alive: true }),
      src({ id: "s3", windowId: "ce27e1c7", windowLabel: "main", alive: true }),
      src({ id: "s4", windowId: "731151b5", windowLabel: "main", alive: true }),
    ]);
    expect(out).toHaveLength(1);
  });

  test("fra gli omonimi vince l'ULTIMO: un reload sostituisce sé stesso", () => {
    const out = buildPresenceSnapshot([
      src({ id: "vecchio", windowId: "w-vecchio", windowLabel: "main", alive: true }),
      src({ id: "nuovo", windowId: "w-nuovo", windowLabel: "main", alive: true }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.windowId).toBe("w-nuovo");
  });

  test("il WEB non si collassa: senza label, più tab sono più finestre davvero", () => {
    // È il bug opposto, e sarebbe peggio: collassare qui nasconderebbe finestre
    // che esistono.
    const out = buildPresenceSnapshot([
      src({ id: "t1", windowId: "w1", alive: true }),
      src({ id: "t2", windowId: "w2", alive: true }),
    ]);
    expect(out.map((w) => w.windowId)).toEqual(["w1", "w2"]);
  });

  test("label DIVERSI restano finestre diverse (una staccata è una finestra vera)", () => {
    const out = buildPresenceSnapshot([
      src({ id: "s1", windowId: "w1", windowLabel: "main", alive: true }),
      src({ id: "s2", windowId: "w2", windowLabel: "detached-1", detached: true, alive: true }),
    ]);
    expect(out.map((w) => w.windowLabel)).toEqual(["main", "detached-1"]);
  });

  test("il collasso per label tiene i dati dell'ultimo, non del primo", () => {
    const out = buildPresenceSnapshot([
      src({ id: "s1", windowId: "w1", windowLabel: "main", presenceTopicIds: ["vecchio"], alive: true }),
      src({ id: "s2", windowId: "w2", windowLabel: "main", presenceTopicIds: ["nuovo"], alive: true }),
    ]);
    expect(out[0]!.topicIds).toEqual(["nuovo"]);
  });

  test("un socket morto non tiene in vita il label di uno vivo", () => {
    const out = buildPresenceSnapshot([
      src({ id: "morto", windowId: "w-morto", windowLabel: "main", alive: false }),
      src({ id: "vivo", windowId: "w-vivo", windowLabel: "main", alive: true }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.windowId).toBe("w-vivo");
  });
});

describe('presence tabs — the window carries what it holds', () => {
  test('tabs ride through the snapshot untouched', () => {
    const tabs = [
      { id: 't-auth', type: 'chat', title: 'auth flow' },
      { id: 'terminal:cc1', type: 'terminal', title: 'Claude Code' },
      { id: 'project:%2Fsrv', type: 'project', title: 'acme-api' },
    ];
    const [w] = buildPresenceSnapshot([
      { id: 'c1', windowId: 'w1', presenceTopicIds: ['t-auth'], presenceTabs: tabs },
    ]);
    expect(w.tabs).toEqual(tabs);
    // topicIds stays the CHAT-only set: it drives per-topic delta routing and
    // the "open in another window" markers, which are about topics specifically.
    expect(w.topicIds).toEqual(['t-auth']);
  });

  test('a socket that announces no tabs reports undefined, not an empty list', () => {
    // The difference matters downstream: `windowTabs()` falls back to topicIds
    // for undefined, and an empty array would read as "this window is empty".
    const [w] = buildPresenceSnapshot([
      { id: 'c1', windowId: 'w1', presenceTopicIds: ['t-ship'] },
    ]);
    expect(w.tabs).toBeUndefined();
  });

  test('the label collapse keeps the surviving socket\'s tabs', () => {
    // Same OS window, two sockets (a reload before the old one dropped): the
    // LAST announce wins, so its tab list must win with it.
    const wins = buildPresenceSnapshot([
      { id: 'c1', windowId: 'w1', windowLabel: 'main', presenceTabs: [{ id: 'a', type: 'chat' }] },
      { id: 'c2', windowId: 'w2', windowLabel: 'main', presenceTabs: [{ id: 'b', type: 'terminal' }] },
    ]);
    expect(wins).toHaveLength(1);
    expect(wins[0].tabs).toEqual([{ id: 'b', type: 'terminal' }]);
  });
});
