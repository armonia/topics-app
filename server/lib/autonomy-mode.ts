/**
 * Il livello di autonomia di una chat → la modalità di permessi della CLI.
 *
 * ── Il fatto ────────────────────────────────────────────────────────────────
 * `AutonomyLevel` (`ask | auto-apply | yolo`) esiste nel modello dati da sempre,
 * si salva sul topic… e non era collegato a niente: **ogni** chat partiva con
 * `bypassPermissions`, qualunque cosa dicesse l'impostazione. Il selettore non
 * c'era e il valore non aveva effetto — cioè la promessa peggiore che
 * un'interfaccia possa fare.
 *
 * ── La tabella di verità, MISURATA ──────────────────────────────────────────
 * Stesso prompt, stessa cwd, `--print`, server MCP locale. Identica su CLI
 * 2.1.221 e 2.1.224 — quindi NON è una regressione della CLI:
 *
 *   modalità            Bash   Write dentro   Write fuori   tool MCP
 *   acceptEdits          OK         OK          NEGATO       NEGATO
 *   auto                 OK       NEGATO        NEGATO       NEGATO
 *   bypassPermissions    OK         OK            OK           OK
 *   dontAsk/manual/plan  OK       negato        negato       negato
 *
 * ── L'errore da non ripetere ────────────────────────────────────────────────
 * Questo blocco diceva, fino al 07/08/2026: «`acceptEdits` → esegue (provato
 * con un comando shell). Nessun blocco.» La prova c'era davvero — ed era la
 * prova sbagliata: `Bash` è **l'unica capacità che passa in tutte e sei le
 * modalità**, quindi quel probe non poteva fallire. Sotto, `acceptEdits`
 * negava in silenzio ogni tool MCP e ogni scrittura fuori dalla cwd, e la
 * migration 081 — che porta tutti su `auto-apply` per uscire da plan mode — ha
 * esteso quel silenzio a 515 topic su 518. Un probe che esercita una capacità
 * che non può fallire non è una prova: è una rassicurazione.
 *
 * ── Cos'è cambiato adesso ───────────────────────────────────────────────────
 * «Negato» qui sopra voleva dire NEGATO E MUTO: la CLI chiedeva il permesso su
 * un canale che Topics non gestiva, e l'unica traccia era un messaggio che
 * invitava a concedere ciò che nessuno poteva chiedere. Da oggi quel canale
 * esiste — `--permission-prompt-tool mcp__topics__approval_prompt`, vedi
 * `server/lib/permission-bridge.ts` — quindi «chiede» vuol dire davvero
 * chiede, con un pannello in chat. Le righe della tabella restano vere; cambia
 * che ora si può rispondere.
 *
 * `manual`, `auto` e `dontAsk` restano comunque fuori: `dontAsk` nega senza
 * consultare nessuno (nemmeno il canale), e `auto`/`manual` chiedono anche per
 * le modifiche dentro la cwd — cioè trasformerebbero ogni turno in una fila di
 * pannelli. Non è una mancanza di canale: è che non descrivono nessuno dei tre
 * livelli che l'interfaccia offre.
 *
 * ── Il default non cambia ───────────────────────────────────────────────────
 * Un topic senza livello scelto continua ad avere `bypassPermissions`. Cambiare
 * il default avrebbe zittito le chat esistenti di chi non ha mai toccato
 * l'impostazione — una migrazione silenziosa travestita da funzione nuova.
 */

/**
 * I livelli (`ask | auto-apply | yolo`) vivono in `shared/types.ts` e SOLO lì:
 * chi ha bisogno del tipo lo importa da quella parte. Fino al 05/08/2026
 * questo file ne teneva una copia letterale — due sorgenti di verità libere
 * di divergere in silenzio, visto che le funzioni qui sotto prendono `string`
 * e mandano al default qualunque livello non riconosciuto. Un livello aggiunto
 * di là sarebbe passato di qua senza un solo errore di compilazione.
 */

/** La modalità con cui si parte quando il topic non ha scelto. */
export const DEFAULT_PERMISSION_MODE = "bypassPermissions";

/**
 * La modalità di permessi per un livello. Un valore assente o sconosciuto torna
 * il default: un livello scritto male non deve poter cambiare come lavora una
 * chat, e soprattutto non deve poterla bloccare.
 */
