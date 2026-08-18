/**
 * LA STORIA DEL RUNTIME NATIVO NON PUÒ VIVERE SOLO IN RAM.
 *
 * `NativeProvider` tiene le conversazioni in una `Map` di processo e dichiara
 * `contextStrategy = "inline-system"`, che alla rotta significa: «la storia me
 * la ricordo io, non mandarmela». Per una CLI residente è vero — il figlio
 * sopravvive al riavvio del server, sta nel broker. Per il runtime nativo NON è
 * vero: la Map muore col processo, e su questa macchina il processo si riavvia a
 * ogni salvataggio in `server/`.
 *
 * Il risultato misurato il 2026-08-18 su topic:9fe7a291: l'utente chiede «fammi
 * un report di fine giornata» in una conversazione con dentro un'analisi da
 * 2.396 caratteri, e si sente rispondere «Non ho trovato messaggi nel topic "New
 * Chat"». Non era un modello che sbaglia: era un modello a cui non era stato
 * dato niente. Stessa causa del saluto generico che compariva a ogni riadozione.
 *
 * Il pezzo che mancava non è il canale — `sendChat` accetta già
 * `options.history` e la fa vincere su quella in memoria — ma la FONTE: dopo un
 * riavvio nessuno gliela passa, perché la strategia dice che non serve. Qui la
 * sessione fresca si ricostruisce dal DB, che è l'unico posto dove la
 * conversazione è sopravvissuta.
 *
 * La funzione pura sta separata dal caricatore apposta: le regole di sotto sono
 * quattro decisioni vere, e vanno provate senza un database.
 */

/** Una riga di conversazione come sta nel DB. */
export interface PersistedTurn {
  role: string;
  content: string;
  /** 1/true = turno tagliato a metà: non è una risposta, è un moncone. */
  partial?: number | boolean | null;
}

export interface RehydratedTurn {
  role: "user" | "assistant";
  content: string;
}

export type PersistedThreadLoader = (sessionKey: string) => PersistedTurn[];

let loadThread: PersistedThreadLoader | null = null;

/**
 * Il server inietta qui il suo `loadActiveThread`. Senza, la riparazione è un
 * no-op silenzioso: il provider è usabile anche fuori dal server (test,
 * strumenti), e in quel caso «non c'è storia» è la risposta giusta.
 */
export function configureNativeHistorySource(fn: PersistedThreadLoader | null): void {
  loadThread = fn;
}

/**
 * Da un thread persistito alla storia con cui far ripartire una sessione.
 *
 * Quattro regole, e ognuna è un modo in cui la trascrizione di Topics NON
 * coincide con quello che l'API accetta:
 *
 * 1. **Le righe vuote e i monconi si buttano.** Una riga `partial = 1` è un
 *    turno tagliato a metà (riavvio, stop, rete caduta); una riga senza testo è
 *    un segnaposto. Rimandarle non aggiunge contesto, e un `assistant` vuoto in
 *    mezzo confonde e basta.
 * 2. **Si comincia da `user`.** L'API rifiuta una conversazione che apre con
 *    l'assistente, e in Topics può succedere: un messaggio di sistema iniettato
 *    (`POST /api/topics/:id/system-message`) è una riga assistant senza domanda
 *    davanti.
 * 3. **L'ultima riga `user` si toglie, ed è ESATTAMENTE UNA.** È il messaggio
 *    del turno che sta per partire: la rotta lo scrive in DB *prima* di chiamare
 *    il provider, e `sendChat` lo rimette lui in fondo. Senza, il modello si
 *    vede la stessa domanda due volte e la seconda sembra un'insistenza.
 * 4. **I ruoli si alternano.** Due `assistant` di fila sono normali qui (una
 *    risposta più una nota di sistema) e non lo sono per l'API: si fondono in
 *    una riga sola, separate da una riga vuota.
 *
 * L'ORDINE FRA 3 E 4 È IL PUNTO, e l'ho sbagliato al primo giro. Fondendo prima
 * di togliere, due `user` consecutivi — che qui capitano davvero: una domanda
 * rimasta senza risposta perché il turno è morto, poi la domanda nuova —
 * diventano UNA riga, e toglierla butta via anche la domanda vecchia. Il thread
 * `[user "domanda", assistant tagliato, user "altra domanda"]` restituiva `[]`:
 * cioè, proprio nel caso in cui la storia era stata interrotta, la riparazione
 * non riparava niente. Prima si toglie una riga sola, poi si fonde.
 *
 * Una `user` può quindi restare in coda, ed è voluto: chi chiama la fonde con il
 * messaggio nuovo (vedi `sendChat`), così la domanda rimasta senza risposta
 * arriva al modello invece di sparire.
 */
export function historyFromPersistedThread(thread: readonly PersistedTurn[]): RehydratedTurn[] {
  // Regola 1: fuori i monconi e i segnaposto.
  const rows: RehydratedTurn[] = [];
  for (const row of thread) {
    if (row.partial === 1 || row.partial === true) continue;
    const content = typeof row.content === "string" ? row.content : "";
    if (!content.trim()) continue;
    rows.push({ role: row.role === "assistant" ? "assistant" : "user", content });
  }
  // Regola 2: via tutto ciò che precede il primo `user`.
  const firstUser = rows.findIndex((m) => m.role === "user");
  if (firstUser < 0) return [];
  const fromUser = rows.slice(firstUser);
  // Regola 3: UNA sola riga, e solo se è dell'utente.
  if (fromUser.length > 0 && fromUser[fromUser.length - 1].role === "user") fromUser.pop();
  // Regola 4: alternanza, fondendo i vicini di pari ruolo.
  const merged: RehydratedTurn[] = [];
  for (const m of fromUser) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`;
    else merged.push({ ...m });
  }
  return merged;
}

/**
 * La storia con cui ripartire per questa sessione, o vuota se non c'è modo di
 * saperlo. Non lancia mai: una riparazione che fallisce deve costare un turno
 * senza memoria, non un turno che non parte.
 */
export function rehydrateHistory(sessionKey: string): RehydratedTurn[] {
  if (!loadThread) return [];
  try {
    return historyFromPersistedThread(loadThread(sessionKey));
  } catch {
    return [];
  }
}
