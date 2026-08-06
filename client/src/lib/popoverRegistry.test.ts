import { describe, expect, it } from 'bun:test';
import { popoversToClose } from './popoverRegistry';

/**
 * La regola «uno alla volta» si testa senza DOM: `contains` è iniettato, quindi
 * l'annidamento si descrive come una relazione fra etichette invece che come un
 * albero vero. Quello che va pinnato è la DECISIONE, non il modo di leggerla.
 */

type Node_ = string;

/** `parent > child` descritto a mano: "panel-A" contiene "row-in-A". */
const CONTAINS: Record<string, string[]> = {
  'panel-A': ['row-in-A'],
  'panel-B': ['row-in-B'],
};

const contains = (parent: unknown, child: unknown) =>
  (CONTAINS[parent as string] ?? []).includes(child as string);

function entry(label: string, ...nodes: Node_[]) {
  return { label, nodes: () => nodes as unknown as Array<Node | null> };
}

function opener(trigger: Node_ | null, exclusive = true) {
  return { trigger: () => trigger as unknown as Node | null, exclusive };
}

describe('popoversToClose', () => {
  it('chiude un fratello: il trigger del nuovo non vive dentro il vecchio', () => {
    const openEntries = [entry('A', 'trigger-A', 'panel-A')];
    const victims = popoversToClose(openEntries, opener('trigger-B'), contains as never);
    expect(victims.map((v) => v.label)).toEqual(['A']);
  });

  it('NON chiude il genitore: il trigger del nuovo è una riga dentro il suo pannello', () => {
    const openEntries = [entry('A', 'trigger-A', 'panel-A')];
    const victims = popoversToClose(openEntries, opener('row-in-A'), contains as never);
    expect(victims).toEqual([]);
  });

  it('chiude tutti i fratelli e risparmia solo il genitore', () => {
    const openEntries = [
      entry('A', 'trigger-A', 'panel-A'),
      entry('B', 'trigger-B', 'panel-B'),
    ];
    const victims = popoversToClose(openEntries, opener('row-in-B'), contains as never);
    expect(victims.map((v) => v.label)).toEqual(['A']);
  });

  it('senza trigger noto chiude tutto: chi non ha un ancoraggio non può essere figlio di nessuno', () => {
    // È il caso di ⌘N prima che il bottone della palette sia montato, e di ogni
    // menu contestuale posizionato sul cursore (refs[0] = il pannello stesso).
    const openEntries = [entry('A', 'trigger-A', 'panel-A'), entry('B', 'trigger-B', 'panel-B')];
    const victims = popoversToClose(openEntries, opener(null), contains as never);
    expect(victims.map((v) => v.label)).toEqual(['A', 'B']);
  });

  it('exclusive:false non caccia nessuno', () => {
    const openEntries = [entry('A', 'trigger-A', 'panel-A')];
    const victims = popoversToClose(openEntries, opener('trigger-B', false), contains as never);
    expect(victims).toEqual([]);
  });

  it('un ref non montato (null) non conta come contenitore', () => {
    // Il pannello si monta DOPO l'apertura: durante quel frame `nodes()`
    // contiene dei null, e un null non deve far passare nessuno per figlio.
    const openEntries = [entry('A', 'trigger-A')];
    openEntries[0].nodes = () => [null, null];
    const victims = popoversToClose(openEntries, opener('trigger-B'), contains as never);
    expect(victims.map((v) => v.label)).toEqual(['A']);
  });
});
