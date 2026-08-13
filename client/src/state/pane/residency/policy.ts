/**
 * Chi resta montato, e chi viene sfrattato.
 *
 * Il problema che risolve. Le pane visitate restavano montate PER SEMPRE: due
 * `visitedKeys: Set<string>` (uno in `GroupLayout`, uno in `StandaloneChatGroup`)
 * a cui ogni pane attivata veniva aggiunta e da cui usciva solo alla chiusura
 * della pane. Per una chat è DOM; per una pane browser è una WKWebView, cioè un
 * processo da 155-637 MB. Misurato il 2026-07-29 sull'app viva, dopo 18 ore di
 * uso normale: **65 processi WebContent, 13,95 GB di footprint**. Di quei 65,
 * 61 avevano ZERO tempo di CPU in una finestra di 12 secondi (11,67 GB): non li
 * guardava nessuno, e nessuno li avrebbe mai chiusi.
 *
 * Questo modulo è la DECISIONE, ed è puro: nessun DOM, nessun React, nessun
 * timer. Il registro (`registry.ts`) ci porta i fatti e applica l'esito; qui si
 * risponde a una sola domanda, e la si può testare in isolamento.
 *
 * Il tetto è GLOBALE al renderer, non per superficie. `visitedKeys` era
 * istanziato in ogni superficie — il gruppo standalone, il `GroupLayout` di ogni
 * finestra, quello ANNIDATO dentro ogni pane `project`, ogni finestra staccata:
 * un tetto per-superficie con quattro progetti aperti moltiplica per quattro.
 * Per questo l'input è già l'unione di tutte le superfici, deduplicata per
 * chiave: la stessa pane vista da due superfici conta una volta sola.
 */

/**
 * Classe di costo. Non un numero unico: una chat nascosta è un albero DOM
 * congelato, una pane browser è un processo di sistema. Un tetto solo, tarato
 * sul caso caro, strozzerebbe le chat; tarato sul caso leggero non conterrebbe
 * niente.
 */
export type ResidencyClass = 'native' | 'heavy' | 'light';

export interface ResidencyCandidate {
  /** `stableKey ?? id` — sopravvive a PANE_ID_REMAP, come le chiavi React. */
  key: string;
  cls: ResidencyClass;
}

export interface ResidencyInput {
  /** Ogni pane montabile, da TUTTE le superfici. I duplicati sono ammessi. */
  candidates: readonly ResidencyCandidate[];
  /** Pane visibili adesso (una per gruppo: in split sono N insieme). */
  visible: ReadonlySet<string>;
  /** Trattenute da un motivo esplicito: agente al volante, upload in volo. */
  held: ReadonlySet<string>;
  /** Ultimo istante in cui la chiave è stata visibile. Assente = mai vista. */
  lastTouchedAt: ReadonlyMap<string, number>;
  now: number;
  /** Slot AGGIUNTIVI per classe, oltre al pavimento. Vedi `RESIDENCY_BUDGET`. */
  budget: Readonly<Record<ResidencyClass, number>>;
  /** Finestra di grazia dopo che una pane smette di essere visibile. */
  minDwellMs: number;
}

export interface ResidencyDecision {
  resident: Set<string>;
  evicted: Set<string>;
}

/**
 * I tetti. Numeri fissi, non derivati da `usePerfMetrics`: quel poll gira solo
 * se la status bar è montata e il set di pid è cacheato 10s lato Rust
 * (`lib.rs:138`). Un tetto che si muove su un dato stantìo non è né verificabile
 * né spiegabile — "perché questa tab si è ricaricata?" deve avere una risposta
 * deterministica.
 *
 * Sono slot AGGIUNTIVI, non un totale: le pane visibili sono un pavimento e
 * stanno fuori dal conteggio. In split ce ne sono N insieme e nessuna di esse
 * può essere sfrattata — sfrattare ciò che l'utente sta guardando è il solo modo
 * di sbagliare in modo visibile.
 *
 * Rollback: portare entrambi a `Infinity` ripristina esattamente il
 * comportamento di prima (tutto ciò che è stato visitato resta montato).
 */
