/**
 * AICTRL-01: il registry PRODUTTIVO deve passare al resolver la lista dei modelli nativi, o il cancello sul modello non esiste. allow-italian: la regola che il file difende
 * Il registry vero lo costruiva senza quella lista, e senza lista la verifica risponde sempre "servito": il ramo "il motore non serve questo modello" era irraggiungibile fuori dai test. allow-italian: nomina il codice morto trovato in review
 * @covers AICTRL-01
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createTopicProviderResolver, topicsNativeModels } from './topic-provider-resolver';
import { TopicsRoutingIncompatibleError } from './resolve-topic-provider';
import type { ProvidersSnapshot } from '../../shared/types';

function snapshot(nativeModels: string[] | null): ProvidersSnapshot {
  const providers = [
    {
      name: 'claude-code', label: 'Claude Code', status: 'ready' as const,
      models: ['claude-opus-5', 'claude-sonnet-5'], requirements: [], capabilities: ['coding-tasks'],
    },
    ...(nativeModels === null ? [] : [{
      name: 'topics', label: 'Topics', status: 'ready' as const,
      models: nativeModels, requirements: [], capabilities: ['coding-tasks'],
    }]),
  ];
  return { providers, defaultProvider: 'topics' } as unknown as ProvidersSnapshot;
}

const native = { name: 'topics', connected: true } as never;
const claudeCode = { name: 'claude-code', connected: true } as never;

function resolverOver(nativeModels: string[] | null) {
  return createTopicProviderResolver({
    getProvider: (name: string) => {
      if (name === 'topics') return native;
      if (name === 'claude-code') return claudeCode;
      throw new Error(`not registered: ${name}`);
    },
    getDefaultProvider: () => claudeCode,
    getSnapshot: () => snapshot(nativeModels),
  });
}

describe('il registry produttivo porta i modelli del motore nativo', () => {
  it('blocca il turno quando il motore nativo NON serve il modello pinnato', () => {
    const resolve = resolverOver(['claude-opus-5']);
    let thrown: unknown;
    try { resolve({ provider: 'claude-code', model: 'claude-sonnet-5', topicsRouting: true }); }
    catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(TopicsRoutingIncompatibleError);
    expect((thrown as TopicsRoutingIncompatibleError).message).toContain('claude-sonnet-5');
  });

  it('lascia passare il modello che il motore nativo serve davvero', () => {
    const resolve = resolverOver(['claude-opus-5', 'claude-sonnet-5']);
    expect(resolve({ provider: 'claude-code', model: 'claude-sonnet-5', topicsRouting: true })).toBe(native);
  });

  it('un catalogo nativo ancora freddo non blocca: assente vuol dire non verificabile, non "non serve niente"', () => {
    // Lo snapshot si scalda asincrono: severi qui si rifiuterebbero turni sani nei primi secondi dopo l'avvio. allow-italian: perche' un catalogo freddo non e' un no
    expect(topicsNativeModels(snapshot([]))).toBeUndefined();
    expect(topicsNativeModels(snapshot(null))).toBeUndefined();
    expect(resolverOver([])({ provider: 'claude-code', model: 'claude-sonnet-5', topicsRouting: true })).toBe(native);
  });

  it('con lo switch spento la lista non c`entra: il provider pinnato risponde lui', () => {
    expect(resolverOver(['claude-opus-5'])({ provider: 'claude-code', model: 'claude-sonnet-5' })).toBe(claudeCode);
  });
});

it('il registry di topics.ts passa da questa fabbrica, mai da un resolver nudo', () => {
  // Secondario: sopra si prova che il cancello morde, qui che la produzione lo monta. Asserzioni su booleani perche' un `toContain` fallito stamperebbe 3000 righe nel log. allow-italian: dice il confine di questa prova e perche' e' scritta cosi'
  const source = readFileSync(join(import.meta.dir, '../routes/topics.ts'), 'utf8');
  expect(source.includes('createTopicProviderResolver')).toBe(true);
  expect(/resolveTopicProvider\s*\(/.test(source)).toBe(false);
});
