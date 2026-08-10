/**
 * L'argv con cui si lancia la CLI di Claude — come FUNZIONE PURA.
 *
 * ── Perché esiste questo file ───────────────────────────────────────────────
 * Lo spawn di `claude-code.ts` passava una quindicina di flag scritte a mano in
 * mezzo alla funzione che monta il processo. Era il punto che si rompe a ogni
 * release della CLI — e l'unico senza una riga di test: nessun `*.test.ts` del
 * repo nominava `--include-partial-messages` o `--setting-sources`. Il giorno
 * che Anthropic rinomina una di quelle flag, ogni turno muore allo spawn, in
 * produzione, senza che la suite sia diventata rossa prima.
 *
 * Qui dentro non si legge l'ambiente e non si tocca il disco: tutto entra dai
 * parametri. È quello che rende l'elenco fotografabile da uno snapshot test —
 * cioè trasforma «quali flag passiamo» da abitudine a CONTRATTO, che si rompe
 * in CI invece che in prod.
 *
 * ── Cosa NON è ──────────────────────────────────────────────────────────────
 * Non è un posto dove decidere. Il modello, la modalità di permessi, il tier di
 * effort, il file MCP: li risolve chi chiama, con le sue regole (override del
 * topic, config del provider, default). Qui si mette solo in fila ciò che è già
 * stato deciso.
 */

/** Ciò che serve per montare l'argv di una sessione di chat persistente. */
export interface ClaudeSpawnArgsOptions {
  /** Modalità di permessi già risolta (autonomia del topic → config → default). */
  permissionMode: string;
  /** Id del modello già risolto (override del topic → config → default). */
  model: string;
  /**
   * Tier di effort già risolto, o null/undefined per non passare la flag.
   * Risolverlo qui vorrebbe dire leggere impostazioni: è deciso a monte.
   */
  effort?: string | null;
  /** Percorso del file di config MCP scritto per questa sessione. */
  mcpConfigPath: string;
  /** Il file MCP è l'INSIEME COMPLETO: la CLI non deve aggiungerci il fleet globale. */
  mcpStrict: boolean;
  /** Il nome del tool che fa da canale di permesso (`--permission-prompt-tool`). */
  permissionPromptTool: string;
  /** Il prompt di sistema che Topics appende. */
  appendSystemPrompt: string;
  /** L'uuid della sessione CLI (nostro se nuova, suo se ripresa). */
  claudeSessionId: string;
  /** Sessione mai vista: si CONIA con `--session-id`; altrimenti si RIPRENDE. */
  isNewSession: boolean;
  /**
   * Il valore di `ENABLE_TOOL_SEARCH` da IMPORRE alla sessione, o null per non
   * imporne nessuno (la CLI usa allora i suoi settings files).
   *
   * Serve una flag e non una variabile d'ambiente perché l'ambiente di processo
   * PERDE: `--setting-sources user,…` fa leggere `~/.claude/settings.json`, e
   * il suo blocco `env` vince su quello che passiamo allo spawn. Misurato:
   * forzare `ENABLE_TOOL_SEARCH=1` nell'ambiente ha prodotto un prefisso
   * byte-identico (cache_read pieno). `--settings` invece scavalca.
   */
  toolSearch?: string | null;
  /**
   * Vieta a QUESTA sessione di tirare immagini e video dentro il contesto con
   * `Read` (hook `PreToolUse`, exit 2 = rifiuto con la ragione al modello).
   *
   * Non è igiene, è la voce di spesa più grossa che abbiamo. Misurato il
   * 10/08 sui transcript degli agenti dispacciati: il 95% del volume sono
   * `tool_result`, di quelli il 97% è `Read`, e i `Read` grossi non sono
   * sorgenti — sono SCREENSHOT, ~132 kB l'uno. Su 12 task grossi, 7 colpiti,
   * il 25% del volume totale. E un'immagine letta non si paga una volta: sta
   * nel prefisso, che ogni turno successivo rilegge.
   *
   * Il giro che la produce è il nostro: il protocollo chiede uno screenshot
   * come prova di review, l'agente lo fa e poi lo RILEGGE per controllarlo.
   * Ma per consegnare la prova basta il path — non serve averla aperta.
   *
   * Vive qui e non nel prompt perché il prompt lo dice GIÀ (per il browser) e
   * gli agenti lo fanno lo stesso: un consiglio in mezzo a venti regole non è
   * un cancello. `--settings` scavalca i settings file, quindi non c'è modo di
   * disattivarlo dal disco per sbaglio.
   */
  blockImageReads?: boolean;
}

/**
 * Il comando dell'hook. `bun` c'è per definizione (ci gira il server). Niente
 * apostrofi nel messaggio: la stringa viaggia dentro apici singoli di shell.
 */
const IMAGE_READ_GUARD_CMD =
  'bun -e \'const d=JSON.parse(await Bun.stdin.text());'
  + 'const p=String(d?.tool_input?.file_path??"");'
  + 'if(/\\.(png|jpe?g|gif|webp|bmp|tiff?|heic|mp4|webm|mov|avi)$/i.test(p)){'
  + 'console.error("Rifiutato: non tirare immagini o video dentro il contesto. '
  + 'Pesano ~mezzo mega ognuna e restano nel prefisso, che OGNI turno successivo '
  + 'rilegge (misurato: il 25% del contesto dei task dispacciati). '
  + 'Per la prova di review basta il PATH, non serve averla aperta: '
  + 'update_task(preview_image=<path>) oppure comment_task(media=[<path>]). '
  + 'Se devi sapere COSA mostra, usa uno strumento che risponde in testo.");'
  + 'process.exit(2)}\'';

