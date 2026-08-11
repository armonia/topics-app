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
   * Manda il CATALOGO delle skill al modello coi soli NOMI, senza descrizioni
   * (`skillListingMaxDescChars: 1` → `- nome: …`).
   *
   * Le skill dell'utente arrivano da `--setting-sources user,project,local`, che
   * sta lì per altro — il blocco `env` di `~/.claude/settings.json`, dove vive
   * fra le altre cose l'URL del provider: toglierlo per alleggerire il prefisso
   * porterebbe via la configurazione, non solo l'elenco.
   *
   * Quindi si toglie il CATALOGO, non la capacità: i nomi restano, `Skill` resta
   * chiamabile, e il testo della skill si carica quando parte — la stessa forma
   * del deferral degli schemi MCP qui sotto.
   *
   * Misurato il 10/08/2026 (CLI 2.1.226, opus-5[1m], stessa cwd e stesso config
   * MCP, prompt che non chiama tool), argv del dispatch vero:
   *     catalogo intero .......  37.867 token di prefisso   (elenco 14.067 B)
   *     soli nomi .............  33.657 token   (−4.210)    (elenco  2.130 B)
   * È prefisso: un task da ~40 turni lo ripaga ogni volta.
   *
   * Vale per i soli agenti del board: una chat è guidata da una persona che le
   * skill le sceglie leggendo cosa fanno, un agente dispacciato ha già il suo
   * compito scritto nel task.
   */
  slimSkillListing?: boolean;
  /**
   * Toglie dal registro gli schemi dei tool integrati che un agente del board
   * non può usare — e che il differimento NON tocca, perché la CLI li tiene
   * inline (`--disallowed-tools`).
   *
   * ── Perché è LA voce, e non il catalogo delle skill ─────────────────────────
   * Il prefisso, decomposto per ablazione appaiata il 2026-08-11
   * (`scripts/mcp-cap-bench/prefix-ladder.ts`, CLI 2.1.227, HOME reale, rumore
   * di fondo fra due corse della base: 0-4 token). Su **haiku-4.5**, base
   * 32.126 token:
   *
   *     Workflow ................  6.024 token   18,8%
   *     Artifact ................  3.171          9,9%
   *     Task (sotto-agenti) .....  3.128          9,7%   ← NON si tocca
   *     CLAUDE.md dell'utente ...  2.229          6,9%   ← NON si tocca
   *     catalogo skill ..........  1.683          5,2%   ← già tolto (slimSkillListing)
   *     ReportFindings ..........    608          1,9%
   *     ListAgents ..............    257          0,8%
   *     elenco degli agenti .....      0                 (`--agents {}` non morde)
   *     prompt di Topics ........     71          0,2%
   *
   * Cioè il pezzo più grosso del prefisso è la DESCRIZIONE DI UN TOOL SOLO. Il
   * catalogo delle skill, che era la leva conosciuta, ne vale un settimo.
   *
   * ── E il modello cambia il numero, non il verso ────────────────────────────
   * Le stesse ablazioni su **opus-5[1m]**, cioè il modello con cui gli agenti
   * del board girano davvero (base 34.845 token): `Workflow` 7.856 (22,5%), e
   * il taglio intero −17.457, **il 50,1% del prefisso**. La CLI manda ai
   * modelli piccoli descrizioni più corte, quindi una misura fatta su haiku
   * SOTTOSTIMA il risparmio di ~un terzo. Il banco, girato su opus, ha letto
   * 17.416 token per richiesta: 41 token di scarto dalla previsione della
   * scala, su 13 richieste di un turno vero.
   *
   * ── Perché questi quattro e non altri ──────────────────────────────────────
   * Il criterio non è «pesa tanto», è «l'agente non lo può usare comunque»:
   *  • `Workflow` — la sua stessa descrizione dice di NON chiamarlo senza un
   *    consenso esplicito dell'umano nel prompt («ultracode», o la richiesta a
   *    parole di orchestrare). Un agente dispacciato riceve un task, non una
   *    conversazione: quel consenso non può arrivargli. 6.024 token per un tool
   *    vietato per costruzione.
   *  • `Artifact` — Topics non rende gli artefatti da nessuna parte (nessun
   *    riferimento nel client né nel server): la consegna di un agente sono le
   *    sue TAB e i suoi FILE.
   *  • `ReportFindings` — serve solo alla code review ospitata dalla UI di
   *    Claude Code, che qui non c'è; senza, i findings tornano testo.
   *  • `ListAgents` — elenca i destinatari di `SendMessage`, che è già differito.
   * Restano `Task` e `CLAUDE.md`, che pesano quanto Artifact e sono esattamente
   * ciò che rende capace l'agente: tagliarli sposta il costo sui turni sprecati
   * invece di toglierlo.
   *
   * Su haiku, misurato insieme a `slimSkillListing`: 32.123 → 20.383 token di
   * prefisso, −11.742 a ogni richiesta, e i pezzi sommano (6.024 + 3.171 + 608
   * + 257 + 1.683 = 11.743): l'ablazione è additiva, non c'è doppio conteggio.
   * Su opus, 34.845 → 17.388: **−17.457 a OGNI richiesta, −50,1%**.
   *
   * Un solo argomento separato da virgole, non un variadico: `--disallowed-tools
   * A B C` in mezzo all'argv si mangerebbe la flag successiva.
   */
  trimUnusedTools?: boolean;
  /**
   * Il TETTO in token di un singolo risultato di tool MCP, o null per lasciare
   * quello della CLI (`MAX_MCP_OUTPUT_TOKENS`, default **25.000**).
   *
   * Sopra la soglia la CLI non tronca alla cieca: scrive il risultato intero in
   * un file e in contesto lascia il puntatore («Output has been saved to …»,
   * con le istruzioni per rileggerlo a fette o con jq). Cioè fa GIÀ «estratto +
   * riferimento» — il difetto non è il meccanismo, è che 25.000 token sono
   * ~100 kB a chiamata, cioè una soglia che nella pratica non scatta mai.
   *
   * E un risultato di tool non si paga una volta: resta nella finestra e ogni
   * chiamata successiva lo rispedisce. Misurato l'11/08 sulla chat
   * `topic:4c8de758` (48 messaggi, 29,5M token di prompt, $23,86): il 65% del
   * payload dei tool erano 20 chiamate a un tool di ricerca web MCP, 21,3 kB
   * l'una. Nessuna di esse toccava il tetto da 25.000.
   *
   * Il numero viene da una simulazione sui 15.464 risultati MCP dei transcript
   * reali (138,5 MB in tutto):
   *     tetto 25.000 token (~100 kB) ....  −27,8% di byte,  2,8% su file
   *     tetto  8.000 token (~ 32 kB) ....  −60,6% di byte,  6,0% su file
   *     tetto  4.000 token (~ 16 kB) ....  −73,6% di byte,  9,2% su file
   *     tetto  2.500 token (~ 10 kB) ....  −80,5% di byte, 11,4% su file
   * 4.000 è il ginocchio: prende i tre quarti del volume toccando una chiamata
   * su undici, e quella che tocca non la perde — la sposta su disco.
   *
   * Perché non è un cancello come `blockImageReads`: qui il caso legittimo
   * («l'utente CHIEDE il contenuto della pagina») non va rotto. Il taglio non
   * cade su ciò che il turno corrente sta leggendo, cade su ciò che resterebbe
   * in contesto DOPO essere stato usato — e resta rileggibile.
   */
  mcpOutputTokens?: number | null;
}

