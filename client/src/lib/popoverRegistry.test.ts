/**
 * @covers POPOVER-01
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  closeAllPopovers,
  descendantPopoverNodes,
  openPopoverCount,
  popoversToClose,
  registerOpenPopover,
  subSurfaceNodes,
  type PopoverEntry,
} from './popoverRegistry';

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

/**
 * L'altra metà del modulo: la CONTABILITÀ del registro — chi ci sta dentro
 * adesso, chi ne esce, e con quale ordine. `popoversToClose` decide, ma è
 * `registerOpenPopover` a tenere il `Set` allineato alla decisione, e su quello
 * non c'era nessun test: la regola era pinnata, il libro mastro no. È il buco
 * che `openPopoverCount` esisteva per misurare — dichiarato «solo per
 * test/diagnostica» e mai chiamato da nessun test.
 *
 * Niente DOM, come sopra: le voci non dichiarano nodi, quindi il `contains` del
 * modulo (che è `Node.contains`) non viene mai invocato. L'annidamento vero è
 * già coperto dai test puri.
 */
describe('il registro degli aperti', () => {
  // Il `Set` è di modulo e sopravvive al singolo test: si riparte da vuoto.
  beforeEach(() => closeAllPopovers());

  type Fake = PopoverEntry & { closed: number };

  function popover(overrides: Partial<PopoverEntry> = {}): Fake {
    const e: Fake = {
      closed: 0,
      close: () => { e.closed += 1; },
      trigger: () => null,
      nodes: () => [],
      exclusive: true,
      ...overrides,
    };
    return e;
  }

  it('registrare conta, e la funzione ritornata deregistra', () => {
    expect(openPopoverCount()).toBe(0);
    const unregister = registerOpenPopover(popover());
    expect(openPopoverCount()).toBe(1);
    unregister();
    expect(openPopoverCount()).toBe(0);
  });

  it('un secondo popover esclusivo prende il posto del primo: resta UNO', () => {
    const first = popover();
    registerOpenPopover(first);
    registerOpenPopover(popover());
    expect(openPopoverCount()).toBe(1);
    expect(first.closed).toBe(1);
  });

  it('lo sfrattato esce dal registro PRIMA di essere chiuso', () => {
    // Il conto va letto DENTRO `close()`: se lo sfratto avvenisse dopo, il
    // cleanup dell'altro hook girerebbe con una voce fantasma ancora dentro.
    let countDuringClose = -1;
    const first = popover();
    first.close = () => { countDuringClose = openPopoverCount(); };
    registerOpenPopover(first);
    registerOpenPopover(popover());
    expect(countDuringClose).toBe(0);
  });

  it('deregistrare uno già sfrattato non scala il conto di chi lo ha sostituito', () => {
    // È il caso reale: `close()` fa scattare la pulizia dell'hook, che chiama
    // la SUA deregistrazione su una voce già tolta. Togliersi due volte da un
    // Set è innocuo, ed è questo a renderlo innocuo.
    const unregisterFirst = registerOpenPopover(popover());
    registerOpenPopover(popover());
    unregisterFirst();
    expect(openPopoverCount()).toBe(1);
  });

  it('una sotto-superficie (exclusive:false) non caccia nessuno e resta accanto', () => {
    registerOpenPopover(popover());
    registerOpenPopover(popover({ exclusive: false }));
    expect(openPopoverCount()).toBe(2);
  });

  it('subSurfaceNodes espone SOLO i nodi delle sotto-superfici', () => {
    const panel = 'panel-sub' as unknown as Node;
    registerOpenPopover(popover({ nodes: () => ['panel-excl' as unknown as Node] }));
    registerOpenPopover(popover({ exclusive: false, nodes: () => [panel] }));
    expect(subSurfaceNodes()).toEqual([panel]);
  });

  it('descendantPopoverNodes: un popover il cui trigger sta dentro il pannello dato è un FIGLIO', () => {
    // A `Select` inside the settings dropdown: its trigger lives in the
    // dropdown's panel, its own panel does not (portal). For the parent it has
    // to count as "inside", even though the child is `exclusive` (on purpose:
    // it evicts its siblings).
    const parentPanel = { contains: (n: unknown) => n === childTrigger } as unknown as Node;
    const childTrigger = { contains: () => false } as unknown as Node;
    const childPanel = { contains: () => false } as unknown as Node;
    const parent = popover({ nodes: () => [parentPanel] });
    registerOpenPopover(parent);
    registerOpenPopover(popover({ trigger: () => childTrigger, nodes: () => [childTrigger, childPanel] }));
    expect(descendantPopoverNodes(parent)).toEqual([childTrigger, childPanel]);
    // And the parent stays open: the registry knew that already.
    expect(openPopoverCount()).toBe(2);
  });

  it('descendantPopoverNodes: un fratello, o se stesso, non è un figlio', () => {
    // A popover's refs may include a container of its OWN trigger
    // (`extraRefs`): by geometry it would count as its own child, and a popover
    // that is its own child never closes on Escape again. The comparison is by
    // entry identity, not by containment.
    const myTrigger = { contains: () => false } as unknown as Node;
    const myWrapper = { contains: (n: unknown) => n === myTrigger } as unknown as Node;
    const strangerTrigger = { contains: () => false } as unknown as Node;
    const me = popover({ trigger: () => myTrigger, nodes: () => [myTrigger, myWrapper] });
    registerOpenPopover(me);
    registerOpenPopover(popover({ exclusive: false, trigger: () => strangerTrigger, nodes: () => [strangerTrigger] }));
    expect(descendantPopoverNodes(me)).toEqual([]);
  });

  it('closeAllPopovers svuota il registro e chiude tutti, sotto-superfici comprese', () => {
    const a = popover();
    const b = popover({ exclusive: false });
    registerOpenPopover(a);
    registerOpenPopover(b);
    closeAllPopovers();
    expect(openPopoverCount()).toBe(0);
    expect(a.closed).toBe(1);
    expect(b.closed).toBe(1);
  });
});
