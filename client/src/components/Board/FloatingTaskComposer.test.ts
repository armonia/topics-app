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

const surface = (topicsRouting: boolean | null | undefined, boardDefault: boolean | null | undefined, model: string | null | undefined, boardModel: string | null | undefined) =>
  surfaceTopicsRoutingEnabled({ topicsRouting, model }, boardDefault, boardModel);

describe('lo switch della superficie legge lo stato effettivo, non solo il locale', () => {
  test('la scelta locale vince su tutto, accesa o spenta che sia', () => {
    expect(surface(false, true, null, 'topics:claude-opus-5')).toBe(false);
    expect(surface(true, false, 'claude-opus-5', null)).toBe(true);
  });

  test('senza scelta locale decide il default della board', () => {
    expect(surface(null, true, null, null)).toBe(true);
    expect(surface(undefined, false, 'topics:claude-opus-5', null)).toBe(false);
  });

  test('board mai toccata: lo switch è acceso di default, col prefisso legacy o senza', () => {
    // Il caso che il vecchio `!!` sbagliava: nessuna scelta da nessuna parte, e il modello della board porta ancora `topics:`. allow-italian: nomina il caso sbagliato prima
    expect(surface(null, null, null, 'topics:claude-opus-5')).toBe(true);
    expect(surface(null, null, null, 'claude-opus-5')).toBe(true);
  });

  /** @covers MSEL-06 */
  test('il modello scelto QUI copre quello della board', () => {
    expect(surface(null, null, 'claude-opus-5', 'claude-code:claude-opus-5')).toBe(true);
    expect(surface(null, null, 'topics:claude-opus-5', 'claude-code:claude-opus-5')).toBe(true);
  });

  test("`auto` non e' un modello: non porta nessun prefisso legacy, e resta il default acceso", () => {
    expect(surface(null, null, null, 'auto')).toBe(true);
  });

  test('board globale (nessun default, nessun modello): resta acceso', () => {
    expect(surface(null, null, null, null)).toBe(true);
  });
});

describe('il filo fra le due superfici e la cascata', () => {
  // Secondario: dice solo che nessuna delle due superfici e' tornata a ricalcolarsi la cascata per conto proprio. allow-italian: dice il confine di questa prova
  const here = dirname(fileURLToPath(import.meta.url));
  const composer = readFileSync(join(here, 'FloatingTaskComposer.tsx'), 'utf8');
  const drawer = readFileSync(join(here, 'TaskDetail.tsx'), 'utf8');
  const composerRoutingLine = composer.split('\n').find((line) => line.includes('const composerRouting = surfaceTopicsRoutingEnabled'))?.trim();
  const drawerRoutingLine = drawer.split('\n').find((line) => line.includes('const drawerRouting = surfaceTopicsRoutingEnabled'))?.trim();

  test('il composer chiama la funzione condivisa con i valori della card nuova', () => {
    expect(composer).toContain("import { surfaceTopicsRoutingEnabled } from '../../lib/topicsRoutingGate';");
    expect(composerRoutingLine).toBe('const composerRouting = surfaceTopicsRoutingEnabled({ topicsRouting, model }, boardTopicsRoutingDefault, boardDispatchModel);');
    expect(composer).toContain('const boardTopicsRoutingDefault = boardSettings?.dispatchTopicsRouting ?? null;');
    expect(composer).toContain('const boardDispatchModel = boardSettings?.dispatchModel ?? null;');
  });

  test('il cassetto chiama la stessa, con il task al posto del locale', () => {
    // Computed once, before the drawer's early returns, for the switch and the
    // chip's closed text alike (model selector revision §3.8): `task?.`.
    expect(drawerRoutingLine).toBe('const drawerRouting = surfaceTopicsRoutingEnabled(task ?? {}, boardTopicsRoutingDefault, boardDispatchModel);');
    expect(drawer.includes('enabled: !!task.topicsRouting')).toBe(false);
  });
});
