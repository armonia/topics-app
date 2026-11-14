import { TopicsRoutingIncompatibleError } from "../providers/resolve-topic-provider";
import type { ChatTurnScope } from "./chat-turn-scope";

/** Resolves the provider and the model that serve a turn, or refuses it. */
export function resolveTurnProvider(turn: ChatTurnScope): Response | undefined {
  const { adottaTurnoVivo, broadcastToAll, isReattach, isWoken, json, matchedTopic, resolveProvider, saveSingleTopic, sessionKey } = turn;
  // ─── Resolve provider for this topic (with optional per-message override) ───
  
  if (turn.forcedGlobalProvider) {
    turn.topicProvider = turn.forcedGlobalProvider;
  } else if (turn.explicitProvider) {
    turn.topicProvider = turn.explicitProvider;
  } else {
    // AICTRL-01: the switch can go stale between two page loads (routing
    // ON, then the pinned provider or the native engine stops being
    // reachable through it). The canonical rule forbids a silent OFF-style
    // fallback here — block the send with the exact reason instead, the
    // pinned provider/model untouched, no dispatch through a route the
    // user never chose.
    try {
      turn.topicProvider = resolveProvider(matchedTopic);
    } catch (err) {
      if (err instanceof TopicsRoutingIncompatibleError) {
        return json({ error: err.message, code: err.code }, 409);
      }
      throw err;
    }
  }

  /**
   * UN RIATTACCO NON SCEGLIE IL PROVIDER: LO EREDITA.
   *
   * `resolveProvider` risponde alla domanda «con chi vorrebbe parlare
   * questa topic?». Un riattacco fa una domanda diversa — «chi possiede il
   * turno che sta GIÀ girando?» — e le due risposte possono divergere: il
   * turno vivo è un figlio della CLI (`claude-code`, store del broker,
   * `claude_code_sessions`), mentre la preferenza cade sul default della
   * macchina, che qui è il runtime nativo (`topics`,
   * providers/native/provider.ts:89, DEFAULT_AGENT_RUNTIME in shared/types.ts).
   *
   * Il provider nativo non ha `reattach`, e più sotto il ternario cadeva su
   * `sendChat` con `userContent` = solo il preambolo `<context>` e NESSUNA
   * domanda (`messages: []` è il formato del riattacco, riga ~267). Il
   * risultato non era un degrado: era un turno FABBRICATO, pagato all'API
   * Anthropic, che rispondeva «Ciao! Come posso aiutarti con <nome del
   * topic>?» e si sedeva in chat al posto della risposta vera. Misurato il
   * 2026-08-18 su topic:9fe7a291: nove saluti, uno per riavvio del server,
   * mentre il turno CLI vero girava indisturbato e la sua risposta non
   * arrivava mai in `messages`.
   *
   * Due cose lo rendevano possibile insieme, e valgono come promemoria:
   * `isReattach` salta anche il cancello 409 «un turno per sessione» (riga
   * ~296, ed è giusto: adottare il turno vivo è il suo mestiere), quindi il
   * turno fantasma partiva su una sessione che ne aveva già uno in volo.
   *
   * Qui la regola è secca: chi non sa riattaccarsi non riattacca, e non
   * manda niente al suo posto. Il rifiuto arriva PRIMA della riga parziale,
   * dello stream e di qualunque chiamata al modello — non lascia traccia in
   * chat. 501 e non 409: un 409 `rejectedTurn` (server.ts:711) lo tradurrebbe
   * in «stream già in volo», che è un'altra storia; questo è un guasto di
   * cablaggio e deve leggersi come tale nel log del chiamante.
   */
  if (isReattach && typeof (turn.topicProvider as unknown as { reattach?: unknown }).reattach !== "function") {
    console.warn(
      `[Chat] riattacco RIFIUTATO su ${sessionKey}: il provider "${turn.topicProvider.name}" non sa riattaccarsi. ` +
      `Chi chiama un reattach deve dichiarare il provider che POSSIEDE il turno vivo (body.provider), ` +
      `altrimenti si cade sul default della macchina. Nessun messaggio inviato.`,
    );
    return json(
      { error: `provider "${turn.topicProvider.name}" cannot reattach`, code: "reattach_unsupported", provider: turn.topicProvider.name },
      501,
    );
  }
  /**
   * Stessa regola per il turno spontaneo: chi non sa adottarlo non deve
   * MANDARE qualcosa al suo posto (sarebbe il turno fabbricato descritto
   * sopra, per giunta addosso a uno che sta parlando). Non può capitare da
   * solo, ma chiude la via a chi chiamasse questa route a mano.
   */
  if (isWoken && typeof (turn.topicProvider as unknown as { adoptWokenTurn?: unknown }).adoptWokenTurn !== "function") {
    console.warn(`[Chat] risveglio RIFIUTATO su ${sessionKey}: il provider "${turn.topicProvider.name}" non sa adottare un turno spontaneo.`);
    return json(
      { error: `provider "${turn.topicProvider.name}" cannot adopt a woken turn`, code: "woken_unsupported", provider: turn.topicProvider.name },
      501,
    );
  }

  /**
   * UNA CONVERSAZIONE TIENE IL CERVELLO CON CUI È NATA.
   *
   * `topics.provider` vuoto non vuol dire «qualunque»: vuol dire «non
   * l'abbiamo mai scritto». E siccome `resolveProvider` cade sul default
   * della MACCHINA, e il default si ricalcola a ogni boot
   * (`recomputeDefault`, providers/index.ts — dipende da quali provider
   * risultano `connected` in quel momento), una chat a metà può cambiare
   * runtime da sola, senza che nessuno abbia toccato niente.
   *
   * Non è teorico. Il 2026-08-18 su topic:9fe7a291: il primo turno gira su
   * `claude-code` (JSONL, store del broker, riga in `claude_code_sessions`,
   * modello claude-opus-5[1m]) e produce una risposta lunga e documentata;
   * venti minuti e una ventina di riavvii dopo, il runtime nativo `topics`
   * risulta connesso, si prende il default, e i messaggi successivi
   * dell'utente finiscono su un provider la cui memoria è una Map in RAM
   * azzerata a ogni riavvio. Alla domanda «fammi il report di fine
   * giornata» ha risposto «Non ho trovato messaggi nel topic "New Chat"»:
   * non era un guasto del modello, era un altro modello, senza la
   * conversazione.
   *
   * Quindi il primo turno vero SCRIVE la scelta. Da lì la chat è stabile
   * per costruzione, e resta modificabile a mano: il picker per-topic
   * (`ProviderModelPicker` → PATCH /api/topics/:id) è l'unica cosa che
   * cambia questo campo. Un riattacco non pinna niente — non è una scelta,
   * è un'eredità.
   */
  if (!adottaTurnoVivo && matchedTopic && !matchedTopic.provider && turn.topicProvider.name) {
    matchedTopic.provider = turn.topicProvider.name;
    saveSingleTopic(matchedTopic);
    broadcastToAll({ type: "topic:updated", topic: matchedTopic });
    console.log(`[Chat] ${sessionKey}: runtime fissato su "${turn.topicProvider.name}" al primo turno (era il default della macchina, che si ricalcola a ogni boot)`);
  }
}
