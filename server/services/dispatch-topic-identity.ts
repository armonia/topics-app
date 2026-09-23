/**
 * Chi e' il topic di un agente dispacciato, e chi lo esegue: due domande che il dispatcher confondeva in una. Con lo switch acceso riscriveva `provider = "topics"`, il bersaglio scelto spariva dalla riga e lo switch non veniva scritto affatto. allow-italian: il difetto che ha fatto nascere il modulo
 * Dopo un riavvio il topic si presentava pinnato al motore nativo, e il picker che rimetteva il bersaglio vero faceva ripartire la sessione per un valore mai cambiato. allow-italian: la conseguenza che si vedeva in faccia
 * AICTRL-01: ON e' instradamento, non identita'. Bersaglio e switch restano scritti, chi esegue lo decide il resolver a ogni turno. allow-italian: la regola in una riga
 */
import type { ProvidersSnapshot } from '../../shared/types';
import {
  effectiveTopicsRouting,
  taskModelSelection,
  taskProviderForModel,
  topicsRoutingAvailable,
  topicsRoutingWaitsForCatalog,
  TaskProviderPendingError,
  TopicsRoutingUnavailableError,
} from '../../shared/task-coding-models';
import { automaticTaskProvider } from './task-auto-model';

export interface DispatchTopicIdentity {
  /** Il bersaglio, come va SCRITTO sul topic. Assente = Automatico. allow-italian: dice cosa significa l'assenza */
  provider?: string;
  /** Il modello, gia' sciolto dal valore composto `provider:model`. allow-italian: dice che qui non arriva la forma composta */
  model?: string;
  /** Lo switch, persistito accanto al bersaglio. */
  topicsRouting: boolean;
  /** Chi esegue davvero il turno: il motore nativo con ON, il bersaglio con OFF. */
  executor: string;
}

export function resolveDispatchTopicIdentity(
  o: { provider?: string; model?: string | null; topicsRouting?: boolean | null },
  snapshot: ProvidersSnapshot | null,
): DispatchTopicIdentity {
  const { model } = taskModelSelection(o.model);
  const topicsRouting = effectiveTopicsRouting(o.topicsRouting, o.model);
  const target = o.provider
    ? automaticTaskProvider(o.provider, model, snapshot)
    : taskProviderForModel(o.model, snapshot, topicsRouting);
  // ON verso un bersaglio che il motore nativo non raggiunge e' un cancello duro, non un dispatch diretto silenzioso: stesso contratto del lato chat. allow-italian: perche' qui si lancia invece di proseguire
  if (topicsRouting && o.provider && target !== 'topics' && !topicsRoutingAvailable(target, model, snapshot)) {
    // Scoperta in corso non e' un no: si aspetta, come col warm-up di Codex. allow-italian: nota che prosegue l'intestazione italiana di questo file
    if (topicsRoutingWaitsForCatalog(target, snapshot)) throw new TaskProviderPendingError('topics');
    throw new TopicsRoutingUnavailableError(target, model ?? null);
  }
  // Automatico + ON: "topics" e' il MOTORE, non un bersaglio scelto da qualcuno. Scriverlo come provider del topic e' il modo esatto in cui l'instradamento diventava identita'. allow-italian: perche' il pin resta vuoto
  const pinned = topicsRouting && target === 'topics' && !o.provider ? undefined : target;
  return {
    ...(pinned ? { provider: pinned } : {}),
    ...(model ? { model } : {}),
    topicsRouting,
    // Con ON il bersaglio non parte: va verificata la connessione del motore nativo, non quella di una CLI che nessuno avviera'. allow-italian: dice cosa va verificato a valle
    executor: topicsRouting ? 'topics' : target,
  };
}
