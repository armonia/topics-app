/**
 * QUALCUN ALTRO RISPONDE SULLA NOSTRA PORTA, e l'app non aveva modo di saperlo.
 *
 * IL GUASTO, misurato il 2026-08-20 sulla macchina dell'utente. Topics ascolta
 * su `*:3333` (bind IPv6 `::`, vedi `server.ts`). Un server di un ALTRO
 * progetto — `darkroom`, avviato a mano con `PORT=3333` — si era legato a
 * `127.0.0.1:3333`, cioè IPv4 esplicito. Il kernel consegna al binding più
 * SPECIFICO, quindi ogni connessione a `127.0.0.1:3333` finiva a darkroom: la
 * porta rispondeva `200` con l'HTML di un altro progetto, e in HTTPS moriva con
 * `tlsv1 alert protocol version` perché quel server non parla TLS.
 *
 * Per nove ore. Il sintomo che l'utente ha riportato è stato «ci mette un sacco
 * a connettersi… e vedo 1,8 GB di RAM», e le due cose erano lo stesso fatto: la
 * finestra non riusciva più a parlare col suo server, quindi teneva tutto ciò
 * che aveva senza ricevere altro. `mem-report` diceva già «server non
 * raggiungibile», ma nessuno guardava lì.
 *
 * PERCHÉ IL LOCK SINGLETON NON BASTAVA. Quello protegge da un SECONDO TOPICS
 * (stesso `~/.topics`, stesso file di lock), ed è la difesa giusta per quel
 * caso. Qui il processo non è Topics: non conosce il lock, non lo cerca, non lo
 * rispetta. E `reusePort: false` nemmeno aiuta — non c'è collisione da
 * rifiutare, perché `*:3333` in IPv6 e `127.0.0.1:3333` in IPv4 sono due
 * binding legittimi che coesistono.
 *
 * COSA FA QUESTA SONDA. Chiede alla PROPRIA porta, su IPv4, se chi risponde è
 * Topics. Non «c'è qualcosa in ascolto» (c'era, ed era il problema) ma «quello
 * che risponde sono io». La domanda è la sola che distingue i due casi.
 *
 * NON UCCIDE NIENTE, e non deve: il processo che sta di mezzo appartiene a
 * qualcun altro — nel caso reale, a un altro progetto dello stesso utente.
 * Chiuderlo d'iniziativa significherebbe spegnere il lavoro di qualcun altro
 * per un sospetto. Dice, forte, cosa ha trovato e chi è: il pid e il comando,
 * così chi legge il log sa esattamente quale finestra chiudere.
 */

/** Cosa ha trovato la sonda sulla porta di questo server. */
export type EsitoPorta =
  /** Risponde Topics: tutto a posto. */
  | { stato: "nostro" }
  /** Risponde qualcosa che NON è Topics: il pid e il comando, se leggibili. */
  | { stato: "estraneo"; pid: number | null; comando: string | null }
  /** Nessuno risponde su IPv4. Normale in dev con un bind IPv6-only e nessun
   *  client IPv4: non è un allarme, ed è per questo che ha un caso suo. */
  | { stato: "silenzio" }
  /** La sonda stessa non ha potuto decidere (rete, timeout, `lsof` assente). */
  | { stato: "ignoto"; perche: string };

export interface SondaPortaDeps {
  /** Una GET su `http://127.0.0.1:<porta>/…`; `null` se non risponde nessuno. */
  chiedi: (url: string) => Promise<{ ok: boolean; corpo: string } | null>;
  /** Chi ascolta su quella porta in IPv4. Il comando puo' mancare (`lsof` con
   *  permessi ridotti dà il pid e non la riga), e saperlo a meta' vale comunque
   *  più del silenzio: il pid basta per chiudere il processo giusto. */
  chiOccupa: (porta: number) => { pid: number; comando: string | null } | null;
  /** Il nostro pid, per non accusare noi stessi. */
  pidNostro: number;
}

/**
 * La rotta interrogata e la firma che ci identifica.
 *
 * `/api/system/presence` perché è la più economica che il server abbia (tre
 * COUNT indicizzati) e perché la sua risposta ha una forma che nessun altro
 * server produrrebbe per caso.
 */
export const ROTTA_SONDA = "/api/system/presence";

/**
 * La risposta è nostra? Si guarda la FORMA, non il codice di stato: darkroom
 * rispondeva 200 a tutto, quindi «ok» non distingue niente.
 *
 * I NOMI SONO PRESI DALLA RISPOSTA VERA, non da come me li ricordavo. La prima
 * versione cercava un campo `working` e accusava Topics stesso di essere un
 * intruso: `computePresenceCounts` restituisce
 * `{openSessions, workingSessions, activeTasks, focusProject}`. Un controllo
 * scritto a memoria su un contratto che non si è verificato produce
 * esattamente il falso allarme che questa sonda esiste per evitare.
 *
 * Si richiedono DUE campi e non uno: un solo intero di nome comune potrebbe
 * capitare per caso nella risposta di un altro server, due con questi nomi no.
 */
export function rispostaNostra(corpo: string): boolean {
  try {
    const v = JSON.parse(corpo) as Record<string, unknown>;
    return (
      typeof v === "object" && v !== null &&
      typeof v.openSessions === "number" && typeof v.workingSessions === "number"
    );
  } catch {
    // HTML, testo, vuoto: non è la nostra risposta.
    return false;
  }
}

