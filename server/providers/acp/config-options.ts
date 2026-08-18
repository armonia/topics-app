/**
 * LA NEGOZIAZIONE DELLE `configOptions`: quello che l'agente dice di sé, e le
 * due leve che Topics gli chiede di muovere (modello ed effort).
 *
 * PERCHE' STA IN UN FILE SUO. `acp.ts` aveva superato le 800 righe di
 * `check:bloat` (995 il 2026-08-16) e il cancello ha ragione: un file che due
 * persone non possono toccare insieme e' un lucchetto, e qui lavora una dozzina
 * di agenti alla volta. Questo blocco e' anche quello che si stacca meglio,
 * perche' e' l'unico che risponde a una domanda diversa dal resto del provider:
 * il resto gestisce un PROCESSO e una SESSIONE, questo gestisce una
 * NEGOZIAZIONE — e non e' un caso che modello ed effort si siano scritti a
 * giorni di distanza copiando la stessa forma.
 *
 * LA LETTURA E' PURA, L'APPLICAZIONE NO. `parseModelOptions` e `currentModelFrom`
 * non toccano niente e si provano con un oggetto letterale; `applyModel` e
 * `applyEffort` devono parlare con l'agente, e prendono lo stato come argomento
 * invece di leggerlo da `this`. E' la cucitura che permette di provare il
 * degrado (metodo assente, valore rifiutato, timeout) senza un agente vero.
 *
 * IL VERSO DEL DEGRADO, uguale per entrambe le leve e scritto una volta sola:
 * ACP v1 non standardizza ne' il cambio di modello ne' l'effort, quindi un
 * agente che non li conosce (`-32601`) NON e' rotto. Si smette di chiedere e si
 * avvisa una volta; un turno non muore mai per una preferenza non applicata,
 * perche' un turno sul modello sbagliato e' lavoro fatto male, un turno morto e'
 * lavoro perso.
 */
import type { JsonRpcPeer } from "./jsonrpc";
import { errText, isMethodNotFound, readTopicEffort, withTimeout } from "./helpers";

/** Quanto si aspetta una leva prima di rinunciare e lasciar girare il turno. */
export const SET_OPTION_TIMEOUT_MS = 10_000;

/** La parte di sessione che questa negoziazione legge e scrive. */
export interface NegotiableSession {
  acpSessionId: string;
  model?: string | null;
  effort?: string | null;
}

/**
 * Cosa l'agente ha smesso di sapere fare. Vive nel provider (una volta per
 * agente, non per sessione) e passa di qui per riferimento: e' una proprieta'
 * dell'AGENTE, non del turno, quindi chiederglielo di nuovo a ogni giro
 * sporcherebbe il log per sempre.
 */
export interface UnsupportedFlags {
  model: boolean;
  effort: boolean;
}

/** I nomi dei modelli dichiarati nei `configOptions`, o `null` se non ce ne sono. */
export function parseModelOptions(res: Record<string, unknown> | undefined): string[] | null {
  const opts = res?.configOptions;
  if (!Array.isArray(opts)) return null;
  const model = opts.find(
    (o): o is Record<string, unknown> =>
      !!o && typeof o === "object" && (o as Record<string, unknown>).id === "model",
  );
  const list = model?.options;
  if (!Array.isArray(list)) return null;
  const names = list
    .map((o) => (o && typeof o === "object" ? (o as Record<string, unknown>).value : null))
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  return names.length > 0 ? names : null;
}

