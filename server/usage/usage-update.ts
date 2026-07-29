/**
 * La forma STANDARD del contatore di contesto: `usage_update` di ACP (3.1).
 *
 * Il ring è arrivato in 1b.5, ma il suo payload era scritto a mano in due
 * posti — l'evento WS in `routes/chat.ts` e `GET /api/context/live` in
 * `routes/context.ts` — e il NUMERATORE (quali token contano come "contesto")
 * era una riga dentro il provider Claude. Tre conseguenze, tutte vere prima di
 * questo modulo: i due payload potevano divergere senza che niente se ne
 * accorgesse; un provider non-Claude non aveva modo di accendere il ring (per
 * Codex il cerchietto restava vuoto per sempre, pur avendo i token in mano);
 * e la regola "il contesto è input + cache, mai output" non stava scritta da
 * nessuna parte come regola.
 *
 * Qui la forma sul filo è l'oggetto ACP LETTERALE, non una sua parafrasi:
 *
 *   { sessionUpdate: "usage_update", used, size, cost? }
 *
 * `used` e `size` sono obbligatori per contratto ACP, ed è il punto: un
 * provider non può mandare metà del rapporto («so quanto ho usato ma non
 * quanto ci sta») e lasciare la UI a indovinare il denominatore. Quando in 3.2
 * arriverà un client ACP vero, quell'oggetto si inoltra così com'è — nessuna
 * traduzione, nessun campo da rinominare.
 *
 * `percent` / `level` / `estimated` / `model` restano NOSTRI e viaggiano
 * accanto al blocco, non dentro: sono presentazione (che colore ha l'anello,
 * quando scatta il preavviso di compaction), non protocollo.
 *
 * Vocabolario allineato a `providers/stop-reason.ts`, per lo stesso motivo:
 * uno standard nominato in due modi diversi sono due standard.
 */

import type { ProviderUsage } from "../providers/types";
import { classifyContext, contextWindowFor, windowModelFor, type ContextUsage } from "./context-window";

// Il blocco ACP e il suo costo stanno in `shared/types.ts`: è la forma che
// arriva al client nel contatore di contesto, non un dettaglio del server.
export type { UsageCost, AcpUsageUpdate } from "../../shared/types";
import type { UsageCost, AcpUsageUpdate } from "../../shared/types";

/** Quello che viaggia sul filo: il blocco ACP + la nostra presentazione. */
export interface ContextUpdate {
  usage: AcpUsageUpdate;
  /** 0–100, satura a 100. */
  percent: number;
  level: ContextUsage["level"];
  /** true = finestra dedotta dal default perché il modello non è in tabella. */
  estimated: boolean;
  /** Modello che ha servito la chiamata: è lui a dimensionare la finestra. */
  model?: string;
}

/**
 * Il NUMERATORE, per qualunque provider.
 *
 * Contesto = quanto era grande il prompt che il modello ha appena visto:
 * `input + cache_read + cache_creation`. L'output NON ci va (è ciò che il
 * modello ha prodotto, non ciò che ha letto) e i reasoning token nemmeno —
 * sono già dentro l'input del giro successivo, contarli qui li conterebbe due
 * volte.
 *
 * Pura, non lancia: un `usage` assente o malformato vale 0, e `buildContextUpdate`
 * decide cosa farne. Un ring vuoto è meglio di un ring che mente.
 */
export function contextTokensFromUsage(usage: ProviderUsage | null | undefined): number {
  if (!usage || typeof usage !== "object") return 0;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return n(usage.inputTokens) + n(usage.cacheRead) + n(usage.cacheCreation);
}

/**
 * Numeratore + nome del modello → il payload completo, uguale su WS e su REST.
 *
 * `model` è quello che ha servito QUELLA chiamata, non quello richiesto: se la
 * CLI ripiega su un altro modello a metà turno (fast mode, sovraccarico) è il
 * secondo a dimensionare la finestra. `fallbackModel` copre i provider che il
 * modello non lo dicono per chiamata.
 *
 * `windowTokens` è il denominatore DETTO DAL PROVIDER (Codex lo manda:
 * `model_context_window`). Vince sulla tabella e spegne `estimated`: una
 * finestra dichiarata da chi serve il modello non è una stima nostra, ed è
 * l'unico modo di non sbagliare su un modello che non abbiamo in tabella.
 */
export function buildContextUpdate(args: {
  tokens: number;
  model?: string | null;
  fallbackModel?: string | null;
  windowTokens?: number | null;
  cost?: UsageCost;
}): ContextUpdate {
  const model = args.model || args.fallbackModel || null;
  const declared =
    typeof args.windowTokens === "number" && Number.isFinite(args.windowTokens) && args.windowTokens > 0
      ? { tokens: Math.round(args.windowTokens), known: true }
      : null;
  // Il nome che dimensiona la finestra non è sempre quello che ha servito la
  // chiamata: `[1m]` è una modalità, e la CLI riporta il modello senza suffisso.
  // `windowModelFor` tiene il suffisso della richiesta quando a rispondere è
  // stato lo stesso modello, e lo lascia cadere quando la CLI è ripiegata su un
  // altro. Vedi context-window.ts.
  const usage = classifyContext(
    args.tokens,
    declared ?? contextWindowFor(windowModelFor(args.model, args.fallbackModel)),
  );
  return {
    usage: {
      sessionUpdate: "usage_update",
      used: usage.used,
      size: usage.size,
      ...(args.cost ? { cost: args.cost } : {}),
    },
    percent: usage.percent,
    level: usage.level,
    estimated: usage.estimated,
    ...(model ? { model } : {}),
  };
}

/**
 * Dalla misura già classificata (quella persistita in `session_context`) al
 * payload sul filo. Stessa forma dell'evento vivo: chi apre l'app a turno
 * finito deve leggere lo stesso oggetto di chi era collegato durante.
 */
export function contextUpdateFromUsage(
  usage: ContextUsage,
  model?: string | null,
  cost?: UsageCost,
): ContextUpdate {
  return {
    usage: {
      sessionUpdate: "usage_update",
      used: usage.used,
      size: usage.size,
      ...(cost ? { cost } : {}),
    },
    percent: usage.percent,
    level: usage.level,
    estimated: usage.estimated,
    ...(model ? { model } : {}),
  };
}