/**
 * Chiede alla propria porta chi risponde.
 *
 * `porta` è quella su cui questo processo si è legato: la sonda parla a
 * `127.0.0.1` di proposito, perché è l'indirizzo che il guscio e il client
 * usano davvero, ed è esattamente quello che un binding IPv4 altrui intercetta.
 */
export async function sondaPorta(porta: number, deps: SondaPortaDeps): Promise<EsitoPorta> {
  // SI PROVANO ENTRAMBI GLI SCHEMI, e non e' pignoleria: in produzione Topics
  // parla TLS, quindi una sonda solo-HTTP riceve `null` da SE STESSA e conclude
  // «silenzio» — cioe' tace esattamente sulla porta che deve sorvegliare.
  // Verificato: contro la 3333 viva la prima versione rispondeva `silenzio`.
  //
  // L'ordine e' https prima perche' e' com'e' configurata la produzione; su un
  // server in chiaro la prima cade e la seconda risponde, al costo di una
  // connessione rifiutata al boot.
  let risposta: { ok: boolean; corpo: string } | null = null;
  try {
    for (const schema of ["https", "http"] as const) {
      risposta = await deps.chiedi(`${schema}://127.0.0.1:${porta}${ROTTA_SONDA}`);
      if (risposta !== null) break;
    }
  } catch (err) {
    return { stato: "ignoto", perche: err instanceof Error ? err.message : String(err) };
  }

  if (risposta === null) return { stato: "silenzio" };
  if (rispostaNostra(risposta.corpo)) return { stato: "nostro" };

  const chi = deps.chiOccupa(porta);
  // Se il pid trovato è il nostro, chi risponde siamo noi con una forma che non
  // riconosciamo: è un difetto nostro, non un'invasione, e chiamarlo «estraneo»
  // manderebbe a cercare dalla parte sbagliata.
  if (chi && chi.pid === deps.pidNostro) {
    return { stato: "ignoto", perche: "risponde questo stesso processo con un corpo inatteso" };
  }
  return { stato: "estraneo", pid: chi?.pid ?? null, comando: chi?.comando ?? null };
}

/** La riga che finisce nel log. Separata perché è ciò che una persona legge
 *  alle otto di mattina davanti a un'app che non si connette. */
export function messaggioEsito(porta: number, esito: EsitoPorta): string | null {
  switch (esito.stato) {
    case "nostro":
    case "silenzio":
      return null;
    case "ignoto":
      return `[porta] non ho potuto verificare chi risponde su :${porta} — ${esito.perche}`;
    case "estraneo": {
      const chi = esito.pid !== null
        ? `pid ${esito.pid}${esito.comando ? ` (${esito.comando})` : ""}`
        : "un processo che non sono riuscito a identificare";
      return (
        `[porta] ⚠ SULLA 127.0.0.1:${porta} RISPONDE QUALCUN ALTRO: ${chi}.\n` +
        `[porta]   Topics ascolta su *:${porta} in IPv6, ma un bind IPv4 esplicito e' piu'\n` +
        `[porta]   specifico e si prende le connessioni: l'app parlera' con LUI, non con noi.\n` +
        `[porta]   Il sintomo e' «ci mette un sacco a connettersi» e una finestra che non si\n` +
        `[porta]   aggiorna piu'. Chiudi quel processo, o spostalo su un'altra porta.`
      );
    }
  }
}

/**
 * Le dipendenze vere, per chi non ha motivo di costruirsele: una `fetch` con
 * timeout e una lettura di `lsof`.
 *
 * Stanno qui e non nel chiamante perche' sono il mestiere di questo modulo, e
 * perche' `server.ts` non deve importare `child_process` per una sonda.
 */
export function sondaRealeDeps(pidNostro: number): SondaPortaDeps {
  return {
    chiedi: async (url) => {
      try {
        // `rejectUnauthorized: false`: il certificato di loopback e'
        // auto-firmato, e qui non si sta autenticando nessuno — si sta
        // chiedendo «chi sei» a chi occupa una porta locale.
        const res = await fetch(url, {
          signal: AbortSignal.timeout(3000),
          tls: { rejectUnauthorized: false },
        } as RequestInit);
        return { ok: res.ok, corpo: await res.text() };
      } catch {
        // Connessione rifiutata / timeout: nessuno risponde, che e' un esito
        // legittimo e diverso da «risponde un estraneo».
        return null;
      }
    },
    chiOccupa: (porta) => {
      try {
        // `-F` dà righe `p<pid>` e `c<comando>`: si legge senza spezzare a
        // colonne, che con un comando pieno di spazi sarebbe fragile.
        const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
        const out = spawnSync("lsof", ["-nP", `-iTCP@127.0.0.1:${porta}`, "-sTCP:LISTEN", "-Fpc"], {
          encoding: "utf-8", timeout: 3000,
        }).stdout ?? "";
        const pid = out.match(/^p(\d+)/m)?.[1];
        const comando = out.match(/^c(.+)/m)?.[1];
        return pid ? { pid: Number(pid), comando: comando ?? null } : null;
      } catch {
        // `lsof` assente o senza permessi: si sa che c'e' un estraneo, non chi.
        return null;
      }
    },
    pidNostro,
  };
}
