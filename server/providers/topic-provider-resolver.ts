/**
 * Il resolver che gira DAVVERO in produzione. Il cancello sul modello vive solo se qualcuno passa `getTopicsModels`, e il registry vero non lo passava: meta' cancello era codice morto in produzione e vivo solo nei test. allow-italian: il difetto che ha fatto nascere la fabbrica
 * Questa fabbrica e' l'unico punto in cui il registry si costruisce, cosi' la lista non puo' piu' essere dimenticata da un chiamante. allow-italian: perche' e' una fabbrica e non un parametro
 */
import type { AIProvider } from './types';
import type { ProvidersSnapshot } from '../../shared/types';
import { resolveTopicProvider } from './resolve-topic-provider';

/**
 * I modelli che il motore nativo serve ORA, dallo stesso snapshot del lato task. `undefined` = non verificabile, e il cancello resta permissivo. allow-italian: cosa significa il ritorno `undefined`
 * Ci cadono apposta due casi: motore assente dalla fotografia, e catalogo ancora vuoto perche' lo snapshot si scalda asincrono — bloccare li' rifiuterebbe turni sani nei primi secondi dopo l'avvio. allow-italian: i due casi che NON sono un rifiuto
 */
export function topicsNativeModels(snapshot: ProvidersSnapshot | null | undefined): string[] | undefined {
  const native = snapshot?.providers.find((entry) => entry.name === 'topics');
  if (!native || !native.models.length) return undefined;
  return native.models;
}

type TopicLike = { provider?: string | null; model?: string | null; topicsRouting?: boolean | null } | null | undefined;

export function createTopicProviderResolver(deps: {
  getProvider(name: string): AIProvider;
  getDefaultProvider(): AIProvider;
  getSnapshot(): ProvidersSnapshot | null | undefined;
}): (topic?: TopicLike) => AIProvider {
  return (topic) => resolveTopicProvider(topic, {
    getProvider: deps.getProvider,
    getDefaultProvider: deps.getDefaultProvider,
    // Letto a ogni turno e non alla costruzione: un catalogo che cambia a server acceso deve cambiare la risposta. allow-italian: perche' e' una lambda e non un valore
    getTopicsModels: () => topicsNativeModels(deps.getSnapshot()),
  });
}