export const RESIDENCY_BUDGET: Readonly<Record<ResidencyClass, number>> = {
  // `native` = una pane che possiede una WKWebView. NON si sfratta MAI. Il
  // motivo storico era che sfrattarla fosse in PERDITA SECCA. Quel motivo dal
  // 2026-08-13 non vale piu': resta il numero, cambia la ragione.
  //
  // COM'ERA. wry non distrugge la webview quando la chiudi. In `wry-0.55.1`,
  // `impl Drop for InnerWebView` chiama `self.webview.retain()`: INCREMENTA il
  // conteggio dei riferimenti mentre distrugge. E' deliberato, e' il workaround
  // per un use-after-free durante il dealloc (tauri-apps/wry#1733), ed e' lo
  // stesso sintomo di wry#536 e tauri#5397. Ogni ciclo sfratto -> rientro non
  // liberava niente e AGGIUNGEVA un processo permanente: misurato sull'app viva
  // il 2026-07-29, 61 processi e 4,1 GB in un'ora e mezza con lo sfratto
  // attivo, contro 65 processi accumulati in DICIOTTO ore senza tetto.
  //
  // A MONTE NON E' CAMBIATO NIENTE, verificato il 2026-08-12: il `retain()` sta
  // ancora nel `Drop` sia in wry 0.56.0 (l'ultima release, 2026-07-30) sia sul
  // branch `dev` (src/wkwebview/mod.rs), wry#1733 e' aperta e la PR wry#1734
  // non tocca quella riga. Alzare la versione non recupera un byte.
  //
  // COM'E' ADESSO. Il guscio si libera lo stesso, senza passare da wry:
  // `browser_close` chiama `-[WKWebView _close]`, che e' il teardown di WebKit,
  // e il processo WebContent muore (`free_native_webview` in
  // `desktop-tauri/src-tauri/src/lib.rs`). Misurato: 5 pane aperte e chiuse,
  // 108 MB -> 0 MB con zero processi vivi, dove prima erano 101 MB con tutti e
  // cinque ancora in piedi. Uno sfratto ci passa: smontare la pane fa scattare
  // `browser_close` nella cleanup di `useTauriBrowser`.
  //
  // PERCHE' RESTA `Infinity`. Perche' un numero finito non c'e' ancora.
  // Quello vecchio non si riusa (era tarato su uno sfratto che non liberava
  // niente) e uno nuovo va misurato con il costo che il rientro ha OGGI: la
  // pane ricarica la pagina da capo, che e' l'unica cosa che il retain di wry
  // rendeva gratis.
  //
  // Una pane browser nascosta non e' comunque a costo pieno: il guscio le
  // consegna `isVisible=false` e `useTauriBrowser` spegne la WKWebView
  // (`setNativeVisible(false)`), quindi smette di comporre e di ridisegnare.
  native: Infinity,
  heavy: 3,
  light: 12,
};

/**
 * Grazia dopo che una pane smette di essere visibile. Deve essere maggiore di
 * `BROWSER_CLOSE_GRACE_MS` (350 ms, `useTauriBrowser.ts`): quando lo sfratto
 * arriva, il render visibile→nascosto è già stato committato E i suoi effetti
 * sono girati, quindi `setNativeVisible(false)` ha già spento la WKWebView, URL
 * e titolo sono già persistiti e il coalescer del terminale ha già fatto flush.
 * Il registro rispetta lo stesso ritardo prima di applicare uno sfratto; questo
 * valore è la sua controparte nella decisione, e serve a non sfrattare una pane
 * che l'utente ha appena lasciato (torna indietro e la ritrova viva).
 */
export const MIN_DWELL_MS = 4000;

/** Possiede una WKWebView: sfrattarla non libera memoria e ne consuma altra. */
const NATIVE_TYPES = new Set<string>(['browser']);
/** Cara ma di solo DOM: `project` ospita un gruppo intero, e smontarlo LIBERA. */
const HEAVY_TYPES = new Set<string>(['project']);

