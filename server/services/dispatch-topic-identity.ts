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
  topicsRoute,
  TaskProviderPendingError,
} from '../../shared/task-coding-models';
import { automaticTaskProvider } from './task-auto-model';

export interface DispatchTopicIdentity {
  /** Il bersaglio, come va SCRITTO sul topic. Assente = Automatico. allow-italian: dice cosa significa l'assenza */
  provider?: string;
  /** Il modello, gia' sciolto dal valore composto `provider:model`. allow-italian: dice che qui non arriva la forma composta */
  model?: string;
  /** Lo switch, persistito accanto al bersaglio. */
  topicsRouting: boolean;
  /** Chi esegue davvero il turno: il motore nativo quando la strada e' `topics`, il bersaglio altrimenti. allow-italian: dice chi esegue */
  executor: string;
}

/** MSEL-06: the switch is written as the card's effective value (scope
 *  `task`), and the route comes from `topicsRoute`. When the engine cannot
 *  reach the target (Codex, or a model the engine does not run), the topic
 *  is still created and runs direct, with the switch still written. */
export function resolveDispatchTopicIdentity(
  o: { provider?: string; model?: string | null; topicsRouting?: boolean | null },
  snapshot: ProvidersSnapshot | null,
): DispatchTopicIdentity {
  const { model } = taskModelSelection(o.model);
  const topicsRouting = effectiveTopicsRouting(o.topicsRouting, o.model, 'task');
  const target = o.provider
    ? automaticTaskProvider(o.provider, model, snapshot)
    : taskProviderForModel(o.model, snapshot, topicsRouting);
  const route = topicsRoute(topicsRouting, { provider: target, model: model ?? null }, snapshot, 'task', o.model);
  // Scoperta in corso non e' un no: si aspetta, come col warm-up di Codex. allow-italian: perche' qui si aspetta invece di proseguire
  if (route.via === 'pending') throw new TaskProviderPendingError('topics');
  // Automatico + ON: "topics" e' il MOTORE, non un bersaglio scelto da qualcuno. Scriverlo come provider del topic e' il modo esatto in cui l'instradamento diventava identita'. allow-italian: perche' il pin resta vuoto
  const pinned = topicsRouting && target === 'topics' && !o.provider ? undefined : target;
  return {
    ...(pinned ? { provider: pinned } : {}),
    ...(model ? { model } : {}),
    topicsRouting,
    // Con la strada `topics` il bersaglio non parte: va verificata la connessione del motore nativo, non quella di una CLI che nessuno avviera'. allow-italian: dice cosa va verificato a valle
    executor: route.via === 'topics' ? 'topics' : target,
  };
}

/** What the dispatcher reads back from a dispatched topic: the binding its
 *  provider hold and its session reuse are judged against. A topic pinned to
 *  no runtime runs where its route sends it (MSEL-06, `topicsRoute` with the
 *  card scope): the engine when the registry default is a target it reaches,
 *  the default itself otherwise. Reading the switch alone let a Codex default
 *  look like an engine session. */
export function dispatchTopicBinding(
  topic: { provider?: string | null; model?: string | null; topicsRouting?: boolean | null },
  defaultProvider: string | null | undefined,
  snapshot?: ProvidersSnapshot | null,
): { model?: string | null; provider?: string | null; topicsRouting?: boolean | null } {
  // Same reading as the chat resolver: a Claude model with no runtime pinned targets the engine.
  const on = effectiveTopicsRouting(topic.topicsRouting, null, 'task');
  const autoTarget = on && topic.model?.startsWith('claude-') ? 'topics' : defaultProvider ?? null;
  const route = topic.provider || !on ? null : topicsRoute(true, { provider: autoTarget, model: topic.model ?? null }, snapshot ?? null, 'task');
  return {
    model: topic.model,
    provider: topic.provider ?? (route?.via === 'topics' ? 'topics' : defaultProvider),
    // The reuse gate tells an engine session routed for Claude Code from one the engine runs directly.
    topicsRouting: topic.topicsRouting,
  };
}