export function permissionModeForAutonomy(level: string | null | undefined): string {
  switch (level) {
    case "ask":
      // «Chiedi prima» in modalità print vuol dire: proponi e non toccare.
      return "plan";
    case "auto-apply":
      return "acceptEdits";
    case "yolo":
      return "bypassPermissions";
    default:
      return DEFAULT_PERMISSION_MODE;
  }
}

/**
 * Il nome del tool MCP che fa da CANALE DI PERMESSO.
 *
 * È il bridge che Topics attacca già a ogni sessione, quindi non c'è niente da
 * installare: `--permission-prompt-tool` dirotta lì la richiesta che altrimenti
 * finirebbe su un prompt interattivo che in `--print` non esiste. Il nome vive
 * qui, accanto alla mappatura, perché è la stessa decisione: quale modalità
 * chiede, e a chi.
 */
export const PERMISSION_PROMPT_TOOL = "mcp__topics__approval_prompt";

/**
 * Questa modalità può fermarsi a chiedere?
 *
 * Vale per tutte tranne `bypassPermissions`. Serve allo spawn per decidere se
 * passare `--permission-prompt-tool`: senza, una modalità che chiede nega e
 * basta, ed è precisamente il guasto del 7 agosto. Un solo posto dove è scritto
 * «questa chiede», così non può capitare che una modalità nuova entri nella
 * mappatura e resti fuori dal canale.
 */
export function permissionModeAsks(mode: string | null | undefined): boolean {
  return !!mode && mode !== "bypassPermissions";
}

/**
 * I pezzi di `argv` che collegano il canale. SEMPRE, in ogni modalità.
 *
 * ── Perché non è condizionato, pur servendo solo dove si chiede ─────────────
 * Il primo taglio lo passava solo quando `permissionModeAsks(mode)`, e in
 * parallelo diceva al bridge di pubblicare `approval_prompt` solo in quel caso
 * — due flag che dovevano restare accoppiati. Sono bastati dieci minuti per
 * scoprire come si rompe: una configurazione MCP scritta a mano senza il
 * secondo flag, e la CLI ha risposto
 *
 *     MCP tool mcp__topics__approval_prompt (passed via --permission-prompt-tool)
 *     not found
 *
 * su OGNI richiesta di permesso. Cioè un guasto peggiore di quello che stiamo
 * chiudendo: prima moriva muto, così muore rumoroso e su tutto.
 *
 * Verificato che passarlo dove non serve non costa niente: in
 * `bypassPermissions` la CLI non chiede mai, quindi non lo chiama — e continua
 * comunque a toglierlo dall'elenco che il modello vede (provato: `init` non lo
 * elenca, e il turno finisce regolarmente). Un flag solo non può
 * desincronizzarsi da sé stesso.
 */
export function permissionPromptArgs(_mode?: string | null): string[] {
  return ["--permission-prompt-tool", PERMISSION_PROMPT_TOOL];
}

/**
 * Il turno va in PIANO?
 *
 * Il piano si chiedeva in due modi, e non erano lo stesso: un interruttore nel
 * composer che iniettava una richiesta nel prompt (`planModeContent`) — che il
 * modello poteva ignorare, tenuta in localStorage, mai sincronizzata — e il
 * livello di autonomia `ask`, che passa `--permission-mode plan` alla CLI, dove
 * i file non si possono proprio scrivere. Sullo stesso turno potevano
 * contraddirsi: prompt «non toccare niente», permessi «fai pure».
 *
 * L'interruttore è sparito. Il blocco di prompt no — è quello che dà al piano
 * il formato che l'app sa poi leggere — e lo accende il livello di autonomia.
 *
 * Il flag per-turno resta accettato perché i chiamanti headless (dispatcher,
 * bridge MCP) non hanno un composer da cui premere niente.
 */
export function planModeFor(opts: { turnFlag?: boolean; autonomy?: string | null }): boolean {
  return opts.turnFlag === true || opts.autonomy === "ask";
}

/** Cosa succede davvero, in una riga — per l'interfaccia e per il registro. */
export function describeAutonomy(level: string | null | undefined): string {
  switch (level) {
    case "ask":
      return "propone un piano e aspetta il tuo ok: non tocca file né esegue comandi";
    case "auto-apply":
      return "applica le modifiche ai file da sé";
    case "yolo":
      return "fa tutto senza chiedere";
    default:
      return "come «fa tutto senza chiedere» (nessun livello scelto)";
  }
}
