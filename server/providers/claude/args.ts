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
}

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