/** Il blocco `hooks` da passare a `--settings` quando il cancello e attivo. */
export const IMAGE_READ_GUARD_SETTINGS = {
  hooks: {
    PreToolUse: [
      { matcher: "Read", hooks: [{ type: "command", command: IMAGE_READ_GUARD_CMD }] },
    ],
  },
} as const;

/** Ciò che serve per un completamento usa-e-getta (auto-titolo, digest, SSE). */
export interface ClaudeOneshotArgsOptions {
  permissionMode: string;
  model: string;
  /**
   * Config MCP vuoto da fissare, o null quando la scrittura del file è fallita
   * (si ripiega sul comportamento storico: nessuno scoping).
   */
  emptyMcpConfigPath?: string | null;
}

/**
 * L'argv di una sessione di chat.
 *
 * Ogni flag porta con sé il motivo per cui c'è: senza, la prima che sembra
 * ridondante viene tolta da qualcuno che non sa cosa spegne.
 */
export function buildClaudeArgs(opts: ClaudeSpawnArgsOptions): string[] {
  return [
    "--print",
    "--permission-mode", opts.permissionMode,
    "--verbose",
    "--model", opts.model,
    // Tier di effort: lo decide il topic (migration 033) o il default di Topics.
    // Assente = non si passa la flag, e la CLI usa il suo.
    ...(opts.effort ? ["--effort", opts.effort] : []),
    "--setting-sources", "user,project,local",
    "--mcp-config", opts.mcpConfigPath,
    // Il config sopra è l'insieme COMPLETO: senza questo la CLI ci aggiunge il
    // fleet globale dell'utente (incluso chrome-devtools, ~1.2 GB di Chrome).
    ...(opts.mcpStrict ? ["--strict-mcp-config"] : []),
    // IL CANALE DI PERMESSO. Ogni modalità che non sia `bypassPermissions` si
    // ferma a chiedere, e in `--print` non c'è nessun prompt interattivo a cui
    // chiedere: senza questa flag la richiesta diventa un NO MUTO. Si passa
    // SEMPRE (vedi `lib/autonomy-mode.ts` — un flag solo non può
    // desincronizzarsi da sé stesso).
    "--permission-prompt-tool", opts.permissionPromptTool,
    // Gli schemi dei tool MCP viaggiano nel PREFISSO, cioè nella parte di prompt
    // che ogni richiesta del turno ripaga: un turno da 4 round-trip li paga 4
    // volte. Con il deferral la CLI manda i soli NOMI e carica lo schema quando
    // serve, via ToolSearch — nessuno strumento sparisce, cambia solo quando ne
    // arriva la descrizione.
    //
    // Misurato l'8/08/2026, stessa cwd, stesso config MCP (topics + exa +
    // context7 + gateway, 161 tool), CLI 2.1.226, prompt che non chiama tool:
    //     settings.json = "auto" ......  127.073 token di prefisso
    //     forzato a "1" ...............   36.167 token   (−90.906, −71,5%)
    // «auto» non deferiva NIENTE. E va imposto da qui, non dall'ambiente: vedi
    // `toolSearch` in `ClaudeSpawnArgsOptions` per il perché.
    // Un solo `--settings`: la CLI prende l'ULTIMO, quindi passarlo due volte
    // farebbe sparire in silenzio il primo dei due (il deferral degli schemi
    // vale −71,5% di prefisso: perderlo per un cancello sugli screenshot
    // sarebbe uno scambio in perdita).
    ...(opts.toolSearch || opts.blockImageReads
      ? ["--settings", JSON.stringify({
          ...(opts.toolSearch ? { env: { ENABLE_TOOL_SEARCH: opts.toolSearch } } : {}),
          ...(opts.blockImageReads ? IMAGE_READ_GUARD_SETTINGS : {}),
        })]
      : []),
    "--append-system-prompt", opts.appendSystemPrompt,
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    // Emette i `stream_event` (content_block_start/delta/stop) oltre agli
    // snapshot cumulativi: senza, un tool viene annunciato solo DOPO che il
    // modello ha finito di scriverne l'input, e la fase più lunga (10-30 s per
    // un Edit grosso) resta invisibile.
    "--include-partial-messages",
    // Prima volta: si CONIA l'uuid. Tutte le altre: si RIPRENDE, ed è quello
    // che restituisce al modello la memoria dei turni precedenti.
    ...(opts.isNewSession ? ["--session-id", opts.claudeSessionId] : ["--resume", opts.claudeSessionId]),
  ];
}

/**
 * L'argv di un completamento usa-e-getta.
 *
 * Diverge dallo spawn di chat in tre punti, tutti misurati:
 *  • niente `--verbose`: con `--output-format json` sposterebbe stdout
 *    sull'ARRAY di eventi e l'oggetto risultato sparirebbe;
 *  • config MCP VUOTO + `--strict-mcp-config`: altrimenti la CLI carica il
 *    fleet globale dell'utente per una riga di testo;
 *  • `--tools ""`: spenti i server esterni restavano gli schemi di tutti i tool
 *    integrati in testa al prompt — 40.566 → 9.292 token di prefisso (-77%) su
 *    CLI 2.1.220, stessa risposta. È variadico e si mangerebbe un prompt
 *    posizionale, ma qui il prompt entra da stdin.
 */
export function buildClaudeOneshotArgs(opts: ClaudeOneshotArgsOptions): string[] {
  return [
    "--print",
    "--permission-mode", opts.permissionMode,
    "--model", opts.model,
    "--setting-sources", "user,project,local",
    ...(opts.emptyMcpConfigPath ? ["--mcp-config", opts.emptyMcpConfigPath, "--strict-mcp-config"] : []),
    "--tools", "",
    "--output-format", "json",
  ];
}
