/**
 * AICTRL-05, requisito #6: lo switch di composer e cassetto mostra lo stato EFFETTIVO (scelta locale > default board > prefisso legacy `topics:<model>`), non un `!!` che legge spenta una board mai toccata. allow-italian: la cascata che il file prova
 * La cascata e' una funzione sola condivisa dalle due superfici, eseguita qui caso per caso. allow-italian: perche' la prova sta sulla funzione
 * Il composer importa `@/lib/popoverStyles` e `bun test` non risolve l'alias `@/`: non monta, quindi il filo verso la funzione resta una lettura di sorgente, secondaria. allow-italian: perche' il filo non e' eseguito
 * @covers AICTRL-05
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { surfaceTopicsRoutingEnabled } from '../../lib/topicsRoutingGate';

describe('lo switch della superficie legge lo stato effettivo, non solo il locale', () => {
  test('la scelta locale vince su tutto, accesa o spenta che sia', () => {
    expect(surfaceTopicsRoutingEnabled(false, true, null, 'topics:claude-opus-5')).toBe(false);
    expect(surfaceTopicsRoutingEnabled(true, false, 'claude-opus-5', null)).toBe(true);
  });

  test('senza scelta locale decide il default della board', () => {
    expect(surfaceTopicsRoutingEnabled(null, true, null, null)).toBe(true);
    expect(surfaceTopicsRoutingEnabled(undefined, false, 'topics:claude-opus-5', null)).toBe(false);
  });

  test('board mai toccata: il prefisso legacy del suo modello accende lo switch', () => {
    // Il caso che il vecchio `!!` sbagliava: nessuna scelta da nessuna parte, e il modello della board porta ancora `topics:`. allow-italian: nomina il caso sbagliato prima
    expect(surfaceTopicsRoutingEnabled(null, null, null, 'topics:claude-opus-5')).toBe(true);
    expect(surfaceTopicsRoutingEnabled(null, null, null, 'claude-opus-5')).toBe(false);
  });

  test('il modello scelto QUI copre quello della board', () => {
    expect(surfaceTopicsRoutingEnabled(null, null, 'claude-opus-5', 'topics:claude-opus-5')).toBe(false);
    expect(surfaceTopicsRoutingEnabled(null, null, 'topics:claude-opus-5', 'claude-opus-5')).toBe(true);
  });

  test("`auto` non e' un modello: non porta nessun prefisso legacy", () => {
    expect(surfaceTopicsRoutingEnabled(null, null, null, 'auto')).toBe(false);
  });

  test('board globale (nessun default, nessun modello): resta spento', () => {
    expect(surfaceTopicsRoutingEnabled(null, null, null, null)).toBe(false);
  });
});

describe('il filo fra le due superfici e la cascata', () => {
  // Secondario: dice solo che nessuna delle due superfici e' tornata a ricalcolarsi la cascata per conto proprio. allow-italian: dice il confine di questa prova
  const here = dirname(fileURLToPath(import.meta.url));
  const composer = readFileSync(join(here, 'FloatingTaskComposer.tsx'), 'utf8');
  const drawer = readFileSync(join(here, 'TaskDetail.tsx'), 'utf8');

  test('il composer chiama la funzione condivisa con i suoi quattro operandi', () => {
    expect(composer).toContain("import { surfaceTopicsRoutingEnabled } from '../../lib/topicsRoutingGate';");
    expect(composer).toContain('surfaceTopicsRoutingEnabled(topicsRouting, boardTopicsRoutingDefault, model, boardDispatchModel)');
    expect(composer).toContain('boardTopicsRoutingDefault = null');
    expect(composer).toContain('boardDispatchModel = null');
  });

  test('il cassetto chiama la stessa, con il task al posto del locale', () => {
    expect(drawer).toContain('surfaceTopicsRoutingEnabled(task.topicsRouting, boardTopicsRoutingDefault, task.model, boardDispatchModel)');
    expect(drawer.includes('enabled: !!task.topicsRouting')).toBe(false);
  });
});