/**
 * IL MODELLO CHIESTO ESISTE, per quanto ne sappiamo?
 *
 * `null`/vuoto = non lo sappiamo (l'agente non ha ancora dichiarato il suo
 * catalogo): in quel caso si prova, perche' rifiutare su un'ignoranza sarebbe
 * peggio che sbagliare. Se invece il catalogo c'e' e il nome non e' dentro, la
 * risposta e' no — e la conseguenza e' un turno sul modello di default, non una
 * card morta.
 *
 * IL PATTO DEL DEGRADO, misurato il 18/08 contro jcode vero: `session/set_model`
 * ACCETTA un nome inesistente senza protestare, e il 404 arriva dopo, dal vero
 * endpoint della chat, a turno gia' partito — «status: 404 model:
 * modello-che-non-esiste-42». Su una board significa che un `task.model` scritto
 * male non costa un turno sul modello sbagliato: ferma la card. E `board_model`
 * e' un campo che si scrive a mano.
 */
export function modelIsKnown(model: string, known: string[] | null | undefined): boolean {
  if (!known || known.length === 0) return true;
  return known.includes(model);
}

/** Il modello che l'agente dichiara ATTIVO in una risposta con `configOptions`. */
export function currentModelFrom(res: Record<string, unknown> | undefined): string | null {
  const opts = res?.configOptions;
  if (!Array.isArray(opts)) return null;
  const model = opts.find(
    (o): o is Record<string, unknown> =>
      !!o && typeof o === "object" && (o as Record<string, unknown>).id === "model",
  );
  const cur = model?.currentValue;
  return typeof cur === "string" && cur ? cur : null;
}

/**
 * Porta la sessione sul modello CHIESTO da chi apre il turno.
 *
 * Perché esiste. Su Topics il modello non è una preferenza globale: la board lo
 * sceglie PER TASK (`task.model`, o il classificatore automatico), ed è una
 * leva di costo — lo stesso lavoro su un modello grosso e su uno piccolo non
 * costa uguale. Il provider ACP però riceveva `_options` e lo buttava via: ogni
 * sessione girava sul modello di default dell'agente, in silenzio. Su una board
 * dispacciata significa che «questo task su haiku» non veniva onorato e nessuno
 * se ne accorgeva, perché il turno riesce lo stesso.
 *
 * La risposta rimanda i `configOptions` aggiornati e si legge da lì invece di
 * dare per buono ciò che abbiamo chiesto: un agente che accetta la chiamata ma
 * tiene un altro modello (nome normalizzato, alias, fallback) deve risultare
 * per quello che HA, non per quello che gli è stato detto.
 */
export async function applyModel(
  peer: JsonRpcPeer,
  state: NegotiableSession,
  model: string | undefined,
  /**
   * `onConfig` riceve la risposta INTERA e non i soli nomi, ed e' il punto in
   * cui questa estrazione ha gia' sbagliato una volta: passando solo l'elenco
   * dei modelli, il `currentValue` rimandato dall'agente non arrivava piu' al
   * provider e `defaultModel()` restava sul modello di prima. Chi applica una
   * leva deve poter aggiornare TUTTO cio' che l'agente ha appena dichiarato,
   * non la meta' che serviva a chi ha scritto la firma.
   */
  ctx: {
    name: string;
    unsupported: UnsupportedFlags;
    /** Il catalogo che l'agente ha dichiarato, se l'ha dichiarato. Vedi `modelIsKnown`. */
    knownModels?: string[] | null;
    onConfig?: (res: Record<string, unknown> | undefined) => void;
  },
): Promise<void> {
  if (!model || model === state.model) return;
  if (ctx.unsupported.model) return;
  // Il catalogo dell'agente e' l'unica cosa che sappiamo PRIMA di provarci, e
  // `session/set_model` non protesta su un nome inventato: il rifiuto arriva
  // dal vero endpoint della chat, a turno gia' partito. Vedi `modelIsKnown`.
  if (!modelIsKnown(model, ctx.knownModels)) {
    // Il catalogo si NOMINA, non si riversa: jcode ne dichiara oltre centotrenta,
    // e un avviso lungo una schermata e' un avviso che si impara a saltare.
    const cat = ctx.knownModels ?? [];
    const assaggio = cat.slice(0, 5).join(", ") + (cat.length > 5 ? `, +${cat.length - 5} altri` : "");
    console.warn(
      `[ACP:${ctx.name}] modello "${model}" non e' fra i ${cat.length} che l'agente dichiara ` +
      `(${assaggio}): il turno gira sul modello di default. ` +
      "Un nome sbagliato costa un turno sul modello sbagliato, non una card ferma.",
    );
    return;
  }
  try {
    const res = await withTimeout(
      peer.request<Record<string, unknown>>("session/set_model", {
        sessionId: state.acpSessionId,
        model,
      }),
      SET_OPTION_TIMEOUT_MS,
      "ACP_SET_MODEL_TIMEOUT",
    );
    ctx.onConfig?.(res);
    state.model = currentModelFrom(res) ?? model;
  } catch (err) {
    // Metodo assente = questo agente non sa cambiare modello. È una proprietà
    // dell'agente, non di questo turno: si smette di chiederglielo.
    if (isMethodNotFound(err)) {
      ctx.unsupported.model = true;
      console.warn(
        `[ACP:${ctx.name}] non sa cambiare modello (session/set_model assente): ` +
        `i turni girano sul modello scelto dall'agente, la scelta per task non si applica`,
      );
      return;
    }
    // Modello rifiutato (nome sconosciuto, non disponibile su questo account):
    // vale per QUESTO nome, non per il metodo — un altro task con un altro
    // modello deve poter riprovare.
    console.warn(`[ACP:${ctx.name}] modello "${model}" non applicato: ${errText(err)}`);
  }
}