/**
 * I tool integrati che `trimUnusedTools` toglie dal registro. Sta qui e non
 * dentro la funzione perché è la LISTA che il banco deve poter confrontare col
 * registro dei due bracci: un taglio che la CLI ignorasse in silenzio darebbe
 * un risparmio di zero travestito da configurazione corretta.
 */
export const TRIMMED_TOOLS = ["Workflow", "Artifact", "ReportFindings", "ListAgents"] as const;

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
    // Gli schemi dei tool integrati che il differimento NON tocca. Un solo
    // argomento a virgole, e non `A B C`: la flag è variadica e in mezzo
    // all'argv si porterebbe via quella dopo. Verificato che le due forme
    // danno lo stesso taglio (−11.742 contro −11.743): la virgola non è
    // ignorata in silenzio. Il perché dei quattro nomi sta accanto a
    // `trimUnusedTools` in `ClaudeSpawnArgsOptions`.
    ...(opts.trimUnusedTools ? ["--disallowed-tools", TRIMMED_TOOLS.join(",")] : []),
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
    // vale −71,5% di prefisso: perderlo per l'elenco delle skill sarebbe uno
    // scambio in perdita). Chi aggiunge una leva la aggiunge QUI DENTRO.
    ...(opts.toolSearch || opts.slimSkillListing || opts.mcpOutputTokens
      ? ["--settings", JSON.stringify({
          ...(opts.toolSearch || opts.mcpOutputTokens
            ? {
                env: {
                  ...(opts.toolSearch ? { ENABLE_TOOL_SEARCH: opts.toolSearch } : {}),
                  // Il tetto per singolo risultato MCP. Sta nel blocco `env` e
                  // non nell'ambiente del processo per la stessa ragione di
                  // `ENABLE_TOOL_SEARCH`: `--setting-sources user` fa vincere
                  // il blocco `env` di `~/.claude/settings.json` su ciò che
                  // passiamo allo spawn. La CLI vuole una stringa.
                  ...(opts.mcpOutputTokens
                    ? { MAX_MCP_OUTPUT_TOKENS: String(opts.mcpOutputTokens) }
                    : {}),
                },
              }
            : {}),
          // 1 e non 0: lo zero non è un valore che la CLI accetta come «nessuna
          // descrizione» (misurato — l'elenco resta intero), 1 tronca a `…`.
          ...(opts.slimSkillListing ? { skillListingMaxDescChars: 1 } : {}),
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
