/**
 * THE CHIP HAS THREE SLOTS AND FIVE CANDIDATES, so the interesting cases are
 * the ones where something has to be LEFT OUT.
 *
 *  1. A zero never takes a slot: it is the widest way of saying nothing.
 *  2. What is dropped is the least urgent, not the last one written.
 *  3. What is dropped is never the open-session count while something quieter
 *     stays: "how much is going on in here" is the question the chip exists to
 *     answer.
 */
import { describe, it, expect } from 'bun:test';
import { segnaliLavoro, type ContiLavoro } from './workSignals';

const zero: ContiLavoro = {
  openSessions: 0,
  workingSessions: 0,
  activeTasks: 0,
  awaitingInput: 0,
  awaitingDone: 0,
};

describe('segnaliLavoro', () => {
  it('a macchina ferma non disegna niente', () => {
    expect(segnaliLavoro(zero)).toEqual([]);
  });

  it('salta gli zeri e tiene solo cio\' che esiste', () => {
    const s = segnaliLavoro({ ...zero, openSessions: 12 });
    expect(s).toEqual([{ tipo: 'open', n: 12 }]);
  });

  it('mette prima cio\' che e\' vivo e per ultimo l\'inventario', () => {
    const s = segnaliLavoro({ ...zero, openSessions: 12, workingSessions: 3 });
    expect(s.map((x) => x.tipo)).toEqual(['working', 'open']);
  });

  it('con cinque candidati ne tiene tre, e il primo a cadere e\' il meno urgente', () => {
    const s = segnaliLavoro({
      openSessions: 12,
      workingSessions: 3,
      activeTasks: 2,
      awaitingInput: 1,
      awaitingDone: 4,
    });
    expect(s.map((x) => x.tipo)).toEqual(['working', 'awaitingInput', 'done']);
    // The board tasks fall, and so does the open count: the three that stay are
    // the ones that mean somebody is waiting for you.
    expect(s.map((x) => x.n)).toEqual([3, 1, 4]);
  });

  it('il numero di sessioni resta anche quando i task cadono', () => {
    const s = segnaliLavoro({ ...zero, openSessions: 12, workingSessions: 3, activeTasks: 2 });
    expect(s.map((x) => x.tipo)).toEqual(['working', 'tasks', 'open']);
    const stretto = segnaliLavoro({ ...zero, openSessions: 12, workingSessions: 3, activeTasks: 2 }, 2);
    expect(stretto.map((x) => x.tipo)).toEqual(['working', 'open']);
  });
});