/**
 * Classifica una pane per costo. La distinzione che conta non è "quanto pesa"
 * ma "smontarla restituisce qualcosa?": per una pane `project` sì (è DOM), per
 * una pane `browser` no (vedi la nota su `native` in `RESIDENCY_BUDGET`).
 */
export function residencyClassOf(paneType: string): ResidencyClass {
  if (NATIVE_TYPES.has(paneType)) return 'native';
  return HEAVY_TYPES.has(paneType) ? 'heavy' : 'light';
}

/**
 * Regole, in ordine. Le prime tre sono pavimenti: una chiave che le soddisfa è
 * residente comunque, il budget non la tocca.
 *
 *  1. VISIBILE  — sempre residente. L'invariante testata è
 *                 `evicted ∩ visible = ∅`, e non ha eccezioni.
 *  2. TRATTENUTA — un agente sta guidando quella pane browser, o c'è un upload
 *                 in volo in quella chat. Sfrattarla perde lavoro.
 *  3. DWELL     — smessa di essere visibile da meno di `minDwellMs`. Antithrash:
 *                 A→B→A→B non deve smontare niente.
 *  4. MAI VISTA — chi non è mai stato visibile non entra, punto. Il tetto può
 *                 solo RESTRINGERE l'insieme montato, mai allargarlo: una pane
 *                 aperta e mai guardata non deve montarsi da sola solo perché
 *                 avanzava uno slot (monterebbe una chat che nessuno ha chiesto,
 *                 fetchando la sua cronologia). È la semantica
 *                 "visita-all'attivazione" di prima, conservata alla lettera.
 *  5. BUDGET    — le restanti riempiono gli slot della propria classe, in ordine
 *                 MRU su `lastTouchedAt`.
 *  6. il resto è sfrattato.
 */
export function computeResident(input: ResidencyInput): ResidencyDecision {
  const { visible, held, lastTouchedAt, now, budget, minDwellMs } = input;

  // Dedup per chiave: la stessa pane può essere riportata da due superfici (una
  // pane `project` e il gruppo che ospita, una finestra staccata che mostra la
  // stessa chat). Contarla due volte consumerebbe due slot per un solo costo.
  const byKey = new Map<string, ResidencyClass>();
  for (const c of input.candidates) {
    // Se due superfici la classificano diversamente vince `heavy`: sbagliare
    // per eccesso di prudenza costa uno slot, sbagliare per difetto costa un
    // processo da mezzo giga sfrattato mentre serve.
    // Vince sempre la classe che si sfratta MENO: sbagliare per prudenza costa
    // uno slot, sbagliare al contrario costa un processo che non torna piu'.
    const prev = byKey.get(c.key);
    const rank = (k: ResidencyClass) => (k === 'native' ? 2 : k === 'heavy' ? 1 : 0);
    byKey.set(c.key, prev !== undefined && rank(prev) >= rank(c.cls) ? prev : c.cls);
  }

  const resident = new Set<string>();
  const contested: { key: string; cls: ResidencyClass; touched: number }[] = [];
  const evictedEarly: string[] = [];

  for (const [key, cls] of byKey) {
    if (visible.has(key) || held.has(key)) {
      resident.add(key);
      continue;
    }
    const touched = lastTouchedAt.get(key);
    if (touched === undefined) {
      // Mai visibile: non è mai stata montata, e il budget non la monta.
      evictedEarly.push(key);
      continue;
    }
    if (now - touched < minDwellMs) {
      resident.add(key);
      continue;
    }
    contested.push({ key, cls, touched });
  }

  // MRU: il più recentemente visibile sopravvive. `touched` decrescente, e a
  // parità la chiave, così l'esito è deterministico invece di dipendere
  // dall'ordine di iterazione di una Map costruita da più superfici.
  contested.sort((a, b) => (b.touched - a.touched) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const left: Record<ResidencyClass, number> = {
    native: budget.native,
    heavy: budget.heavy,
    light: budget.light,
  };
  const evicted = new Set<string>(evictedEarly);
  for (const c of contested) {
    if (left[c.cls] > 0) {
      left[c.cls] -= 1;
      resident.add(c.key);
    } else {
      evicted.add(c.key);
    }
  }

  return { resident, evicted };
}
