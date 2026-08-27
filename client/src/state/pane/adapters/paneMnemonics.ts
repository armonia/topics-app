/**
 * paneMnemonics — la lettera di ogni riga del menu "New…".
 *
 * A menu aperto un tasto NUDO attiva la sua riga: ⌘N poi B = nuovo browser.
 * Le lettere stanno QUI e non accanto alle voci per due invarianti che, se si
 * rompono, rendono la funzione peggio che inutile:
 *
 *  1. **La lettera appartiene alla RIGA, non al sottoinsieme visibile.**
 *     `availableTypes` filtra i singleton già presenti nel gruppo (un gruppo con
 *     un Git aperto non offre Git). Se le lettere si calcolassero sul visibile,
 *     nascondere Git sposterebbe quella di Files e la memoria muscolare
 *     morirebbe a ogni apertura. Il set visibile è sempre un SOTTOINSIEME di
 *     questa mappa: una lettera può mancare, mai cambiare di posto.
 *
 *  2. **Una voce nuova non ruba mai una lettera esistente.** La mappa è
 *     congelata; la regola sotto serve solo a PROPORRE la lettera di chi arriva.
 *
 * Regola per assegnarne una nuova, nell'ordine:
 *   a. iniziale dell'etichetta, se libera nello stesso scope;
 *   b. altrimenti la prima lettera libera dell'etichetta, da sinistra, che non
 *      sia l'iniziale riservata di un'altra voce (Codex → X, `Code·x`);
 *   c. altrimenti la prima libera dell'id di riga;
 *   d. altrimenti NESSUNA lettera — la riga resta raggiungibile con frecce e
 *      mouse, e il test qui accanto segnala che serve una scelta a mano.
 *
 * La lettera è SEMPRE contenuta nell'etichetta O nell'id di riga (asserito dal
 * test): così la resa a sottolineatura resta possibile come ripiego dove la
 * lettera è nell'etichetta, e nel caso (c) resta comunque una lettera che la
 * riga PRONUNCIA — mai una convenzione arbitraria da imparare a memoria.
 */

/** Gli id di riga del menu "New…". Non sono `PaneType`: `terminal` produce
 *  QUATTRO righe (gli agenti), e `kanban`/`board` sono la stessa riga con due
 *  etichette in due scope diversi. */
export type AddMenuItemId =
  | 'new-chat'
  | 'shell'
  | 'claude-code'
  | 'codex'
  | 'opencode'
  | 'kimi-code'
  | 'browser'
  | 'git'
  | 'files'
  | 'kanban'
  | 'board'
  | 'dashboard'
  | 'cron'
  | 'profile'
  | 'open-project';

export const ADD_MENU_MNEMONICS: Record<AddMenuItemId, string> = {
  // La riga si chiama «Chat», non «New Chat»: il verbo lo dice il menu, e ogni
  // altra riga e' un sostantivo secco. C resta all'agente di DEFAULT (Claude
  // Code, il piu' aperto), quindi la regola scorre — ma non alla H di c-H-at:
  // scorre fino al caso (c), la prima libera dell'ID di riga, `new-chat` → N.
  // Ed e' la lettera giusta anche per una ragione che l'etichetta non poteva
  // dare: il menu lo apre ⌘N, e N e' la cosa che ⌘N crea per default. La mano
  // che ha gia' premuto N con il meta preme N di nuovo senza pensarci.
  'new-chat': 'N',
  // T e' l'iniziale di «Terminale» ed e' libera: caso (a), il piu' semplice.
  shell: 'T',
  // C è dell'agente DI DEFAULT. Codex prende la X di `Code·x`: è la lettera che
  // dice Codex e nient'altro, e lascia C dove l'utente se la aspetta.
  'claude-code': 'C',
  codex: 'X',
  opencode: 'O',
  // K is the initial of "Kimi Code" and it is free: case (a).
  'kimi-code': 'K',
  // B a Browser e non a Board: Browser esiste in ENTRAMBI gli scope, Board in
  // uno solo. A parità di iniziale vince la voce che si incontra ovunque.
  browser: 'B',
  git: 'G',
  files: 'F',
  kanban: 'D',
  board: 'D',
  // Dashboard e Cron arrivano dal dropdown «Topics ▾», dove non avevano
  // lettere. Entrambe le iniziali sono già di qualcun altro nello scope
  // standalone — D è di Board, C di Claude Code — quindi vale il caso (b): la
  // prima libera dell'etichetta, da sinistra. d-A-shboard → A, c-R-on → R.
  // Nessuna delle due è l'iniziale riservata di un'altra voce, e restano
  // dentro l'etichetta, quindi la sottolineatura resta possibile.
  dashboard: 'A',
  cron: 'R',
  // Profilo scorre fino alla QUINTA lettera, e ogni salto ha un motivo: P è di
  // «Progetto…», R di Cron, O di opencode — occupate nello stesso menu — e la F
  // è l'iniziale RISERVATA di Files, che qui non compare ma che non si scippa
  // (è la clausola del caso (b), la stessa per cui Codex ha preso la X). Resta
  // la I di pro-f-I-lo: dentro l'etichetta, quindi sottolineabile.
  profile: 'I',
  // UNA riga sola per il progetto: «Apri» e «Crea» chiamavano la stessa
  // funzione (`openProjectPicker`) e il pannello di sistema si intitola gia'
  // «Apri / Crea progetto» — erano due voci per un solo comportamento.
  'open-project': 'P',
};

/** Le righe che possono comparire insieme, per scope. Il test di unicità gira
 *  su questi insiemi, non sull'unione: `kanban` e `board` condividono la D
 *  proprio perché non si incontrano mai.
 *
 *  `cron` è elencata qui benché l'installazione possa non offrirla (richiede
 *  OpenClaw, vedi `PaneConfig.requires`): l'insieme dichiara le righe POSSIBILI
 *  in uno scope, ed è esattamente sul possibile che l'unicità va garantita —
 *  una lettera che collide solo dove OpenClaw è configurato sarebbe un bug che
 *  metà delle installazioni non vede mai. Stessa ragione per cui la mappa non
 *  si calcola sul visibile (invariante 1 in testa al file). */
export const ADD_MENU_ROWS_BY_SCOPE: Record<'project' | 'standalone', readonly AddMenuItemId[]> = {
  project: ['new-chat', 'shell', 'claude-code', 'codex', 'opencode', 'kimi-code', 'browser', 'git', 'files', 'kanban'],
  standalone: ['new-chat', 'shell', 'claude-code', 'codex', 'opencode', 'kimi-code', 'browser', 'board', 'dashboard', 'cron', 'profile', 'open-project'],
};
