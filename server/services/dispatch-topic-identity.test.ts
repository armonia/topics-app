/**
 * AICTRL-01: ON e' instradamento, non identita'. Il dispatcher scriveva `provider = "topics"` e non passava lo switch, cosi' il bersaglio scelto spariva e lo switch non finiva da nessuna parte. allow-italian: il difetto che il file blocca
 * Conseguenza: il giro di ritorno del picker, che rimette il bersaglio vero, contava come cambio di configurazione e faceva ripartire la sessione per niente. allow-italian: la conseguenza che si vedeva in faccia
 *
 * @covers AICTRL-01
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveDispatchTopicIdentity } from './dispatch-topic-identity';
import { resolveTopicProvider } from '../providers/resolve-topic-provider';
import { TopicsRoutingUnavailableError } from '../../shared/task-coding-models';
import type { ProvidersSnapshot } from '../../shared/types';

function entry(name: string, models: string[]) {
  return { name, label: name, status: 'ready' as const, models, requirements: [], capabilities: ['coding-tasks'] };
}
function snapshot(providers: ReturnType<typeof entry>[], defaultProvider = 'claude-code'): ProvidersSnapshot {
  return { providers, defaultProvider } as unknown as ProvidersSnapshot;
}

const FLEET = snapshot([
  entry('topics', ['claude-opus-5', 'claude-sonnet-5']),
  entry('claude-code', ['claude-opus-5', 'claude-sonnet-5']),
  entry('codex', ['gpt-5.4']),
]);

const native = { name: 'topics', connected: true } as never;
const claudeCode = { name: 'claude-code', connected: true } as never;
const registry = {
  getProvider: (name: string) => {
    if (name === 'topics') return native;
    if (name === 'claude-code') return claudeCode;
    throw new Error(`not registered: ${name}`);
  },
  getDefaultProvider: () => claudeCode,
  getTopicsModels: () => ['claude-opus-5', 'claude-sonnet-5'],
};

describe('identità del topic dispacciato', () => {
  it('ON conserva il bersaglio scelto e scrive lo switch accanto, senza diventare "topics"', () => {
    const id = resolveDispatchTopicIdentity(
      { provider: 'claude-code', model: 'claude-code:claude-opus-5', topicsRouting: true },
      FLEET,
    );
    expect(id.provider).toBe('claude-code');
    expect(id.model).toBe('claude-opus-5');
    expect(id.topicsRouting).toBe(true);
    // Esegue il motore nativo: e' la sua connessione da verificare, non quella di una CLI che con ON nessuno avvia. allow-italian: dice cosa va verificato a valle
    expect(id.executor).toBe('topics');
  });

  it('round-trip: il topic così scritto risolve sul motore nativo, e resta leggibile come il bersaglio scelto', () => {
    const id = resolveDispatchTopicIdentity(
      { provider: 'claude-code', model: 'claude-code:claude-sonnet-5', topicsRouting: true },
      FLEET,
    );
    // Quello che verrebbe persistito e riletto da chi esegue il turno dopo un riavvio. allow-italian: dice perche' questi due campi contano
    const persisted = { provider: id.provider ?? null, model: id.model ?? null, topicsRouting: id.topicsRouting };
    expect(resolveTopicProvider(persisted, registry)).toBe(native);
    expect(persisted.provider).toBe('claude-code');
    expect(persisted.model).toBe('claude-sonnet-5');
  });

  it('nessun respawn spurio: rimettere i valori persistiti non cambia niente', () => {
    // `spawnConfigChanged` (routes/topics.ts) confronta provider, model e
    // Se il topic nascesse pinnato a "topics", il picker che mostra il bersaglio vero rimanderebbe un provider DIVERSO e la sessione ripartirebbe per un valore mai cambiato. allow-italian: nomina il riavvio inutile che il test vieta
    const first = resolveDispatchTopicIdentity(
      { provider: 'claude-code', model: 'claude-code:claude-opus-5', topicsRouting: true },
      FLEET,
    );
    const again = resolveDispatchTopicIdentity(
      { provider: first.provider, model: first.model, topicsRouting: first.topicsRouting },
      FLEET,
    );
    expect(again.provider).toBe(first.provider!);
    expect(again.model).toBe(first.model!);
    expect(again.topicsRouting).toBe(first.topicsRouting);
  });

  it('Automatico + ON resta Automatico: "topics" lì è il motore, non un bersaglio scelto', () => {
    const id = resolveDispatchTopicIdentity({ topicsRouting: true }, FLEET);
    expect(id.provider).toBeUndefined();
    expect(id.topicsRouting).toBe(true);
    expect(id.executor).toBe('topics');
    expect(resolveTopicProvider({ provider: null, model: null, topicsRouting: true }, registry)).toBe(native);
  });

  it('OFF esegue il bersaglio diretto, e il bersaglio è anche l`esecutore', () => {
    const id = resolveDispatchTopicIdentity(
      { provider: 'claude-code', model: 'claude-code:claude-opus-5', topicsRouting: false },
      FLEET,
    );
    expect(id.provider).toBe('claude-code');
    expect(id.topicsRouting).toBe(false);
    expect(id.executor).toBe('claude-code');
    expect(resolveTopicProvider({ provider: 'claude-code', model: 'claude-opus-5', topicsRouting: false }, registry)).toBe(claudeCode);
  });

  it('ON verso un bersaglio irraggiungibile resta un cancello duro', () => {
    expect(() => resolveDispatchTopicIdentity(
      { provider: 'codex', model: 'gpt-5.4', topicsRouting: true },
      FLEET,
    )).toThrow(TopicsRoutingUnavailableError);
  });

  it('il legacy topics:<model> non si trasforma in un pin: resta Automatico con lo switch acceso', () => {
    const id = resolveDispatchTopicIdentity({ model: 'topics:claude-opus-5' }, FLEET);
    expect(id.topicsRouting).toBe(true);
    expect(id.provider).toBeUndefined();
    expect(id.model).toBe('claude-opus-5');
  });
});

it('il dispatcher di server.ts passa da questa decisione, e non riscrive piu` il provider a "topics"', () => {
  // Secondario: sopra si prova la regola, qui che il chiamante vero la usa. allow-italian: dice il confine di questa prova
  const source = readFileSync(join(import.meta.dir, '../../server.ts'), 'utf8');
  expect(source.includes('resolveDispatchTopicIdentity')).toBe(true);
  expect(/provider\s*=\s*["']topics["']/.test(source)).toBe(false);
});
