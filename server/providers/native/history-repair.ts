/**
 * UNA CONVERSAZIONE ROTTA NON GUARISCE DA SOLA, e per un'ora ha continuato a
 * rompersi allo stesso punto.
 *
 * Il protocollo dell'API e' rigido su una cosa: ogni blocco `tool_use` in un
 * messaggio dell'assistente deve avere il suo `tool_result` nel messaggio
 * SUBITO DOPO. `agent-loop` lo rispetta — spinge la risposta, poi i risultati —
 * ma solo se il turno arriva in fondo. Se il turno muore in mezzo (il processo
 * riparte, la rete cade, l'utente ferma) la storia resta con l'ultimo
 * `assistant` che chiede due tool e nessuno che risponde.
 *
 * Quella storia vive in memoria (`NativeSession.history`) e viene rimandata
 * IDENTICA al turno successivo. L'API la rifiuta, sempre, con lo stesso
 * messaggio:
 *
 *   API 400: `tool_use` ids were found without `tool_result` blocks immediately
 *   after: toolu_01Bvgeim…, toolu_01J54asA…
 *
 * Non e' un guasto passeggero e nessun ritentativo lo sblocca: il dispatcher
 * riprova due volte sulla stessa sessione, fallisce due volte identico, brucia
 * il budget e consegna all'umano una card senza niente sotto. Misurato il
 * 17/08 sul database vivo: 20 messaggi con quell'errore su 2 sessioni, dalle
 * 16:57 alle 20:15 — piu' di tre ore in cui ogni turno moriva sullo stesso
 * punto. Una delle due e' `5cf58e29`, arrivata in review vuota: «non capisco
 * che succede».
 *
 * ── La cura, e perche' e' questa ─────────────────────────────────────────────
 * Si POTA la coda: si tolgono i `tool_use` rimasti senza risposta e, se il
 * messaggio dell'assistente non conteneva altro che quelli, si toglie anche
 * lui. E' la stessa cosa che farebbe una persona guardando il transcript:
 * l'agente aveva chiesto degli strumenti, la richiesta non e' mai stata
 * evasa, quindi quella richiesta non e' successa.
 *
 * NON si inventano `tool_result` finti: un risultato inventato e' peggio di
 * una richiesta mancante, perche' l'agente lo LEGGE e ci costruisce sopra.
 * Fargli credere che un comando sia andato a buon fine quando non e' mai
 * partito e' il genere di bugia che si scopre tre passi dopo.
 *
 * Il testo resta, sempre: se l'assistente aveva anche scritto qualcosa prima di
 * chiedere i tool, quella frase e' lavoro vero e sopravvive alla potatura.
 */

import type { AgentMessage, Block } from "./agent-loop";

/** I blocchi di un messaggio, qualunque forma abbia il `content`. */
function blocksOf(m: AgentMessage): Block[] {
  return Array.isArray(m.content) ? m.content as Block[] : [];
}

/**
 * Gli id dei `tool_use` che nessun `tool_result` ha mai soddisfatto.
 *
 * Si guarda TUTTA la storia e non solo l'ultima coppia: una potatura parziale
 * lascerebbe in mezzo lo stesso difetto, e l'API guarda ogni messaggio.
 * L'insieme dei risultati si raccoglie prima, perche' un `tool_result` puo'
 * arrivare in un messaggio successivo a quello immediatamente dopo (il loop non
 * lo fa, ma una storia importata o modificata a mano si').
 */
export function orphanToolUseIds(history: readonly AgentMessage[]): string[] {
  const risposti = new Set<string>();
  for (const m of history) {
    for (const b of blocksOf(m)) {
      if (b.type === "tool_result" && b.tool_use_id) risposti.add(b.tool_use_id);
    }
  }
  const orfani: string[] = [];
  for (const m of history) {
    if (m.role !== "assistant") continue;
    for (const b of blocksOf(m)) {
      if (b.type === "tool_use" && b.id && !risposti.has(b.id)) orfani.push(b.id);
    }
  }
  return orfani;
}

/**
 * La stessa storia, ma spedibile: senza richieste di tool a cui non ha mai
 * risposto nessuno.
 *
 * Torna l'array IDENTICO quando non c'e' niente da potare — che e' il caso
 * normale, ogni turno finito bene — cosi' la sanificazione non costa nulla e
 * non puo' introdurre differenze dove non serviva.
 */
export function pruneDanglingToolUses(history: readonly AgentMessage[]): AgentMessage[] {
  const orfani = new Set(orphanToolUseIds(history));
  if (orfani.size === 0) return history as AgentMessage[];

  const out: AgentMessage[] = [];
  for (const m of history) {
    const blocks = blocksOf(m);
    if (m.role !== "assistant" || blocks.length === 0) { out.push(m); continue; }
    const tenuti = blocks.filter((b) => !(b.type === "tool_use" && b.id && orfani.has(b.id)));
    if (tenuti.length === blocks.length) { out.push(m); continue; }
    // Non restava altro che le richieste cadute: il messaggio sparisce del
    // tutto. Un `assistant` con `content: []` e' a sua volta invalido, e
    // lasciarlo li' scambierebbe un errore con un altro.
    if (tenuti.length === 0) continue;
    // ...ma se c'era anche del TESTO, quello e' lavoro vero e resta.
    out.push({ ...m, content: tenuti });
  }
  return out;
}
