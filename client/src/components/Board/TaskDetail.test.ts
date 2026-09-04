/**
 * THE DRAWER DOES NOT READ THE HISTORY TO FOLLOW A TURN, AND IT DOES NOT READ
 * IT AT ALL WHEN NOBODY IS LOOKING.
 *
 * `TaskDetail` used to ask for 200 rows of history every 3 seconds while an
 * agent worked. The tick is gone: the session arrives from the same store the
 * chat reduces every frame into (`state/messageStore.ts`), and the drawer
 * DECLARES its topic on the wire (`state/topicSubscriptions.ts`) because a
 * drawer is not a pane and per-token deltas are routed on the declared set.
 * Three reads survive, and only three: mount, waking up, and the `stream:end`
 * of its own session — the persisted blocks and tool rows exist nowhere else.
 *
 * Both the hold and the subscription are gated on the pane having a box in the
 * layout, and the two gates that were needed for the poll are still needed
 * here, for the same reasons:
 *
 *  · `PaneKeepAlive` freezes the RENDERS of a hidden pane, not the effects of a
 *    a subtree that is already mounted: a drawer parked behind another pane
 *    would keep holding a topic open on the wire. That is `paneLiveness.ts`;
 *  · the window in the background is the wake-up listener's business, and there
 *    is exactly ONE of it in this file, shared with the task refresh, so the
 *    two land together.
 *
 * The reading is checked on the SOURCE, same method and same reason as
 * `Card.test.ts`: `TaskDetail.tsx` imports `@/lib/popoverStyles` and `bun test`
 * does not resolve the `@/` alias, so the drawer does not mount here. What
 * happens on the wire during a live turn is E2E's job (DRAWER-05a).
 * @covers KANBAN-52
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'TaskDetail.tsx'), 'utf8');

/** The body of the effect that listens to the live wire. */
const wireEffect = (() => {
  const i = src.indexOf("m.type === 'stream:end'");
  return src.slice(src.lastIndexOf('useEffect(', i), src.indexOf('\n', i));
})();

describe('la lettura della cronologia', () => {
  test('non c\'è più un poll: nessun tick, nessuna lettura per seguire il turno', () => {
    expect(src.includes('}, 3000);')).toBe(false);
    // Not even the URL: the three surviving reads go through `loadHistory`,
    // which is the chat's own reader (dedup + in-flight collapse).
    expect(src.includes('/api/history')).toBe(false);
    expect(src).toContain('loadHistory(sessionKey)');
  });

  test('recupera alla fine del turno, e solo per la PROPRIA sessione', () => {
    // A `stream:end` of another topic must not make this drawer read anything:
    // on a busy board that is one history fetch per card open, per turn ended.
    expect(wireEffect).toContain("m.type === 'stream:end'");
    expect(wireEffect).toContain('m.sessionKey === sessionKey');
  });

  test('al ritorno in vista recupera, sullo STESSO ascoltatore del drawer', () => {
    // Without the catch-up the drawer would sit on whatever the socket managed
    // to deliver before the tab slept; with a second listener the two refreshes
    // would land apart, and a task row from now next to an old session tail
    // reads as an agent that stopped talking.
    expect(src).toContain('sessionCatchUp.current?.()');
    expect(src.match(/addEventListener\('visibilitychange'/g) ?? []).toHaveLength(1);
  });
});

describe('la vivezza della pane', () => {
  test('la sottoscrizione allo store è gated: niente box nel layout, niente ascolto', () => {
    expect(src).toContain('usePaneAlive()');
    expect(src).toContain('paneAlive && sessionKey ? subscribeSession(sessionKey, cb)');
  });

  test('il drawer DICHIARA il topic della sessione, e solo mentre è vivo', () => {
    expect(src).toContain('holdTopic(');
    expect(src).toContain('paneAlive && assignedTopicId ? holdTopic(assignedTopicId) : undefined');
  });

  test('anche la lettura di recupero passa dal cancello', () => {
    const refresh = src.slice(src.indexOf('const refreshSession'));
    expect(refresh.slice(0, refresh.indexOf('}, ['))).toContain('!paneAlive');
  });
});

describe('il taglio della sessione fra i commenti', () => {
  test('è UNA passata, non un filtro per riga', () => {
    expect(src).toContain('bucketSessionMsgs(');
    // `sliceBetween` was the per-row filter: 200 messages for every comment,
    // on every update.
    expect(src.includes('sliceBetween')).toBe(false);
  });

  test('porta dentro il risultato di prima, o niente resta stabile', () => {
    expect(src).toContain('bucketsRef.current');
  });
});
