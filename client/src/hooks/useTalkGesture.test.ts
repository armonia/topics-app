import { describe, it, expect } from 'bun:test';
import { talkGestureReducer, HOLD_TO_TALK_MS, type TalkEvent, type TalkPhase, type TalkAction } from './useTalkGesture';

/**
 * Il gesto guidato evento per evento, come lo vive un dito.
 *
 * Quello che si rompe in silenzio non è il singolo passaggio, è la SEQUENZA:
 * un rilascio che arriva quando non deve riapre un microfono appena chiuso, e
 * la dettatura seguente parte da sola senza che nessuno l'abbia chiesta.
 */
function run(events: TalkEvent[]): { actions: TalkAction[]; phase: TalkPhase } {
  let phase: TalkPhase = 'idle';
  let pressedAt: number | null = null;
  const actions: TalkAction[] = [];
  for (const e of events) {
    const next = talkGestureReducer(phase, pressedAt, e);
    phase = next.phase;
    pressedAt = next.pressedAt;
    if (next.action) actions.push(next.action);
  }
  return { actions, phase };
}

describe('talkGestureReducer', () => {
  it('tenuto premuto: parte alla pressione e si ferma al rilascio', () => {
    const { actions, phase } = run([
      { type: 'down', at: 1000 },
      { type: 'up', at: 1000 + HOLD_TO_TALK_MS },
    ]);
    expect(actions).toEqual(['start', 'stop']);
    expect(phase).toBe('idle');
  });

  it('tap: parte alla pressione e RESTA acceso dopo il rilascio', () => {
    const { actions, phase } = run([
      { type: 'down', at: 1000 },
      { type: 'up', at: 1100 },
    ]);
    expect(actions).toEqual(['start']);
    expect(phase).toBe('latched');
  });

  it('il secondo tap chiude, e il suo rilascio non riapre niente', () => {
    const { actions, phase } = run([
      { type: 'down', at: 1000 }, { type: 'up', at: 1100 },
      { type: 'down', at: 5000 }, { type: 'up', at: 5090 },
    ]);
    expect(actions).toEqual(['start', 'stop']);
    expect(phase).toBe('idle');
  });

  it('la registrazione parte SEMPRE alla pressione, anche se il gesto sara\' breve', () => {
    const first = talkGestureReducer('idle', null, { type: 'down', at: 1 });
    expect(first.action).toBe('start');
  });

  it('il dito che se ne va (pointercancel) chiude, non lascia il microfono aperto', () => {
    expect(run([{ type: 'down', at: 1000 }, { type: 'cancel' }])).toEqual({ actions: ['start', 'stop'], phase: 'idle' });
    expect(run([{ type: 'down', at: 1000 }, { type: 'up', at: 1050 }, { type: 'cancel' }]))
      .toEqual({ actions: ['start', 'stop'], phase: 'idle' });
  });

  it('un rilascio a freddo non accende niente', () => {
    expect(run([{ type: 'up', at: 1000 }])).toEqual({ actions: [], phase: 'idle' });
  });

  it('la soglia e\' inclusiva: esattamente al limite conta come tenuto', () => {
    expect(run([{ type: 'down', at: 0 }, { type: 'up', at: HOLD_TO_TALK_MS }]).actions).toEqual(['start', 'stop']);
    expect(run([{ type: 'down', at: 0 }, { type: 'up', at: HOLD_TO_TALK_MS - 1 }]).actions).toEqual(['start']);
  });

  it('due dita sullo stesso tasto non fanno partire due dettature', () => {
    const { actions } = run([
      { type: 'down', at: 1000 },
      { type: 'down', at: 1010 },
      { type: 'up', at: 1500 },
    ]);
    expect(actions).toEqual(['start', 'stop']);
  });
});
