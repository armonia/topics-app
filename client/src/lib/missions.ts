/**
 * LE MISSIONI — azioni nostre, nominate e ripetibili, da dare alla sessione
 * laterale della board.
 *
 * Perché esistono: senza, «l'orchestratore» è solo un altro posto dove scrivere
 * in prosa, e ogni volta si riscrive a mano la stessa richiesta un po' diversa.
 * Un preset invece è UNA cosa, sempre la stessa, e soprattutto porta con sé la
 * riga che di solito manca: **come si sa che è finita**. Un lavoro senza quella
 * riga non può fallire, quindi non finisce mai — si interrompe e basta.
 *
 * Perciò un preset non è un prompt: è `name` (come si chiama), `summary` (cosa
 * fa, in una riga, che è ciò che si legge nel menu) e `bar` (l'esito che
 * bisogna poter leggere per dire «fatto»). Il testo che arriva alla sessione è
 * costruito da questi tre, non scritto a parte: due copie della stessa missione
 * divergono al primo ritocco.
 *
 * Il testo NON viene mandato da qui. Arriva davanti all'umano nel composer
 * della sessione laterale, e a premere invio è lui: la missione dà compiti IN
 * PIÙ («lavoriamo il backlog»), non governa il lavoro normale della board.
 */

export interface Mission {
  /** Chiave stabile: la usa il menu come `key` e l'e2e come `data-mission`. */
  id: string;
  /** Il nome con cui la si chiama a voce. */
  name: string;
  /** Cosa fa, in una riga — è la riga che si legge nel menu. */
  summary: string;
  /** La barra in una riga sola: è ciò che il menu mostra sotto il nome, perché
   *  la si veda PRIMA di scegliere la missione, non dopo averla lanciata. */
  doneWhen: string;
  /** Cosa deve fare, per esteso: il corpo della missione. */
  what: string[];
  /** Come si sa che è finita. Senza questa riga il preset non esiste. */
  bar: string[];
}

export const MISSIONS: Mission[] = [
  {
    id: "inbox-zero",
    name: "inbox 0",
    summary: "ogni card in review ha una riga che permette di deciderla",
    doneWhen: "elenco id → esito per ogni card in review, zero id senza riga",
    what: [
      "Prendi TUTTE le card in `review` e rendile decidibili una per una.",
      "Per ciascuna: leggi il thread (`get_task`) e scrivi in una riga cosa è stato",
      "consegnato e qual è la decisione che aspetta. Se la card non è decidibile (manca",
      "la prova, manca il commento di consegna, la domanda non ha opzioni), dillo",
      "esplicitamente in quella riga: è quello il risultato utile.",
      "Non decidi tu al posto dell'umano e non sposti niente a `done`.",
    ],
    bar: [
      "Un elenco finale `id → esito`, una riga per OGNI card in review, dove l'esito",
      "è «pronta da decidere: <la decisione>» oppure «non decidibile: <cosa manca>».",
      "Zero id senza riga: se non ce l'hai per una card, la missione non è finita.",
    ],
  },
  {
    id: "backlog-empty",
    name: "svuota il backlog",
    summary: "ogni id o è lavorato o ha scritto perché no",
    doneWhen: "elenco id → destinazione per ogni card in backlog, zero id senza riga",
    what: [
      "Passa TUTTE le card in `backlog` e portale fuori dall'indecisione.",
      "Per ciascuna una sola scelta: la porti a `todo` (e dici perché adesso), oppure",
      "resta dov'è con scritto nel thread perché non ora, oppure è morta e lo dici.",
      "Prima di spostare qualcosa PROPONI l'elenco intero e fermati: si applica dopo",
      "un ok esplicito. Ad applicazione fatta ripeti l'elenco con lo stato prima → dopo,",
      "che è ciò che rende la mossa reversibile con una frase.",
    ],
    bar: [
      "Un elenco finale `id → destinazione` (todo / resta, col motivo / chiusa, col motivo),",
      "una riga per OGNI card in backlog. Zero id senza riga.",
    ],
  },
  {
    id: "verify-and-land",
    name: "verifica e landa ciò che è pulito",
    summary: "barra piena prima di ogni proposta di land",
    doneWhen: "per ogni id il comando e il suo exit code; si propone solo sugli 0",
    what: [
      "Per ogni card in `review` che ha codice committato su un branch, verifica PRIMA",
      "di proporre qualsiasi land: i cancelli del progetto sul suo branch (typecheck,",
      "test, lint, deadcode) eseguiti ADESSO, non citati a memoria.",
      "Solo le card i cui cancelli sono usciti zero arrivano alla proposta di land, che",
      "resta una proposta: a landare è l'umano dal controllo della board.",
      "Una card senza codice committato non entra in questa missione: dillo e passa.",
    ],
    bar: [
      "Per OGNI id verificato: il comando eseguito e il suo exit code, letti dall'output",
      "reale. Nessun id proposto per il land con un exit code diverso da 0 o mancante:",
      "«non ho potuto eseguire X» è un esito valido, «dovrebbe essere a posto» no.",
    ],
  },
];

/**
 * Il testo che arriva nel composer della sessione laterale.
 *
 * L'intestazione dice due cose che valgono per ogni missione: che lo stato della
 * board si LEGGE adesso (agire su ciò che si ricorda è il modo esatto in cui si
 * sposta la card sbagliata), e che questa sessione coordina, non lavora le card —
 * gli agenti nascono dalla board quando una card entra in Todo, non da qui.
 */
export function missionPrompt(mission: Mission, projectName: string): string {
  return [
    `MISSIONE · ${mission.name} (board: ${projectName})`,
    "",
    ...mission.what,
    "",
    "COME SI SA CHE È FINITA",
    ...mission.bar,
    "",
    "Due regole che valgono per tutte le missioni:",
    "- leggi lo stato della board ADESSO con `list_tasks`/`get_task`. Quello che",
    "  ricordi di una card è vecchio di almeno un turno;",
    "- coordini a livello testuale: sposti, commenti, ripriorizzi, crei card. Non",
    "  entri nel merito tecnico di un singolo task e non fai partire agenti da qui.",
  ].join("\n");
}