/**
 * Porta la sessione sull'effort di ragionamento chiesto per questo topic.
 *
 * Perché è separato dal modello. L'effort è la leva più CARA che Topics ha:
 * sullo stesso lavoro `medium` ha misurato 61,1k token e `xhigh` 108,8k. La
 * board lo sceglie per task esattamente come il modello, e su claude-code
 * finisce nei flag di spawn — quindi ignorarlo qui vorrebbe dire che
 * dispacciare su jcode fa saltare il freno del costo senza dirlo.
 *
 * Perché il valore non arriva da `sendChat`. L'effort non è nelle opzioni del
 * turno: vive sulla riga del topic (migrazione 033) e ogni provider se lo va a
 * leggere. Si fa lo stesso, con la stessa lettura stretta di claude-code.
 *
 * Degrada come il modello, e qui il ripiego è più probabile:
 * `set_reasoning_effort` vale solo per i modelli che espongono il thinking di
 * Anthropic, quindi il rifiuto è NORMALE su tutti gli altri e non deve sporcare
 * il log a ogni turno né fermare niente.
 */
export async function applyEffort(
  peer: JsonRpcPeer,
  state: NegotiableSession,
  sessionKey: string,
  ctx: { name: string; unsupported: UnsupportedFlags; readEffort?: (k: string) => string | null },
): Promise<void> {
  if (ctx.unsupported.effort) return;
  const effort = (ctx.readEffort ?? readTopicEffort)(sessionKey);
  if (!effort || effort === state.effort) return;
  try {
    await withTimeout(
      peer.request("session/set_reasoning_effort", {
        sessionId: state.acpSessionId,
        effort,
      }),
      SET_OPTION_TIMEOUT_MS,
      "ACP_SET_EFFORT_TIMEOUT",
    );
    state.effort = effort;
  } catch (err) {
    if (isMethodNotFound(err)) {
      ctx.unsupported.effort = true;
      console.warn(
        `[ACP:${ctx.name}] non sa cambiare l'effort (session/set_reasoning_effort assente): ` +
        `i turni girano sull'effort scelto dall'agente`,
      );
      return;
    }
    // Rifiuto del VALORE: succede per i modelli che non espongono il thinking,
    // ed è normale. Si segna comunque come applicato per non ripetere la
    // richiesta (e l'avviso) a ogni turno della sessione.
    state.effort = effort;
    console.warn(`[ACP:${ctx.name}] effort "${effort}" non applicato: ${errText(err)}`);
  }
}
