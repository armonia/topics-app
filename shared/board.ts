/**
 * Contratto della board: UNA dichiarazione, letta dai due lati del filo.
 *
 * Fino al 29/07 questi tipi esistevano due volte — `server/services/tasks.ts`
 * + `server/services/review-checks.ts` + `server/services/dispatch-capacity.ts`
 * da una parte, `client/src/lib/board.ts` dall'altra — e la copia del client
 * era già indietro: `BoardSettings` non conosceva `dispatchRetryCap` né
 * `dispatchRetryBackoffS`, campi che il server SCRIVE nella riga
 * `board_settings` e RIMANDA in ogni GET. Il client li riceveva e li buttava,
 * e una PATCH costruita dal suo tipo li avrebbe silenziosamente azzerati.
 *
 * Anche l'elenco degli stati era scritto tre volte (il tipo lato client, il
 * suo `TASK_STATUSES`, e la `const STATUSES` privata del server). Qui è UNO:
 * il tipo DERIVA dal valore, quindi aggiungere una colonna alla kanban senza
 * aggiornare la validazione non compila più.
 *
 * `shared/` è l'unica cartella che entrambi i progetti TS possono includere
 * senza violare il confine composite (TS6307) — vedi `shared/ws-outbound.ts`.
 */

/** L'elenco degli stati. Il tipo lo segue: una sola verità, non due gemelle. */
export const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'] as const;

/**
 * Tetto al fan-out (agenti paralleli sullo stesso task). Cinque, non "quanti ne
 * vuoi": ogni tentativo è un agente vero, con il suo worktree e il suo costo, e
 * oltre questo numero il confronto smette di essere leggibile da un umano prima
 * ancora che la macchina si arrenda. Letto dal clamp del server, dal dispatcher
 * e dal selettore nel pannello impostazioni — una sola verità.
 */
export const MAX_FANOUT = 5;

export type TaskStatus = (typeof TASK_STATUSES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Identità di una board — la funzione che la genera, in UN posto solo.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Il `projectId` della board, derivato dal path assoluto del progetto:
 * `<basename della cartella>-<hash a 6 cifre>`.
 *
 * Fino al 18/08 questa funzione esisteva in QUARANTANOVE copie: il servizio
 * (`server/services/tasks.ts:projectIdForPath`), una closure dentro
 * `server/routes/topics.ts:getProjectIdForTopic`, il client
 * (`client/src/lib/board.ts:boardIdForPath`), 45 spec E2E e il bench di
 * concorrenza (`scripts/bench/concurrency.ts:boardId`) — quasi tutte con un
 * commento che dichiarava «BYTE-IDENTICAL» alle altre. Il commento era l'unica
 * cosa che le teneva insieme: tre test inchiodavano il server, il router e il
 * client sullo stesso vettore, ma la closure di `topics.ts`, le 45 spec e il
 * bench non erano coperti da niente. Il bench era già derivato — gli mancava il
 * ripiego `|| 'project'` — e nessuno se n'era accorto perché lo chiama solo su
 * cartelle di `mkdtemp`. Una divergenza lì non esplode: scrive i task sotto un
 * `projectId` che nessuna board legge, e la colonna resta vuota senza un errore
 * da nessuna parte.
 *
 * Hash djb2 a 32 bit con segno (variante `h * 33 + c` scritta `(h<<5)-h+c`),
 * base36 del valore assoluto, troncato a 6 caratteri. NON cambiarlo: ogni
 * modifica orfanerebbe ogni riga `tasks` già scritta nel DB.
 *
 * Parente ma NON la stessa cosa di `shared/project-keys.ts:projectHash`, che
 * gira lo stesso djb2 sulle chiavi `ui_state` ma restituisce l'hash intero e
 * senza prefisso: identità diversa, store diverso, resta separata.
 */
export function projectIdForPath(projectPath: string): string {
  const parts = projectPath.replace(/\/+$/, '').split('/');
  const dirName = parts[parts.length - 1] || 'project';
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash) + projectPath.charCodeAt(i);
    hash |= 0;
  }
  return dirName + '-' + Math.abs(hash).toString(36).slice(0, 6);
}

// ─────────────────────────────────────────────────────────────────────────────
// Evento di transizione (`kind='status'`) — il formato, in UN posto solo.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Separatore fra la transizione e la sua RAGIONE dentro `content`.
 *
 * Il contenuto di un evento di stato era `from→to` e basta, e tre lettori lo
 * spacchettavano ognuno a modo suo: una `LIKE '%in_progress'` in SQL (l'inizio
 * del turno, che arma il gate della consegna muta), un `endsWith("in_progress")`
 * nel dispatcher, e uno `split('→')[1]` nel client. Appendere una ragione senza
 * toccarli avrebbe rotto tutti e tre in silenzio — il gate avrebbe letto un
 * turno più vecchio e una consegna muta sarebbe passata. Quindi il formato ha
 * un writer solo (`formatStatusEvent`) e un parser solo (`parseStatusEvent`).
 */
export const STATUS_EVENT_SEP = ' · ';

/** Quanto può essere lunga la ragione: è una riga di timeline, non un thread. */
export const STATUS_EVENT_REASON_MAX = 160;

/** `from→to` (+ ` · ragione`). Unico posto che SCRIVE il formato. */
export function formatStatusEvent(from: string, to: string, reason?: string | null): string {
  // A capo e spazi doppi diventano uno spazio: la riga della timeline è una
  // riga sola, e un `\n` a metà romperebbe anche il `title` del tooltip.
  const clean = (reason ?? '').replace(/\s+/g, ' ').trim().slice(0, STATUS_EVENT_REASON_MAX).trim();
  return clean ? `${from}→${to}${STATUS_EVENT_SEP}${clean}` : `${from}→${to}`;
}

/**
 * `content` → transizione. `null` se non è un evento di stato (nessuna freccia).
 * Legge la destinazione FINO al separatore, così una ragione che contiene una
 * freccia o un altro `·` non sposta il confine.
 */
export function parseStatusEvent(content: string): { from: string; to: string; reason: string | null } | null {
  if (typeof content !== 'string') return null;
  const arrow = content.indexOf('→');
  if (arrow < 0) return null;
  const rest = content.slice(arrow + 1);
  const sep = rest.indexOf(STATUS_EVENT_SEP);
  const reason = sep < 0 ? null : rest.slice(sep + STATUS_EVENT_SEP.length).trim() || null;
  return {
    from: content.slice(0, arrow).trim(),
    to: (sep < 0 ? rest : rest.slice(0, sep)).trim(),
    reason,
  };
}

/** La transizione è ENTRATA in questo stato? (il "quando inizia il turno"). */
export function statusEventEnters(content: string, status: TaskStatus): boolean {
  return parseStatusEvent(content)?.to === status;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anteprima di consegna — la regola, in UN posto solo.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La card mostra l'anteprima con `object-cover object-top`: ciò che eccede il
 * riquadro non viene rimpicciolito, viene TAGLIATO in basso. Questa è la soglia
 * oltre la quale «ho messo l'anteprima» e «il reviewer vede la cosa» smettono
 * di coincidere. Vive qui perché la stessa cifra la cita il testo del protocollo
 * (`PREVIEW_RULE`) e la misura il gate di `promoteReviewPreview`.
 *
 * ERA `144 / 268` = 0.537, e quel numero era vero in UNA sola configurazione.
 * Il tetto sulla card era `max-h-36`, un'altezza ASSOLUTA in 144px, dentro una
 * colonna la cui larghezza è un INTERVALLO (Card.tsx `widthCls`: lavoro
 * 18→26rem, review 22→44rem). Il rapporto che il reviewer vede davvero è
 * 144/larghezza, quindi scendeva man mano che la colonna cresceva — misurato:
 * 0.58 nella colonna di lavoro stretta, 0.30 nella colonna review a 1280,
 * 0.22 su un board molto largo. Proprio la review — la colonna su cui si
 * decide — tagliava il doppio di quanto il protocollo dichiarasse.
 *
 * Ora il tetto è espresso come RAPPORTO della larghezza vera del riquadro
 * (unità di container query, `70cqw`), quindi la soglia è la stessa a ogni
 * larghezza di colonna e su mobile. La miniatura RIEMPIE la card: nessun tetto
 * in px sul riquadro, perché una fascia vuota a destra in una colonna larga si
 * legge come un difetto (Attilio, 12/08). Il prezzo è dichiarato: l'altezza
 * cresce col rapporto, cioè 0.7 x 474 = 332px in review a 1280.
 * È anche la stessa soglia che misura il gate di
 * promozione: due numeri diversi per la stessa immagine erano un odore, non
 * una politica.
 * @see client/src/components/Board/PreviewMedia.tsx
 */
export const PREVIEW_CARD_MAX_RATIO = 0.7;

/**
 * PERCHE' NON ESISTE UN SECONDO TETTO PER LA PORTA MANUALE.
 *
 * Il 17/08 ho aggiunto un cancello sulla FORMA a `acceptPreview`: un'anteprima
 * piu' alta che larga occupa la card e spinge giu' il testo (misurato: 255x397
 * alta 330px su una card di 798). Il fatto era vero; il rimedio no, e l'ha
 * detto la suite - due tentativi, due rossi su `board-preview-cap.spec.ts`.
 *
 * Prima con 0,7: rifiutava anche una QUADRATA. Poi con 1,2: rifiutava una
 * 900x1800, che quella spec tiene fra i casi buoni col commento «quella che il
 * tetto deve tagliare».
 *
 * La ragione e' che il riquadro RITAGLIA gia', sempre (`object-cover
 * object-top` + `max-h-[70cqw]` in `PreviewMedia.tsx`), ed e' il comportamento
 * dichiarato. Un cancello che rifiuta cio' che il layout sa gestire non
 * protegge niente: duplica una decisione presa altrove e la contraddice.
 *
 * Il rifiuto per forma resta dov'era: nella promozione AUTOMATICA
 * (`tooTallForCard`), che sceglie da sola cosa mettere sulla card e nel dubbio
 * non sceglie. La porta manuale e' un gesto esplicito, e a un gesto esplicito
 * si risponde mostrando, non rifiutando.
 */


/**
 * Come si sceglie l'anteprima di una consegna. **Questa stringa è la copia
 * canonica**: la citano l'envelope di kickoff, quello di resume, la descrizione
 * di `preview_image` nello schema del tool MCP, il braccio `board-sim` del
 * benchmark e §4 di `docs/board-protocol.md`.
 *
 * Prima erano cinque testi liberi di divergere, e divergevano: due soli rami,
 * entrambi su UI («statica» → screenshot, «dinamica» → video). Una consegna che
 * non ha nessuna superficie renderizzata — un piano, un'architettura, una
 * migrazione — non sta in nessuno dei due, così cadeva nel ramo «statica» e
 * l'agente FOTOGRAFAVA il documento: la card del piano-amicizia aveva come
 * anteprima l'immagine dell'intero piano, illeggibile a 268px.
 *
 * Da qui i tre rami e, soprattutto, criteri che si possono MISURARE invece di
 * aggettivi ("statica", "dinamica") su cui due agenti danno due risposte.
 * `server/services/task-dispatcher.test.ts` verifica che le copie siano ancora
 * la stessa stringa.
 */
// allow-emdash-block: da qui alla fine dei cancelli è il BRIEFING dell'agent,
// un prompt letto da un modello e non un testo della app.
export const PREVIEW_RULE = [
  "REVIEW EVIDENCE = a DURABLE PREVIEW on the task — update_task(preview_image=<absolute path under ~/.topics/media/ or inside the task workspace; empty string = clear it>), which becomes the image on the board card and in the drawer. Three branches, and what picks one is the criterion, not habit:",
  `· SCREENSHOT .png — the delivery HAS a rendered surface that fits in one frame. Capture it at viewport ≤1440×900 and with height/width ≤ ${PREVIEW_CARD_MAX_RATIO.toFixed(2)} (the card crops the excess off the bottom instead of shrinking it). Never a full-page shot.`,
  "· VIDEO .webm/.mp4 ≤20s — proving the delivery takes TWO OR MORE STATES (appears, stays, disappears; scroll, open/close, streaming, a multi-step flow): a still screenshot cannot prove a behaviour. A short Playwright clip (`recordVideo: { dir }` on the context) or, if the project has spec-flow, the scenario's .webm.",
  "· DIAGRAM .svg — the delivery has NO rendered surface (a plan, an architecture, a protocol, a migration): you DRAW the structure — boxes, arrows, five words per node — you do not photograph the document.",
  "A TAB of the task (open_browser_pane) does NOT replace the preview: the live page dies with the server that serves it, the preview stays.",
  "The preview is an ATTACHMENT, not source. Never leave it in the repo root: an untracked file there BLOCKS the land (it would be swallowed by the realign merge, and the land refuses rather than swallow it — measured twice on 18/08), and a committed one is repo litter. Write it under ~/.topics/media/, or if it genuinely documents a decision worth keeping, under docs/archive/ — never the root.",
  "One single gate, and it holds for all three: at 268px wide (`sips -Z 268 <file>`) you must still be able to say what it shows.",
].join("\n");

// ─────────────────────────────────────────────────────────────────────────────
// I cancelli del codice — la regola, in UN posto solo.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cosa deve essere verde prima di consegnare codice, e la regola dello script
 * che nessuno importa.
 *
 * Misurato l'11/08: tre card nello stesso pomeriggio hanno lasciato `main` con
 * `check:deadcode` rosso (`scripts/mcp-cap-bench/`, `decompose.ts` +
 * `prefix-probe.ts`, `scripts/webrtc-probe.ts`), sempre per la stessa forma —
 * un agente aggiunge uno script che si lancia A MANO, nessuno lo importa, e per
 * il gate del codice morto un file non importato È codice morto. Il cancello
 * aveva ragione ogni volta: la dichiarazione mancava davvero.
 *
 * La causa non era la distrazione: il kickoff nominava i cancelli SOLO quando la
 * board dichiarava dei comandi (`reviewChecks`), e nessuna board li dichiarava.
 * Un cancello che nessuno nomina è un cancello che si scopre a valle — cioè a
 * mano, dall'umano, tre volte.
 *
 * I nomi degli script sono quelli convenzionali di questo repo e valgono come
 * ESEMPIO: la riga dice esplicitamente di leggerli in `package.json`, perché
 * quello che non cambia da progetto a progetto sono i quattro CANCELLI, non i
 * loro nomi. I comandi che il server esegue davvero restano quelli dichiarati
 * per board (`reviewChecks`) — questa stringa non li sostituisce, li precede.
 */
export const CODE_GATES_RULE = [
  "THE SIX CODE GATES, and ALL of them hold before you deliver — the script names you read in `package.json`, the gates you do not: types (`bun run typecheck`), lint (`bun run lint`), dead code (`bun run check:deadcode`), unit tests (`bun run test:unit`), prose (`bun run check:emdash`), comment language (`bun run check:comment-language`).",
  "The fifth one is new and it surprises people: `check:emdash` rejects the long dash in ANY text in the repo, protocol strings and the comments you write in the code included. You do not replace it with a short dash: the sentence the dash was holding together was two sentences, and they split. If the character IS the data, the line ends with `// allow-emdash: <reason>`.",
  "THE REPO IS ENGLISH, and that includes the comments you write. `bun run check:comment-language` is a ratchet: it does not ask you to translate what is already there, it fails when a file gains a NEW Italian comment line. So write the comment in English the first time, because a comment written in Italian will not land. When the Italian IS the subject (a quoted message, a term of art, someone's exact words), the line ends with `allow-italian: <reason>`. This is about the CODE. What you write to the person on the board follows the language line above, which is a separate question.",
  "The third one is the one everybody forgets: for the dead-code gate, a file NOBODY IMPORTS is dead code. So a script you run by hand (a probe, a bench, a measurement) has to be DECLARED among the project entries in the same commit that adds it — with knip: the entry with the `!` suffix in `knip.jsonc` (like `scripts/disk-report.ts!`), and next to it the comment line that says how it is run.",
].join("\n");

// end-allow-emdash

/**
 * Il bump di versione è UN GESTO, non quattro modifiche a mano.
 *
 * Misurato nella notte dell'11-12/08: due card diverse (`d18b2db5`, `b1f4d6ff`)
 * hanno bumpato la versione toccando TRE posti su quattro, e in entrambi i casi
 * quello lasciato indietro era `Cargo.lock`. Il cancello
 * (`tests/unit/version-lockstep.test.ts`) le ha prese entrambe, e in entrambi i
 * casi l'umano ha riallineato il numero a mano prima di landare.
 *
 * La causa non è la distrazione ed è la stessa forma di `CODE_GATES_RULE`: chi
 * bumpa apre i file di CONFIGURAZIONE, e il quarto posto è un lockfile generato
 * dal build system che nessuno apre mai a mano. Un gesto manuale su un file che
 * nessuno modifica a mano si dimentica per costruzione, non per svista — e un
 * cancello che ha ragione ma non nomina il rimedio costa un giro ogni volta.
 *
 * Perciò la riga nomina il GESTO, non i file: i posti da toccare cambiano da
 * repo a repo, «non aprirli a mano» no. I nomi degli script valgono come
 * ESEMPIO, esattamente come nei cancelli: la riga dice di leggerli in
 * `package.json`.
 *
 * Since 2026-09-04 the line also says WHEN not to bump: never from a card.
 * With fourteen cards in flight the first delivery carried its own bump
 * (`chore(release): bump v2.2.265`), and N cards bumping in parallel to the
 * same number collide on all four files at land time. The number moves once
 * per release, at landing, by whoever lands.
 */
export const VERSION_BUMP_RULE =
  "A VERSION BUMP IS ONE COMMAND, never the files by hand. The name you read in `package.json` (here `bun run bump [patch|X.Y.Z]`, and `bun run bump sync` to realign a tree that already drifted). The number is written in SEVERAL places and one of them is a GENERATED file (a lockfile): it is the only one nobody ever opens by hand, so it is the only one a manual bump forgets. It has already happened twice in one night. AND ON A CARD YOU DO NOT BUMP AT ALL: the number moves once per release, at landing, by whoever lands. Read on 2026-09-04: with fourteen cards in flight, the first one delivered carried its own bump, and every card bumping in parallel collides on all four files at land time.";

/**
 * Ritaglia il blocco `PREVIEW_RULE` da un envelope già composto, per STRUTTURA
 * (prima riga «EVIDENZA DI REVIEW…», ultima «Cancello unico…») e non
 * cercandovi la costante: un test che cerca la costante che ha appena
 * interpolato non può fallire, e questo invece deve fallire il giorno in cui
 * qualcuno riscrive il testo a mano dentro un envelope.
 */
export function extractPreviewRule(envelope: string): string | null {
  const lines = envelope.split('\n');
  const from = lines.findIndex((l) => l.startsWith('REVIEW EVIDENCE'));
  if (from < 0) return null;
  const to = lines.findIndex((l, i) => i >= from && l.startsWith('One single gate'));
  if (to < 0) return null;
  return lines.slice(from, to + 1).join('\n');
}

/**
 * Il PESO di un task: quanto MORDE LA MACCHINA mentre gira, non quanto è
 * difficile. Sono due assi diversi e vanno tenuti separati — un algoritmo
 * ambiguo è `fable` e non consuma niente; un `bun run build` è banale da
 * decidere e si prende tutti i core per due minuti. Il modello dice quanto
 * l'agente deve PENSARE; il peso dice quanto l'esecuzione COSTA alla macchina
 * su cui gira, che è la cosa che lo scheduler deve sapere.
 *
 * Due valori e non una scala: quello che serve allo scheduler è una domanda
 * binaria («questo task può stare accanto ad altri, sì o no?»), e ogni gradino
 * in mezzo sarebbe un valore che nessun gate legge.
 *
 * `light` è il DEFAULT in ogni senso: è il valore di ripiego quando il
 * classificatore non risponde, ed è come si legge un `null` in colonna (vedi
 * migration 090). Senza una risposta letta, niente cambia rispetto a prima.
 */
export const TASK_WEIGHTS = ['light', 'heavy'] as const;

export type TaskWeight = (typeof TASK_WEIGHTS)[number];

/**
 * Legge il peso da una colonna/valore libero. Tutto ciò che non è uno dei due
 * valori noti — `null`, stringa vuota, un valore vecchio o storto — torna
 * `null`, cioè «mai classificato», che ogni gate tratta come `light`.
 *
 * `null` NON viene normalizzato a `'light'` di proposito: distinguere «non l'ho
 * mai chiesto» da «ho chiesto e ha detto leggero» è l'unico modo per accorgersi
 * che il classificatore ha smesso di rispondere.
 */
export function readTaskWeight(raw: unknown): TaskWeight | null {
  return (TASK_WEIGHTS as readonly unknown[]).includes(raw) ? (raw as TaskWeight) : null;
}

/**
 * Gli stati di `dispatch_state` in cui un agente sta LAVORANDO il task adesso:
 * è in coda per partire, sta partendo, o è dentro un turno. Fuori da questi tre
 * il task è fermo (`null`, `waiting`, `delivered`, `needs_input`, `exhausted`).
 *
 * Era una lista scritta a mano in cinque posti — due gate del server
 * (`services/tasks.ts`, review e spostamento di progetto) e tre della UI
 * (`TaskDetail` due volte, `Card`) — e ora anche il silenziatore delle notifiche
 * ne ha bisogno: "l'agente sta lavorando" è la stessa domanda, e va fatta una
 * volta sola. Il tipo DERIVA dal valore, così aggiungere uno stato senza
 * decidere da che parte sta non compila.
 */
export const ACTIVE_DISPATCH_STATES = ['queued', 'starting', 'working'] as const;

export type ActiveDispatchState = (typeof ACTIVE_DISPATCH_STATES)[number];

/**
 * Il chip che il dispatcher mette quando DECIDE di non far partire un task.
 *
 * Sta qui perché adesso ha due lettori che devono concordare: il dispatcher che
 * lo scrive (`CHIP_QUEUED`) e `rowToTask`, che da quel chip più il peso deduce
 * «questa card è il tappo della coda». Due letterali `'queued'` in due file
 * sarebbero andati in deriva nel modo peggiore: la ragione sulla card non
 * sarebbe sparita con un errore, sarebbe tornata a dire «in coda».
 */
export const DISPATCH_CHIP_QUEUED = 'queued';

/**
 * True se su questo task c'è un agente al lavoro ADESSO (vedi ACTIVE_DISPATCH_STATES).
 *
 * È un type guard, non un `boolean`: così `ActiveDispatchState` ha un
 * consumatore vero invece di essere un export dichiarativo che nessuno annota,
 * e nel ramo `true` il chiamante ha in mano uno dei tre stati — non una stringa
 * qualunque. È questo che rende reale la garanzia promessa qui sopra.
 */
export function isAgentWorking(
  dispatchState: string | null | undefined,
): dispatchState is ActiveDispatchState {
  return (ACTIVE_DISPATCH_STATES as readonly string[]).includes(dispatchState ?? '');
}

/**
 * «L'ha fermato una persona», scritto — non dedotto dall'assenza di chip.
 *
 * Un park umano finiva a `dispatch_state = NULL`, cioè identico a un task mai
 * dispacciato: la card tornava in Backlog muta e l'unico modo di sapere perché
 * era aprire il thread. Le due alternative già in tabella dicono altro:
 * `failed` accusa l'agent di un fallimento che non c'è stato, `blocked` promette
 * una configurazione da sistemare.
 *
 * Vive qui perché ha tre lettori su due lati del filo — chi lo SCRIVE (lo stop
 * della route), chi lo PRESERVA (la coda del `onTurnEnd`, che senza guardia
 * riazzera la chip del turno che ha appena tagliato) e chi lo DISEGNA (la
 * tabella delle chip del client).
 */
export const PARKED_STOPPED = 'stopped';

/**
 * «Aspetta da troppo», scritto — e deliberatamente NON `failed`.
 *
 * Un'attesa dichiarata (`wait_for_condition`) è la cosa giusta da fare: l'agent
 * ha capito che la condizione non dipende da lui e ha restituito lo slot invece
 * di dormirci sopra. Quando la serie di attese sfonda il tetto, il task si ferma
 * lo stesso — ma ciò che si è esaurito è la PAZIENZA, non l'agent: la decisione
 * torna all'umano perché la condizione non arriva, non perché qualcosa è rotto.
 *
 * Ha gli stessi tre lettori di `PARKED_STOPPED`, ed è per questo che vive qui:
 * chi lo SCRIVE (`deferForWait`, quando la serie sfonda), chi lo PRESERVA (la
 * coda di `onTurnEnd`, che senza guardia riazzera la chip del turno che si è
 * appena parcheggiato da solo) e chi lo DISEGNA (la tabella delle chip).
 */
export const PARKED_WAITED_OUT = 'waited_out';

// ─────────────────────────────────────────────────────────────────────────────
// Machine notes stamped with the HUMAN's signature.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The author every comment posted through the human board surface carries.
 *
 * It is also the signature `release()` puts on its own narration when a PERSON
 * pulled the lever: the status trail must say the human moved the card, and
 * `by` drives both the trail and the note. So `author === HUMAN_AUTHOR` alone
 * does not mean "a person typed this".
 */
export const HUMAN_AUTHOR = 'user';

/** Stop button: the machine narrates the cut turn under the human's name. */
export const NOTE_STOPPED_BY_HUMAN =
  'Fermato da te: agent interrotto. Rimetti il task in Todo per ripartire.';

/**
 * Lo stesso bottone su una card che era solo IN CODA. «Ferma» accetta anche
 * `queued`, e li' non c'e' nessun turno da tagliare: raccontare «agent
 * interrotto» a chi ha fermato una card mai partita descrive un fatto che non
 * e' successo, e lascia credere che del lavoro sia andato perso.
 */
export const NOTE_UNQUEUED_BY_HUMAN =
  'Tolto dalla coda da te: nessun agent era ancora partito. Rimetti il task in Todo per ripartire.';

/** Archiving a task with a live agent: same shape, same signature. */
export const NOTE_ARCHIVED_BY_HUMAN =
  'Archiviato da te mentre l\'agent lavorava: turno interrotto.';

/**
 * The tails that say WHICH option was picked. They are constants because a
 * reader has to recognise the fact in SQL, and a copy typed on the reading side
 * is a copy that stops matching the day the sentence is reworded.
 */
const PARKED_REQUEUED_TAIL = 'sottotask rimessi in coda.';
const PARKED_ARCHIVED_TAIL = 'sottotask archiviati.';
const PARKED_PROMOTED_TAIL = 'sottotask promossi a task indipendenti.';

/** The note `resolveParkedChildren` writes after the human picked an option. */
export function noteParkedChildrenResolved(decision: ParkedChildrenDecision, count: number): string {
  if (decision === 'requeue') {
    return `Sbloccato: ${count} ${PARKED_REQUEUED_TAIL} Torno in coda anch'io e riparto quando hanno finito.`;
  }
  if (decision === 'promote') {
    return `Sbloccato: ${count} ${PARKED_PROMOTED_TAIL} Li serve la coda, non io: torno in coda anch'io.`;
  }
  return `Sbloccato: ${count} ${PARKED_ARCHIVED_TAIL} Torno in coda: non c'è più niente ad aspettarmi.`;
}

/** The three ways out of the parked-subtask stall, named once for both sides. */
export type ParkedChildrenDecision = 'requeue' | 'archive' | 'promote';

/**
 * «RIMETTI IN CODA È GIÀ STATO FATTO SU QUESTA CARD», per chi lo conta in SQL.
 *
 * The escape hatch out of the parked-subtask loop hangs on this question, and
 * it was dead: the probe compared a comment to the BUTTON LABEL
 * (`content = REQUEUE_PARKED_LABEL`), and nothing ever writes a comment whose
 * whole body is that label. So the count was always zero, the third option
 * (`TAKE_OVER_PARKED_LABEL`) was never offered, and the human was handed the
 * same circular button forever — which is the exact loop that option exists to
 * break.
 *
 * The fact that DOES get written is the note above, so that is what gets
 * counted. Exported as a LIKE pattern built from the same constant the writer
 * uses: one declaration, two sides, no way to drift.
 */
export const PARKED_REQUEUE_NOTE_LIKE = `%${PARKED_REQUEUED_TAIL}%`;

/** The shape of `noteParkedChildrenResolved`, matched without rebuilding it. */
const PARKED_CHILDREN_NOTE = /^Sbloccato: \d+ sottotask (?:rimessi in coda|archiviati|promossi a task indipendenti)\./;

/**
 * Il prefisso con cui un turno finito male si annuncia dentro `content`.
 *
 * VIVE QUI perché lo leggono DUE alberi. Il client lo usa per accendere il
 * banner e il bottone «Riprova» (`turnError.ts`); il server per NON scambiare
 * un cartello per le parole dell'agente quando rispecchia la sua ultima prosa
 * sulla card (`getLastAgentText`). Ricopiarne il carattere a mano nel secondo
 * era la duplicazione che diverge al primo cambio — la stessa critica che
 * `isMachineVoice` muove agli elenchi di stringhe tenuti allineati a mano.
 *
 * È marcato LEGACY perché il verdetto autorevole, per il client che sa
 * leggerli, è il blocco `error`. Ma non è morto: il server scrive SEMPRE anche
 * il testo quando la riga sarebbe altrimenti vuota (`routes/chat.ts`, i due
 * rami che assegnano `fullContent`), e per una ragione dichiarata lì — è
 * l'unica colonna che la ricerca ⌘K interroga, e i client vecchi leggono da
 * lì. Misurato sul DB il 20/08: 573 righe col prefisso, ZERO con blocco
 * `error` e `content` vuoto.
 */
export const TURN_ERROR_PREFIX = '\u26a0\ufe0f';

/**
 * Prose the SERVER wrote, even though the comment is signed `user`.
 *
 * The board reads `author: 'user'` as "a person typed this" in the one place
 * where it matters: a card back in review quotes the last human request above
 * the answer, because commenting a card in review rejects it and wakes the
 * agent, so that request is what the delivery below is answering. A stop or an
 * archive is not a request. Left in, the card hands you back "Fermato da te:
 * agent interrotto." as your own words on the very next delivery.
 *
 * The sentences live here, next to the only functions that write them, so the
 * reader and the writers cannot drift apart: change the copy on one side and
 * the other side follows, because there is only one side.
 */
export function isMachineNote(content: string): boolean {
  const text = content.trim();
  return text === NOTE_STOPPED_BY_HUMAN
    || text === NOTE_UNQUEUED_BY_HUMAN
    || text === NOTE_ARCHIVED_BY_HUMAN
    || PARKED_CHILDREN_NOTE.test(text);
}

/**
 * Quante attese di FILA per la stessa ragione, prima che decida un umano.
 *
 * Sei e non due, che è il tetto dei tentativi di dispatch: quel numero frena i
 * turni MORTI, e per quelli due è generoso. Un'attesa non è un turno morto, e
 * col default di 15 minuti sei attese sono un'ora e mezza di condizione che non
 * arriva. Sotto quella soglia fermare il task vorrebbe dire chiedere all'umano
 * di guardare una cosa che stava per sistemarsi da sola.
 */
export const WAIT_STREAK_CAP = 6;

/**
 * Il tetto sull'ALTRA grandezza: quanto è lunga la serie in orologio.
 *
 * Serve perché `minutes` lo sceglie l'agent e arriva a 1440: due attese da
 * dodici ore non sfondano mai il tetto sul conteggio, ma sono un giorno in cui
 * nessuno ha guardato la card. Si misura dall'inizio della serie a ORA, non
 * sommando le finestre chieste: la finestra è una promessa, il tempo passato è
 * un fatto.
 */
export const WAIT_SERIES_MAX_MS = 4 * 60 * 60 * 1000;

/**
 * La ragione ridotta alla sua identità: è questo che decide se un'attesa
 * CONTINUA la serie o ne apre una nuova.
 *
 * Minuscole e spazi compattati perché la stessa attesa, ridichiarata da un turno
 * nuovo che non ha in mano il testo esatto di prima, si riscrive a mano quasi
 * uguale. «Aspetto che CI finisca» e «aspetto che ci finisca  » sono la stessa
 * condizione, e contarle come due serie diverse azzererebbe il contatore a ogni
 * giro. Cioè lo renderebbe un contatore che non conta niente.
 */
export function waitReasonKey(reason: string): string {
  return reason.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocco `question` — il formato, dichiarato dove SCRITTURA e LETTURA lo vedono
// entrambe (`addComment` lo compone, `parseQuestionBlock` lo legge).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IL BLOCCO ```question È UN CONTRATTO, non una formattazione.
 *
 * Lo compone il server (unico scrittore, `addComment`) in una forma fissa —
 * fence, la domanda su UNA riga, poi le opzioni come righe `- …` — e lo legge
 * `parseQuestionBlock` per disegnare le risposte rapide. Cambiare quel layout
 * non è un dettaglio estetico: è una card che perde i bottoni, e le risposte
 * rapide devono esserci SEMPRE finché il task non è chiuso.
 *
 * Da qui la conseguenza che vale la pena scrivere: dentro la fence il corpo
 * resta appiattito, perché una riga `- …` del corpo non sarebbe distinguibile
 * da un'opzione. Un testo lungo che vuole tenersi l'impaginazione (un piano)
 * viaggia FUORI dalla fence, nello stesso commento: il parser lascia intatto
 * ciò che sta attorno al blocco, e le tre superfici (thread, card, tab Piano)
 * lo rendono come markdown. Il posto dove separare corpo e opzioni è il
 * RENDER, non il testo salvato — questo modulo dichiara solo la forma.
 */

/** Etichette senza punteggiatura/emoji/spaziatura: due opzioni si confrontano
 *  per SIGNIFICATO, non per byte (il modello aggiunge volentieri un ✅). */
export function normalizeActionLabel(s: string): string {
  return s.replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Le due opzioni del protocollo piano-prima. Sono un CONTRATTO, non un testo di
 * cortesia: il dispatcher le scrive nell'envelope, e la loro presenza è ciò che
 * dice al servizio «questo commento È il piano» (→ `tasks.plan_comment_id`).
 * Prima il piano si indovinava — «l'ultimo commento non-utente» — e su 13 task
 * piano-prima l'euristica sbagliava 13 volte su 13: il commento di rettifica,
 * o la consegna con «Landa su main», rubavano il posto al piano.
 */
export const PLAN_APPROVE_LABEL = 'Approva il piano';
export const PLAN_REVISE_LABEL = 'Da rivedere';

/** Vero quando fra le opzioni c'è l'approvazione di un piano (match tollerante). */
export function hasPlanApproveOption(options: readonly string[]): boolean {
  const want = normalizeActionLabel(PLAN_APPROVE_LABEL);
  return options.some((o) => normalizeActionLabel(o) === want);
}

/**
 * THE RESERVED QUICK-REPLY LABELS — the ones the BOARD executes by itself.
 *
 * They live in `shared/` and not in the task service because FIVE surfaces have
 * to agree on them, and three of them are in the client: the dispatch chip and
 * the two review gates (server), the push notification (server), the in-app
 * banner (client) and the quick-reply de-duplicator (client). The notification
 * pair was left reading a different rule and kept announcing finished work as a
 * question — one vocabulary, or the split comes back.
 *
 * They are deliberately NOT translated. The option text travels to the server
 * and is matched BY VALUE, so the de-duplicator has to compare against this
 * constant and not against the button's translation: under locale `en` the
 * button reads "Land on main" while the option still says "Landa su main", and
 * comparing the translation let the rejecting twin back in.
 */
export const LAND_ACTION_LABEL = 'Landa su main';
export const PUBLISH_ACTION_LABEL = 'Landa e pubblica';
export const REQUEUE_PARKED_LABEL = 'Rimetti in coda i sottotask';
export const ARCHIVE_PARKED_LABEL = 'Archivia i sottotask';
/**
 * La terza uscita, e nasce da un ANELLO misurato: «rimetti in coda» porta i
 * figli in `todo`, ma un figlio in `todo` conta fermo lo stesso (il tick lista
 * `rootsOnly`), quindi la domanda tornava identica al turno dopo e chi
 * rispondeva ripremeva lo stesso bottone. Alla seconda volta la board smette di
 * offrire quella strada e offre QUESTA: la card torna in mano a una persona,
 * che e' l'unica cosa che la sblocca davvero quando l'agente non tocca i suoi
 * step.
 */
export const TAKE_OVER_PARKED_LABEL = 'La prendo in mano io';
/**
 * LA QUARTA ETICHETTA, ed e' quella che l'envelope raccomanda gia' all'agente.
 *
 * Le due storiche rispondono male al caso piu' frequente. La misura: delle card
 * ferme sui propri step il 19/08 4 su 4 e il 18/08 15 su 16 portavano nel thread
 * una traccia di INTERRUZIONE (riavvio, sessione morta, ripresa). Quegli step non
 * sono disobbedienza: sono lavoro vero rimasto senza turno. Rimetterli in coda
 * non li muove (nessun dispatcher prende un figlio), archiviarli butta la lista
 * di cio' che restava da fare.
 *
 * Togliere il `parent_task_id` e' l'unico gesto che li rende servibili: e' cio'
 * che `buildKickoff` ordina all'agente («o lo fai, o lo PROMUOVI a task
 * indipendente»), e finora la board non lo offriva a chi rivede.
 */
export const PROMOTE_PARKED_LABEL = 'Promuovi i sottotask a task';

/** Tolerant match (ignores emoji/punctuation/spacing the model may add). */
export function isLandActionLabel(text: string | undefined | null): boolean {
  return !!text && normalizeActionLabel(text) === normalizeActionLabel(LAND_ACTION_LABEL);
}
export function isPublishActionLabel(text: string | undefined | null): boolean {
  return !!text && normalizeActionLabel(text) === normalizeActionLabel(PUBLISH_ACTION_LABEL);
}
export function isRequeueParkedLabel(text: string | undefined | null): boolean {
  return !!text && normalizeActionLabel(text) === normalizeActionLabel(REQUEUE_PARKED_LABEL);
}
export function isArchiveParkedLabel(text: string | undefined | null): boolean {
  return !!text && normalizeActionLabel(text) === normalizeActionLabel(ARCHIVE_PARKED_LABEL);
}
export function isTakeOverParkedLabel(text: string | undefined | null): boolean {
  return !!text && normalizeActionLabel(text) === normalizeActionLabel(TAKE_OVER_PARKED_LABEL);
}
export function isPromoteParkedLabel(text: string | undefined | null): boolean {
  return !!text && normalizeActionLabel(text) === normalizeActionLabel(PROMOTE_PARKED_LABEL);
}

/**
 * A quick-reply label the BOARD executes by itself, as opposed to an answer
 * that steers the agent.
 *
 * These five are exactly the labels `POST …/tasks/:id/review` runs server-side
 * (publish, requeue/archive/promote parked children, land, take over): picking
 * one is an ORDER to the system, and nothing about the work is still undecided.
 * Every other option
 * (a plan's "Approva il piano", a free "Aspetta, ho un dubbio") resumes the
 * AGENT with the human's words, which is what "the card is waiting for a
 * person" means.
 */
export function isBoardActionLabel(text: string | undefined | null): boolean {
  return isLandActionLabel(text) || isPublishActionLabel(text)
    || isRequeueParkedLabel(text) || isArchiveParkedLabel(text) || isTakeOverParkedLabel(text)
    || isPromoteParkedLabel(text);
}

/**
 * L'antenato al lavoro che spiega un sottotask senza agente proprio: chi lo sta
 * lavorando, e con che titolo dirlo. Risolto dal server come `BlockerRef` e per
 * lo stesso motivo — la lista della board è un progetto solo, `rootsOnly`, non
 * archiviati, quindi il padre di un sottotask spesso NON è fra i task che il
 * client ha in mano, e cercarcelo dentro dava «nessuno lo lavora» proprio quando
 * qualcuno lo stava lavorando.
 */
export interface AncestorAtWork {
  id: string;
  text: string;
}

/**
 * Chi lavora un sottotask `in_progress` che non ha né topic né chip di dispatch.
 *
 * `parent-turn` = lo lavora un antenato dentro il PROPRIO turno: è il flusso
 * voluto — l'agente si crea la checklist come sottotask e la spunta mentre va —
 * ed è la norma schiacciante (misurato l'11/08/2026 sul DB vivo: 243 figli
 * chiusi in quella forma in un giorno, 281 il giorno prima).
 *
 * `unattended` = nessun antenato è al lavoro: la card è rimasta lì e non la
 * lavora nessuno. Rara (1 card viva su ~1.276 al momento della misura) ma reale,
 * e oggi invisibile: il recupero orfani filtra sul chip di dispatch, che qui non
 * c'è, quindi non vede né questo caso né l'altro.
 */
export type SubtaskWork =
  | { kind: 'parent-turn'; ancestor: AncestorAtWork }
  | { kind: 'unattended' };

/**
 * Un antenato sta lavorando ADESSO?
 *
 * `isAgentWorking` da solo non basta: `dispatch_state` resta scritto anche su
 * righe che nel frattempo sono state archiviate o mosse fuori da `in_progress`,
 * e leggerlo da solo farebbe passare per «al lavoro» un padre già chiuso.
 *
 * NON guarda `topics.archived`: i topic che il dispatcher crea per un agente
 * NASCONO archiviati (sono worker di sfondo, non tab da mostrare in sidebar).
 * Misurato l'11/08/2026: 755 topic archiviati su 767, e tutti e 7 i task con un
 * agente vivo in quel momento — compreso quello che stava girando — avevano il
 * topic `archived = 1`. Usare quel bit come segno di vita inverte la risposta
 * sul 100% dei casi sani.
 */
export function isAncestorAtWork(a: {
  status: TaskStatus | string;
  dispatchState: string | null | undefined;
  archived: boolean;
}): boolean {
  return !a.archived && a.status === 'in_progress' && isAgentWorking(a.dispatchState);
}

/**
 * La forma ambigua: un sottotask `in_progress` MAI dispacciato — niente topic,
 * niente chip. È l'unica in cui la domanda «chi lo lavora?» non ha già risposta
 * sulla card: con un topic c'è il deep-link, con un chip c'è lo stato.
 */
export function isUnattributedSubtask(t: {
  status: TaskStatus | string;
  parentTaskId: string | null | undefined;
  assignedTopicId: string | null | undefined;
  dispatchState: string | null | undefined;
}): boolean {
  return t.status === 'in_progress' && !!t.parentTaskId && !t.assignedTopicId && !t.dispatchState;
}

/**
 * Il segnale, DERIVATO dalla catena dei padri: nessuna migration e nessun
 * `assigned_topic_id` ereditato — quella colonna pesa su quota, dispatcher e
 * deep-link, e riempirla per dire una cosa che si può leggere sarebbe pagare
 * tre conti per un'etichetta.
 *
 * Nemmeno `created_by_topic_id` (migration 093) risponde: sembra la scorciatoia
 * — «chi mi ha creato è il topic che mi lavora» — ma è scritto solo su una
 * parte delle righe. Misurato l'11/08/2026 sui figli chiusi in giornata nella
 * forma ambigua: 90 su 249 ce l'hanno, 159 no. Leggerlo come segnale darebbe
 * «non la lavora nessuno» sui due terzi dei casi sani.
 *
 * `ancestors` arriva ordinata dal padre in su. Vince il PRIMO antenato al
 * lavoro, non il padre diretto: l'agente che lavora un task si crea la checklist
 * come figli, e quei figli possono avere figli loro — la catena misurata arriva
 * a due livelli, e chi tiene il turno può stare più in alto del padre.
 *
 * Torna `null` quando la domanda non si pone (non è un sottotask, non è in
 * corso, o ha già un agente suo): un `null` qui vuol dire «niente da dire»,
 * mai «non lo lavora nessuno» — quello è `unattended`, ed è un'altra cosa.
 */
export function deriveSubtaskWork(
  task: {
    status: TaskStatus | string;
    parentTaskId: string | null | undefined;
    assignedTopicId: string | null | undefined;
    dispatchState: string | null | undefined;
  },
  ancestors: ReadonlyArray<{
    id: string;
    text: string;
    status: TaskStatus | string;
    dispatchState: string | null | undefined;
    archived: boolean;
  }>,
): SubtaskWork | null {
  if (!isUnattributedSubtask(task)) return null;
  const at = ancestors.find(isAncestorAtWork);
  return at ? { kind: 'parent-turn', ancestor: { id: at.id, text: at.text } } : { kind: 'unattended' };
}

// ─────────────────────────────────────────────────────────────────────────────
// PERCHÉ questa card è ferma — la ragione, calcolata dove la si conosce.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * I motivi per cui un task non si muove. Uno per ramo del dispatcher, più uno
 * (`checklist_frozen`) per la card che è già uscita dalla coda e si è fermata
 * dall'altra parte, in review, su una checklist che nessuno lavorerà.
 *
 * Esistono come UNIONE e non come booleani sparsi perché la card ne mostra uno
 * solo, e quale sia è una precedenza: un task senza board non parte nemmeno se
 * il suo bloccante chiude, e dirgli «aspetta una card» sarebbe una bugia con la
 * faccia sicura. L'ordine di `deriveQueueReason` è quello del dispatcher.
 */
export type QueueReasonKind =
  | 'slot'           // idoneo: aspetta solo il suo turno nella coda
  | 'blocked'        // `blocked_by_task_id` ancora aperto
  | 'deferred'       // `dispatch_deferred_until` nel futuro
  | 'attempts'       // `dispatch_attempts >= dispatchRetryCap`
  | 'dispatch_off'   // interruttore di dispatch spento
  | 'no_project'     // nessuna board con una directory: nessun cwd, nessun agente
  | 'parent_review'  // è uno step e il padre aspetta una decisione umana
  | 'parent_turn'    // è uno step e l'agente del padre lo lavora nel suo turno
  | 'parent_idle'    // è uno step e il padre non è al lavoro: non lo lavora nessuno
  | 'heavy_hold'     // è PESANTE, aspetta margine, e intanto tiene ferma la coda
  | 'heavy_busy'     // un ALTRO task pesante è al lavoro e si prende la macchina da solo
  | 'checklist_frozen' // in review senza domande aperte, ma con la checklist aperta: approvarla non la chiude
  | 'children_parked' // sta CHIEDENDO cosa fare dei suoi step fermi: il chip ne porta il numero
  | 'parked'         // in backlog: il dispatcher non guarda questa colonna
  | 'no_agent'       // in corso, ma nessun agente dentro e nessuno che la reclami
  | 'unknown';       // il server non è riuscito a calcolarla: il buco, dichiarato

/**
 * COSA SUCCEDE DOPO, in tre pezzi. Il tono è la parte che si legge a un metro.
 *
 * `queued` = la coda scorre, non devi fare niente. `waiting` = ferma ma
 * riparte da sola (una condizione esterna, un altro task, un turno altrui).
 * `stalled` = non riparte finché non decidi tu. È la distinzione che oggi non
 * si vede: «aspetta uno slot» e «non partirà mai» sono la stessa parola «in
 * coda», e chi guarda non sa se aspettare o intervenire.
 */
export type QueueTone = 'queued' | 'waiting' | 'stalled';

/**
 * La ragione, pronta da scrivere. `head · detail` è il testo del chip, `title`
 * il tooltip che dice per esteso cosa succede dopo.
 *
 * La FRASE viaggia già composta, non i campi da cui dedurla: il client la
 * rende, non la calcola. È lo stesso conto già pagato con `waitingOnCount` —
 * il giorno che il dispatcher cambia una regola, un client che deduce continua
 * a rispondere, con sicurezza, la risposta di ieri.
 */
export interface QueueReason {
  kind: QueueReasonKind;
  tone: QueueTone;
  /** Prima parola del chip: «in coda», «ferma», «rinviata». */
  head: string;
  /** Il seguito: «3 davanti», «riprende alle 06:40», «tentativi finiti». */
  detail: string;
  /** Per esteso, nel tooltip: cosa succede dopo e cosa devi fare tu. */
  title: string;
}

/** Il contesto che la ragione non può leggere dalla riga del task. */
export interface QueueContext {
  /** Adesso, in ISO — la finestra di rinvio si misura da qui. */
  now: string;
  /** L'interruttore di dispatch della board (o quello globale). */
  autoDispatch: boolean;
  /** Il tetto dei tentativi della board (`BoardSettings.dispatchRetryCap`). */
  retryCap: number;
  /**
   * Quanti task idonei il dispatcher servirebbe PRIMA di questo. Contato sul
   * DB con la stessa disciplina di coda del tick (priorità, poi anzianità):
   * dalla lista che il client ha in mano non si può contare, perché quella è
   * un progetto solo, `rootsOnly`, non archiviati.
   */
  ahead: number;
  /**
   * Questo task è PESANTE e il dispatcher lo sta trattenendo (chip `queued`).
   *
   * Non è «aspetta il suo turno»: il ramo trattenuto del tick fa `break`, quindi
   * finché aspetta lui non parte NESSUNO. È la differenza che la board non
   * sapeva dire, e costava ore: la notte del 12/08 quaranta card idonee e due
   * `in_progress` col tetto a 9, tutte con lo stesso chip «in coda» addosso.
   */
  heavyHeld?: boolean;
  /**
   * C'è un task PESANTE con un agente vivo ADESSO — su qualunque board.
   *
   * È l'ALTRO ramo del peso, e non è una sfumatura di `heavyHeld`: il tick esce
   * prima del ciclo (`if (heavyBusy) { … return; }`) mettendo il chip `queued`
   * su OGNI todo. Quindi vale anche per le card leggere, l'ordine della fila non
   * lo legge nessuno, l'attesa non ha tetto (dura quanto quel turno) e la
   * priorità non sblocca niente.
   *
   * Serve perché senza, quelle card cadevano sulla frase della fila — «in coda,
   * 3 davanti» — che è la parola vaga da togliere: la sera del 12/08 tre card
   * ferme per questo motivo, il motivo scritto nel THREAD di ognuna, e sulla
   * card solo il chip generico.
   */
  heavyInFlight?: boolean;
  /** Quanti task idonei stanno DIETRO: quelli che il `break` sta fermando. */
  behind?: number;
  /** Lo stato del padre, per uno step. `null` = non è uno step, o padre sparito. */
  parentStatus: TaskStatus | string | null;
  /** Vero quando il task non ha una board con una directory (`_none`). */
  projectless: boolean;
  /**
   * Quanti sottotask aperti (non chiusi, non archiviati) ha questa card.
   *
   * Il client non lo ha: la sua lista è un progetto solo, `rootsOnly`, non
   * archiviati, e i figli non ci stanno dentro. `subtaskCount` sul payload non
   * risponde nemmeno lui: lo riempiono soltanto `list` e `get`, DOPO
   * `rowToTask`, quindi su ogni scrittura sarebbe zero proprio mentre l'umano
   * guarda la card che ha appena mosso.
   */
  openSubtasks: number;
  /**
   * Come si scrive un orario. Iniettabile perché il ramo «riprende alle 06:40»
   * dipende dal fuso della macchina, e un test che ci gira sopra non deve
   * dipendere da dove gira.
   */
  formatTime?: (iso: string) => string;
}

/**
 * IL BUCO, DICHIARATO. Quando il server non riesce a calcolare la ragione, la
 * card lo dice invece di ripiegare su una parola generica.
 *
 * «In coda» al posto di una ragione mancante non è un ripiego prudente: è la
 * stessa bugia di prima, con l'aggravante di sembrare una risposta. Un buco
 * detto ad alta voce è informazione — chi guarda sa che deve aprire il task, e
 * chi legge un rosso sa che c'è un guasto da guardare.
 */
export const QUEUE_REASON_UNKNOWN: QueueReason = {
  kind: 'unknown', tone: 'stalled', head: 'ferma', detail: 'motivo non registrato',
  title: 'Ferma, e il motivo non risulta: il server non è riuscito a calcolarlo. Non è «in coda». Apri il task e guarda il thread.',
};

/** Ore e minuti, 24h — il default di `QueueContext.formatTime`. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Sotto questa soglia il rinvio si dice in minuti («fra 12 min») invece che con
 * l'orologio. Un'attesa breve la si misura, non la si legge sul quadrante — e
 * «riprende alle 06:52» a un'attesa di due minuti fa sembrare fermo qualcosa
 * che sta per ripartire.
 */
const NEAR_DEFERRAL_MIN = 90;

/** Le prime otto lettere dell'id: quanto basta a riconoscerlo sulla board. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Le colonne in cui una promessa di ritorno in coda è una bugia, dette a parole. */
const OUT_OF_QUEUE: Record<'backlog' | 'review', { where: string; what: string }> = {
  backlog: {
    where: 'in Backlog',
    what: 'Trascinala in Todo per farla ripartire.',
  },
  review: {
    where: 'in Review',
    what: 'Decidi tu: approvala, rimandala indietro, oppure rimettila in Todo se il lavoro non è finito.',
  },
};

/**
 * LA PROMESSA CHE NESSUNO MANTIENE, in una colonna che non è una coda.
 *
 * `dispatch_state = 'waiting'` disegna «rinviata: aspetta una condizione
 * esterna, lo slot è libero, riparte da sola», e lo disegna in QUALUNQUE
 * colonna: è una mappa da uno stato a una frase, e la colonna non la guarda
 * nessuno (`DISPATCH_CHIP` in `components/Board/constants.ts`). Ma il rinvio lo
 * onora il tick, e il tick reclama `status = 'todo'`: da ogni altra colonna
 * quella finestra scade senza che nessuno la stia guardando.
 *
 * Misurato il 13/08 sul database vivo, quattro card col chip addosso e tre che
 * mentivano: una in Backlog con la finestra scaduta il 3 agosto, due in Review
 * con rinvii dell'11, e una sola in Todo che diceva il vero.
 *
 * Si parla SOLO sopra la promessa: senza `waiting` e senza una finestra, una
 * card in Backlog è semplicemente parcheggiata e la colonna lo dice già da sé —
 * ripeterlo su ognuna sarebbe rumore. `null` significa esattamente questo.
 */
function outOfQueuePromise(
  task: { dispatchState: string | null | undefined; dispatchDeferredUntil: string | null | undefined; dispatchError?: string | null },
  column: 'backlog' | 'review',
): QueueReason | null {
  if (task.dispatchState !== 'waiting' && !task.dispatchDeferredUntil) return null;
  const { where, what } = OUT_OF_QUEUE[column];
  return {
    kind: 'parked', tone: 'stalled', head: 'ferma',
    detail: `${where.toLowerCase()}, fuori dalla coda`,
    title:
      `Il chip dice che torna in coda da sé, ma è ${where} e il dispatcher reclama solo la colonna Todo: ` +
      `quella finestra non scade più per nessuno${task.dispatchError ? `. Aspettava: ${task.dispatchError}` : ''}. ${what}`,
  };
}

/**
 * PERCHÉ questa card è ferma, in una frase.
 *
 * Pura per costruzione: prende la riga e il contesto, non tocca né DB né
 * orologio (l'adesso arriva in `ctx.now`). La CHIAMA il server, dove vive la
 * decisione di non dispacciare; il client riceve `head`/`detail`/`title` già
 * scritti e li disegna.
 *
 * Torna `null` quando la domanda non si pone: la card è chiusa, oppure un agente
 * ci sta già girando sopra (lì il chip di dispatch dice già tutto), oppure la
 * card sta già CHIEDENDO qualcosa a chi guarda (`needs_input`) e quella domanda
 * è la mossa da fare, oppure la colonna in cui sta è già la risposta (una card
 * in Backlog che non promette niente è parcheggiata, e si vede da sola).
 *
 * FUORI DA TODO LA COLONNA NON È UNA CODA, e il chip di dispatch non lo sa. Il
 * tick reclama solo `todo`: `waiting` — «rinviata: riparte da sola» — è una
 * promessa che nessuno mantiene in Backlog e in Review (misurate il 13/08 sul
 * database vivo quattro card col chip addosso e tre che mentivano: una in
 * Backlog con la finestra scaduta il 3 agosto, due in Review con rinvii
 * dell'11), e una card `in_progress` senza chip non diceva niente mentre nessuno
 * la lavorava (quattro così, sulla stessa board). Le altre colonne entrano qui
 * per questo: la ragione vince sul chip di dispatch (`Card.tsx`), quindi è
 * l'unico posto da cui quella promessa si può correggere.
 *
 * L'ORDINE È QUELLO DEL DISPATCHER, e non è cosmetico:
 *  1. uno step non viene mai reclamato (il tick lista `rootsOnly`): la sua
 *     ragione è sempre il padre, qualunque altra cosa abbia addosso;
 *  2. senza board non c'è cwd, e il tick esce prima di guardare qualsiasi cosa;
 *  3. rinvio e bloccante vengono PRIMA del budget dei tentativi — è lo stesso
 *     ordine che il tick applica, e invertirlo ucciderebbe una card che sta
 *     solo aspettando (già successo, l'11/08, a una card in attesa di UAT);
 *  4. l'interruttore spento viene per ULTIMO, appena prima della coda: è una
 *     proprietà della board e non della card, e messo per primo cancellerebbe
 *     da quaranta card la sola cosa vera di ciascuna.
 */
export function deriveQueueReason(
  task: {
    status: TaskStatus | string;
    parentTaskId: string | null | undefined;
    dispatchState: string | null | undefined;
    dispatchAttempts: number;
    dispatchDeferredUntil: string | null | undefined;
    dispatchError?: string | null;
    /**
     * CHI ha portato la card in review, quando non è stato l'agente. Serve a un
     * ramo solo — distinguere la domanda di sistema sui figli fermi da tutte le
     * altre — ma è la differenza fra un chip che dice «serve te» e uno che dice
     * anche quanto lavoro c'è sotto.
     */
    deliveredReason?: string | null;
    blockedByTaskId: string | null | undefined;
    blockedBy: BlockerRef | null | undefined;
    /**
     * A chi è assegnata, se a una persona. Serve a UNA riga sola: una card
     * `in_progress` senza agente è ferma, tranne quando è una persona ad averla
     * presa in mano («Serve a me» scrive qui). Lì «in corso» è vero, e il chip
     * sarebbe un allarme su qualcuno che sta lavorando.
     */
    assignedTo?: string | null;
  },
  ctx: QueueContext,
): QueueReason | null {
  // REVIEW CON LA CHECKLIST APERTA: l'unico stato fuori da `todo` in cui la
  // domanda si pone, perché è l'unico in cui «ferma» ha una causa che la card
  // non mostra. Sembra una consegna che aspetta una persona, ma quella persona
  // non ha mosse: approvare porta a `done`, e `done` con un sottotask aperto è
  // rifiutato (`open_subtasks`); i sottotask non li dispaccia nessuno da solo,
  // li lavora l'agente del padre dentro un turno che qui è già finito. Otto
  // card così nella notte del 12/08, e il motivo viveva solo nel log di una
  // sonda che nessuno lancia.
  if (task.status === 'review') {
    if (ctx.openSubtasks <= 0) return outOfQueuePromise(task, 'review');
    // LA CARD CHE STA GIÀ CHIEDENDO NON SI ZITTISCE. `needs_input` è l'unico
    // stato in cui la card porta addosso una DOMANDA con una risposta possibile:
    // quella di sistema sui figli parcheggiati, che arriva coi due bottoni
    // («rimettili in coda» / «archiviali»), o quella vera dell'agente, che si
    // risponde nella sessione. Il chip rosa «serve te» dice esattamente quella
    // mossa; qui si legge «ferma», e il tooltip consiglia o cose che sono già
    // sullo schermo o, sulla domanda dell'agente, tutto tranne rispondere.
    //
    // È anche l'unica riga su cui questa funzione e la sonda
    // (`scripts/stalled-parents.ts`) potevano dare risposta OPPOSTA: la sonda
    // esclude `review + delivered_reason = 'parked_children'` dicendo «sta già
    // chiedendo». I due predicati restano diversi perché rispondono a due
    // domande diverse — «ha una mossa sullo schermo» contro «è uno stallo muto»
    // — ma il primo CONTIENE il secondo: `askParkedChildren` scrive
    // `needs_input` e `parked_children` nella stessa UPDATE. Il contenimento è
    // provato, non sperato, in `tasks.queue-reason.test.ts`.
    //
    // `delivered` invece perde il suo chip verde, ed è voluto: quello non chiede
    // niente, dice che si può chiudere — e con un sottotask aperto approvare
    // viene rifiutato (`open_subtasks`). È esattamente la bugia da togliere.
    // ...con UNA eccezione: la domanda di sistema sui figli fermi. Lì il chip
    // rosa dice la mossa («serve te») ma non dice QUANTO — e il numero è la sola
    // parte che si legge dalla colonna senza aprire il drawer. Il 13/08 sette
    // padri tenevano ferme ventuno card, e da fuori non si vedeva né quali né
    // quante: le colonne Backlog e Todo si disegnavano vuote perché la board
    // fetcha `rootsOnly`, e gli step non ci stanno dentro.
    //
    // Il conto è quello dei figli aperti, ed è esatto per costruzione:
    // `askParkedChildren` firma `parked_children` solo quando NESSUN figlio è in
    // volo, quindi in questo ramo «aperto» e «fermo» sono lo stesso insieme.
    if (task.dispatchState === 'needs_input') {
      if (task.deliveredReason !== 'parked_children') return null;
      const n = ctx.openSubtasks;
      return {
        kind: 'children_parked', tone: 'stalled', head: 'serve te',
        detail: n === 1 ? '1 step fermo' : `${n} step fermi`,
        title: `Questa card sta chiedendo cosa fare di ${n === 1 ? 'uno step fermo' : `${n} step fermi`}: non li prende nessun dispatcher, li lavora solo l'agente di questa card dentro il proprio turno, e finché sono aperti approvarla non la chiude. Rispondi sulla card: rimettili in coda, oppure archivia quelli che non servono più.`,
      };
    }
    const n = ctx.openSubtasks;
    return {
      kind: 'checklist_frozen', tone: 'stalled', head: 'ferma',
      detail: n === 1 ? '1 sottotask aperto' : `${n} sottotask aperti`,
      title: `In review con ${n === 1 ? 'un sottotask ancora aperto' : `${n} sottotask ancora aperti`}: approvarla non la chiude, perché una card con un sottotask aperto non può andare in done. E quei passi non li prende nessun dispatcher: li lavora solo l'agente di questa card, dentro il proprio turno. Chiudili o archiviali, oppure rimetti questa card in coda e falla finire.`,
    };
  }

  // Una card chiusa non aspetta niente: la domanda non si pone.
  if (task.status === 'done') return null;

  // Un agente già in volo su questa riga: il chip del ciclo di vita
  // («avvio…», «al lavoro») dice più di qualunque ragione di coda.
  if (task.dispatchState === 'starting' || task.dispatchState === 'working') return null;

  // ── LE ALTRE COLONNE CHE NON SONO UNA CODA ─────────────────────────────────
  // Il tick reclama `status = 'todo'` e basta. Da qui non riparte niente da
  // solo, quindi ogni frase che promette un ritorno è falsa e va sostituita.
  //
  // Il bloccante NON entra: ha una riga sua sulla card (`blockedByChip`), e la
  // sua frase — «quando quello chiude questa torna in coda da sé» — sarebbe
  // proprio la promessa che qui non vale. Meglio il chip che c'è già.
  if (task.status === 'backlog' || task.status === 'in_progress') {
    // `queued` compreso: fuori da `todo` quel chip non è la parola vaga che
    // questa funzione sostituisce, è un agente che sta per nascere.
    if (isAgentWorking(task.dispatchState)) return null;
    // Uno step in corso ha già la sua frase, e non è una ragione di coda: chi lo
    // lavora lo dice `deriveSubtaskWork` («la lavora il padre», «nessun antenato
    // al lavoro»), che sa risalire l'albero. Due frasi sulla stessa card
    // finirebbero per contraddirsi.
    if (task.parentTaskId) return null;

    if (task.status === 'in_progress') {
      // Presa da una persona: «in corso» è vero, e non c'è niente da dire.
      if (task.assignedTo) return null;
      return {
        kind: 'no_agent', tone: 'stalled', head: 'ferma', detail: 'nessun agente',
        title: "È in corso, ma non c'è nessun agente al lavoro: il turno è finito senza consegnare, o la card è stata mossa qui a mano. Il dispatcher reclama solo la colonna Todo, quindi da qui non riparte da sola: rimettila in Todo, oppure prendila tu.",
      };
    }

    // In Backlog si TACE, di regola: quella colonna è il parcheggio, e dirlo
    // su ogni card sarebbe ripetere l'ovvio dove sta scritto. Si parla solo
    // sopra una PROMESSA — il chip `waiting` o una finestra di rinvio — perché
    // quella promessa è l'unica cosa che la colonna non smentisce da sé.
    return outOfQueuePromise(task, 'backlog');
  }

  if (task.status !== 'todo') return null;

  if (task.parentTaskId) {
    if (ctx.parentStatus === 'review') {
      return {
        kind: 'parent_review', tone: 'stalled', head: 'ferma', detail: 'il padre aspetta te',
        title: 'È uno step: parte solo dentro il turno del padre, e il padre è in review. Finché non approvi o rimandi indietro, questo step non lo lavora nessuno.',
      };
    }
    if (ctx.parentStatus === 'in_progress') {
      return {
        kind: 'parent_turn', tone: 'waiting', head: 'ferma', detail: 'la lavora il padre',
        title: "È uno step: lo spunta l'agente del padre dentro il proprio turno. Non parte da solo, e non deve.",
      };
    }
    return {
      kind: 'parent_idle', tone: 'stalled', head: 'ferma', detail: 'il padre non è al lavoro',
      title: 'È uno step, e il padre non ha nessun agente al lavoro. Nessuno lo prenderà: fai partire il padre, oppure staccalo e rendilo un task suo.',
    };
  }

  if (ctx.projectless) {
    return {
      kind: 'no_project', tone: 'stalled', head: 'ferma', detail: 'nessun progetto',
      title: "Senza una board legata a una directory l'agente non ha una cartella in cui girare: non partirà mai. Assegna il task a un progetto.",
    };
  }

  const until = task.dispatchDeferredUntil;
  if (until && until > ctx.now) {
    const min = Math.max(1, Math.round((new Date(until).getTime() - new Date(ctx.now).getTime()) / 60000));
    const when = min <= NEAR_DEFERRAL_MIN ? `fra ${min} min` : `alle ${(ctx.formatTime ?? formatClock)(until)}`;
    return {
      kind: 'deferred', tone: 'waiting', head: 'rinviata', detail: `riprende ${when}`,
      title: `L'agente aspetta una condizione esterna e ha liberato lo slot: torna in coda ${when}${task.dispatchError ? `. Motivo: ${task.dispatchError}` : ''}`,
    };
  }

  const b = task.blockedBy;
  const blockerOpen = !!task.blockedByTaskId && !(b && (b.status === 'done' || b.archived));
  if (blockerOpen) {
    const who = b ? `«${b.text}»` : 'un altro task';
    return {
      kind: 'blocked', tone: 'waiting', head: 'ferma',
      detail: `aspetta ${shortId(task.blockedByTaskId!)}`,
      title: `Non parte finché ${who} non chiude. Quando quello va in done questa torna in coda da sé: non devi rimetterla tu.`,
    };
  }

  if (task.dispatchAttempts >= ctx.retryCap) {
    return {
      kind: 'attempts', tone: 'stalled', head: 'ferma',
      detail: 'tentativi finiti, rimettila in coda',
      title: `Budget dei tentativi finito (${task.dispatchAttempts}/${ctx.retryCap}): non riparte da sola. Trascinala di nuovo in Todo per ridarle i tentativi, oppure guarda cosa la fa fallire.`,
    };
  }

  // L'interruttore viene DOPO le ragioni della card, e non prima. È una
  // proprietà della board, non di questa riga: scriverlo per primo lo
  // stamperebbe identico su quaranta card e coprirebbe l'unica cosa che di
  // ognuna è vera in proprio. Quello che sostituisce è la sola risposta che a
  // interruttore spento sarebbe una bugia: «in coda, N davanti» — non c'è
  // nessuna coda che scorre.
  if (!ctx.autoDispatch) {
    return {
      kind: 'dispatch_off', tone: 'stalled', head: 'ferma', detail: 'dispatch spento',
      title: "Idonea, ma l'auto-dispatch è spento: questa colonna è una lista, non una coda. Non partirà nessuno finché non riaccendi l'interruttore.",
    };
  }

  // Un pesante trattenuto non «aspetta uno slot»: è il tappo. Viene dopo
  // l'interruttore (a dispatch spento non c'è nessuna coda da tappare) e prima
  // della fila, perché «in coda, 0 davanti» su una board immobile è vero alla
  // lettera e completamente fuorviante: fa sembrare che manchi un posto, mentre
  // il posto c'è e a non muoversi è la fila intera per colpa di questa riga.
  if (ctx.heavyHeld) {
    const dietro = ctx.behind ?? 0;
    return {
      kind: 'heavy_hold', tone: 'waiting', head: 'ferma la coda',
      detail: dietro === 0 ? 'pesante, aspetta margine' : `pesante, ${dietro} dietro`,
      title: dietro === 0
        ? 'È un task PESANTE: parte da solo, quindi aspetta che la macchina abbia margine. Riparte da sé, non devi fare niente.'
        : `È un task PESANTE e tiene la testa della coda: ${dietro} task dietro di lui non partono finché non parte questo. ` +
          "Aspetta che la macchina abbia margine, e comunque parte entro il tetto d'attesa. Se ti serve prima la coda dietro, abbassagli la priorità.",
    };
  }

  // L'ALTRO ramo del peso: non è questa card a tenere la coda, è un turno
  // pesante altrui che si prende la macchina da solo. Viene dopo `heavyHeld`
  // (i due si escludono: quello porta `&& !heavyInFlight()`) e prima della
  // fila, perché la fila qui non la legge nessuno — il tick esce prima del
  // ciclo, quindi «3 davanti» descriverebbe un ordine che nessuno applica.
  //
  // Le quattro cose che NON si possono dire, e che la frase del carico dice
  // tutte: che questa card tiene la testa della coda (l'ordine è irrilevante),
  // che aspetta margine (aspetta un turno, non il carico), che parte entro il
  // tetto d'attesa (quel tetto conta il carico, non il turno altrui), che
  // abbassarle la priorità sblocca qualcosa (non sblocca niente). Restano il
  // fatto e la mossa: non c'è mossa, riparte da sé.
  if (ctx.heavyInFlight) {
    return {
      kind: 'heavy_busy', tone: 'waiting', head: 'ferma',
      detail: 'un pesante ha la macchina',
      title: "C'è un task PESANTE al lavoro, e un pesante si prende la macchina da solo: finché non finisce quel turno non parte nessuno, "
        + 'nemmeno le card leggere. Riparte da sé appena ha finito: non devi fare niente.',
    };
  }

  return {
    kind: 'slot', tone: 'queued', head: 'in coda',
    detail: ctx.ahead === 0 ? 'la prossima' : `${ctx.ahead} davanti`,
    title: ctx.ahead === 0
      ? 'Idonea e prima della fila: parte appena si libera uno slot agente.'
      : `Idonea: aspetta uno slot agente, con ${ctx.ahead} task davanti nella coda. Parte da sola, non devi fare niente.`,
  };
}

export interface TaskComment {
  id: string;
  taskId: string;
  author: string;
  content: string;
  mentions: string[];
  /** File allegati: path assoluti da /api/upload, serviti via /api/media. */
  media: string[];
  createdAt: string;
  /**
   * 'comment' = un messaggio umano/agente. 'status' = un evento di transizione
   * scritto dal servizio a ogni scrittura di stato (contenuto "from→to", autore
   * = chi l'ha mosso): il thread fa anche da storico. Gli eventi 'status' non
   * contano mai come "l'ultima parola dell'agente" (gate di review, chip
   * delivered/needs_input).
   * 'review-note' = evidenza di review scritta dalla macchina (es. l'esito dei
   * check, lo screenshot di anteprima). Come 'status' non è l'ultima parola
   * dell'agente e — cosa che conta — non passa mai dal path umano POST
   * /comments, quindi non innesca reject+resume: informa il reviewer senza
   * svegliare l'agente.
   *
   * 'service' = the dispatcher's own bookkeeping (a retry, a server restart, a
   * queue hold). Set AT THE SOURCE by the writer, which already knows it is not
   * speaking for the agent, so the thread can fold a run of it into one line
   * without matching on wording. Like 'status' it is never the agent's last
   * word. See `shared/task-comment-service.ts` for how the fold reads it, and
   * why rows written before the mark are classified separately.
   *
   * 'delivery' = THE DELIVERY STATEMENT, the one the reviewer opened the card
   * for. It is a plain word like 'comment' (it travels, it is thread speech, it
   * is never folded), with one difference: it is DECLARED, so the card can
   * prefer it over recency instead of guessing which of the turn's comments was
   * the summary. The guessing is what failed — the last thing an agent writes
   * before delivering is usually git plumbing, and that is what a review card
   * showed as the delivery:
   * "terzo commit: il rosso di check:security chiuso alla fonte". allow-italian: verbatim from a real card
   * Written by ONE writer: `update({status:'review'})` from the
   * summary the agent hands over. Nothing else may set it.
   */
  kind: 'comment' | 'status' | 'review-note' | 'service' | 'delivery';
}

/**
 * Un commento COME LO DISEGNA LA CARD: i tre campi che legge, e nient'altro.
 *
 * È la forma con cui gli ultimi commenti viaggiano SULLA LISTA della board
 * (`Task.recentComments`), non nel thread: `id`, `taskId`, `createdAt`,
 * `mentions` e `media` la card non li tocca, e moltiplicati per tre commenti su
 * ogni scheda erano metà del peso di quel pezzo del feed (731 KB misurati il
 * 15/08/2026). Chi apre il thread riceve `TaskComment` interi, da `svc.get`.
 *
 * `Pick` e non una seconda interfaccia: il tipo dei tre campi deve restare
 * quello del thread, o `kind` diventa una `string` da una parte e un'unione
 * dall'altra senza che niente lo dica.
 */
export type CardComment = Pick<TaskComment, 'author' | 'content' | 'kind'>;

/**
 * Il bloccante di un task, RISOLTO dal server leggendolo dal DB.
 *
 * Esiste perché il chip «in attesa di» non può dipendere da chi c'è nella lista
 * che il client ha in mano: la board fetcha UN progetto, `rootsOnly`, non
 * archiviati — un bloccante fuori da quel taglio (un sottotask, un task di un
 * altro progetto, uno archiviato) non si trovava, e il chip spariva anche se il
 * legame c'era eccome. `status` e `archived` sono i due bit che decidono se il
 * chip va ancora disegnato: chiuso o archiviato = non blocca più (lo stesso
 * predicato del gate di dispatch, `isDispatchBlocked`).
 */
export interface BlockerRef {
  id: string;
  text: string;
  status: TaskStatus;
  archived: boolean;
}

/** Un comando del gate pre-review dichiarato nelle impostazioni della board. */
export interface ReviewCheck {
  name: string;
  cmd: string;
}

/** Esito di UN comando. `tail` è la coda dell'output combinato (stdout+stderr). */
export interface CheckRun {
  name: string;
  cmd: string;
  ok: boolean;
  /** Exit code; null se è stato ucciso (timeout o abort) o mai partito. */
  code: number | null;
  ms: number;
  timedOut: boolean;
  /**
   * Il comando ha DICHIARATO di non aver misurato (uscita 97): `tsc` o `eslint`
   * non c'erano, cioè un worktree senza `bun install` in client/. Campo suo e
   * non `timedOut`, perché dire «fermato oltre il tempo massimo» di un binario
   * che non esiste sarebbe una bugia, e il testo del commento la ripeterebbe.
   */
  notMeasured?: boolean;
  tail: string;
  /** Valorizzato solo se il comando non è nemmeno partito (binario assente, cwd sparita). */
  spawnError?: string;
}

/** Config di dispatch per board (riga `board_settings`). */
export interface BoardSettings {
  projectId: string;
  /**
   * The GLOBAL switch (reserved row `project_id='*'`), surfaced here so every
   * per-board read keeps gating dispatch without having to know about the global
   * row. Writing it through updateBoardSettings flips it for EVERY board.
   */
  autoDispatch: boolean;
  //
  // NO per-board concurrency cap. There is ONE cap, machine-wide, living on the
  // reserved row `project_id='*'` (`readGlobalCap` -> `getGlobalCap`): the one
  // the dispatcher reads in `currentCap()` and the one the spawn core quota
  // divides. A per-board `maxAgents` existed here until 2026-08-13: the route
  // wrote it, the panel read it back, and it decided NOTHING. Measured on the
  // live DB that day: the topics-app row said 9 while the real cap (row '*') was
  // 8, so the panel showed a limit one higher than the one being enforced.
  // The `max_agents` column stays in the DB for boards (dropping a column needs
  // a migration): it stays, and nothing writes or reads it any more.
  //
  dispatchEffort: string;
  dispatchUseWorktree: boolean;
  /**
   * Merge automatico del branch del worktree nel checkout principale del progetto
   * quando un umano approva (review → done). Programmatico: un merge pulito landa
   * in LOCALE (MAI push); un conflitto restituisce il branch all'agente del task;
   * un checkout non pronto (sporco / non su main) viene saltato. Default OFF —
   * nessuna board esistente cambia comportamento finché non lo si accende. Ha
   * senso solo con `dispatchUseWorktree` acceso (un task in-place non ha branch).
   */
  dispatchAutoMerge: boolean;
  /**
   * The generic analogue of `dispatchAutoMerge` for a board whose "done" does
   * not mean "merge to main" but "run this deploy script" — an external
   * project (a static site, a worker) with its own `deploy` in package.json.
   * Empty string = OFF, the default: no existing board changes behaviour.
   *
   * The server NEVER runs it by itself. On approve, if this is set, it
   * PROPOSES the deploy (a comment + a "Deploya ora" button on the card) and
   * only runs it in the project's MAIN checkout when a human confirms — see
   * `server/services/task-deploy.ts` and `Task.deployState`.
   */
  deployCommand: string;
  /**
   * DECLASSED TO REPORTING ONLY: this used to be the wall-clock ceiling that
   * cut a turn dead. It no longer kills anything — see `dispatchIdleMin` for
   * what replaced it. Kept only as a signal a very long turn compares itself
   * against (never an action).
   */
  dispatchTimeoutMin: number;
  /**
   * Minutes of SILENCE on a session's transcript before the passive stall
   * detector asks its judge "alive or stuck?" (see `server/lib/stall-detector.ts`).
   * A silent session is NOT cut on this alone: only a judge verdict of "stuck"
   * recycles the turn (abort + resume the same session, with a system note).
   * Default 5.
   */
  dispatchIdleMin: number;
  /**
   * Fleet MCP per gli agenti dispatchati su questa board (migration 049).
   * 'bridge-only' (il default NULL) = solo il bridge topics, profilo tool di
   * dispatch — gli schemi dei tool del fleet globale non entrano mai nel contesto
   * dell'agente. 'inherit' = via di fuga: la sessione eredita il fleet MCP completo
   * dell'utente (per board i cui task hanno davvero bisogno di quei tool).
   */
  dispatchMcp: string;
  /**
   * Modello di default per gli agenti dispatchati su questa board.
   * 'auto' (il default NULL) → il classificatore sceglie un modello per task
   * (comportamento storico). Un id concreto (es. 'claude-opus-4-8') inchioda ogni
   * dispatch di questa board a quello. Un modello esplicito sul task vince comunque
   * sul default della board.
   */
  dispatchModel: string;
  /**
   * Lingua in cui rispondono gli agenti dispatchati su questa board.
   * 'inherit' (il default NULL) → vale la preferenza globale
   * (`app_settings.output_language`), che e' anche quella di chat e terminale:
   * cosi' «uguali» significa LO STESSO VALORE EFFETTIVO, non due valori da
   * tenere allineati a mano. Un valore concreto ('it' | 'en') e' l'override —
   * una board di un cliente inglese non deve costringere il resto dell'app a
   * cambiare lingua.
   */
  language: string;
  /**
   * Fan-out: quanti agenti lavorano IN PARALLELO lo stesso task, ognuno nel
   * proprio worktree, prima che l'umano scelga quale tenere (migration 065).
   * 1 (il default) = un agente, il path storico byte per byte. >1 occupa N slot
   * del tetto globale di concorrenza, perché sono N agenti veri.
   * Ha senso solo con `dispatchUseWorktree` acceso: senza isolamento gli N
   * agenti si pesterebbero i piedi nella stessa cartella.
   */
  dispatchFanOut: number;
  /** Tentativi di lancio prima che un task venga parcheggiato (default 2). */
  dispatchRetryCap: number;
  /** Backoff (s) prima di riprendere un turno morto più in fretta di così (guardia outage, default 60). */
  dispatchRetryBackoffS: number;
  requireApprovalForDone: boolean;
  requireReviewBeforeDone: boolean;
  /**
   * Comandi che devono essere verdi perché una consegna entri in review, eseguiti
   * dal server nel worktree del task. Lista vuota = gate spento, che è il default:
   * niente si inferisce da package.json (`npm test` qui è la suite E2E, venti
   * minuti — un default così verrebbe spento il primo giorno).
   */
  reviewChecks: ReviewCheck[];
  /**
   * Modalità notturna: dispaccia la coda solo mentre la macchina è scarica, e
   * si ferma a `nightModeUntil`. La accende una PERSONA — il senso è «vado
   * via», e nessuna euristica lo sa. Default spento.
   */
  /**
   * Questa board e' in pausa: il tick la salta, le altre continuano.
   *
   * Puo' solo FERMARE, ed e' l'unico verso che regge: il dispatch parte se
   * l'interruttore globale e' acceso E questa board non e' in pausa. Una board
   * «non in pausa» con il globale spento non dispaccia niente. Due interruttori
   * che possono entrambi ACCENDERE si contraddicono, e chi guarda non sa quale
   * dei due sta leggendo.
   *
   * Diverso da `nightMode`, che e' condizionale (aspetta che la macchina sia
   * scarica) e si spegne da solo a un orario. Questo e' una scelta secca e
   * resta finche' qualcuno non la toglie.
   */
  dispatchPaused: boolean;
  nightMode: boolean;
  /** Quando smettere, `HH:MM` locale. Vuoto ⇒ nessuna fine (sconsigliato: un
   *  turno che non sa finire resta armato il giorno dopo). */
  nightModeUntil: string;
  /** Quando è stata accesa (ISO). Serve a capire se «fino alle 10:00» significa
   *  stamattina o domani mattina. */
  nightModeStartedAt: string | null;
}

/**
 * Cosa si può SCRIVERE nelle impostazioni. DERIVATO da `BoardSettings`, non
 * riscritto: un campo nuovo lassù o diventa patchabile da solo, o finisce
 * esplicitamente in questo `Omit` con il motivo scritto. (La copia a mano del
 * client — `BoardSettingsPatch` — aveva già perso i due `dispatchRetry*`.)
 *
 * Fuori: `projectId`, che è la chiave e sta nell'URL; e i due `require*`, che
 * nessun writer tocca — `updateBoardSettings` non li scrive, si leggono soltanto.
 */
export type BoardSettingsPatch = Partial<
  Omit<
    BoardSettings,
    // `nightModeStartedAt` lo TIMBRA il server quando l'interruttore si accende:
    // lasciarlo scrivere al client significherebbe poter datare l'accensione a
    // piacere e spostare la scadenza — cioè disarmare il turno dall'esterno.
    'projectId' | 'requireApprovalForDone' | 'requireReviewBeforeDone' | 'nightModeStartedAt'
  >
>;

/** Capacità viva della macchina per il tetto "Auto" (impostazioni board). */
export interface DispatchCapacity {
  /** Tetto di agenti concorrenti raccomandato per QUESTA macchina adesso. */
  recommended: number;
  cores: number;
  totalMemGB: number;
  /**
   * Load average a 1 minuto (vivo). NON è più il freno del tetto: è la coda di
   * esecuzione della macchina INTERA, quindi parla soprattutto delle app di chi
   * sta al computer. Resta perché la modalità notturna lo legge per un'altra
   * domanda («c'è movimento qui sopra?») e perché è il ripiego dove la sonda
   * della flotta non c'è.
   */
  load1: number;
  /**
   * Core-unità che la NOSTRA flotta sta bruciando adesso (1 = un core saturo),
   * e le core-unità che le sono concesse in tutto. `oursCores` a `null` vuol
   * dire NON MISURATO, che non è zero: senza sonda il freno vivo torna al load
   * average. Vedi `server/services/dispatch-capacity.ts`.
   */
  oursCores: number | null;
  budgetCores: number;
  /** Spiegazione in una riga di come `recommended` è stato derivato. */
  reason: string;
  /**
   * Quanti agenti stanno girando ADESSO su questa macchina (i turni in volo del
   * dispatcher). È il termine che manca per trasformare `recommended` da numero
   * in consiglio: senza sapere quanti ne stanno girando, «max 2» non dice se
   * c'è qualcosa da fare o no. Zero anche quando il dispatcher non c'è (un
   * router montato senza, i test): un conteggio assente vale «nessuno».
   */
  running: number;
}

/** Il tetto globale come sta scritto: `auto` (dimensionato dalla macchina) o il
 *  numero fisso. Gemello della riga riservata `board_settings['*']`. */
export interface GlobalDispatchCap {
  auto: boolean;
  max: number;
}

/** Bounds of the fixed number. The same ones `readGlobalCap` clamps what it
 *  reads from the DB with: a field that accepts 40 and saves 20 lies to whoever
 *  fills it in. */
export const GLOBAL_CAP_MIN = 1;
export const GLOBAL_CAP_MAX = 20;

/**
 * NO CEILING AT ALL, written as a fixed cap of zero.
 *
 * Zero rather than a new column because a column costs a migration, and because
 * "zero agents allowed" is a setting nobody can want — the value was free.
 *
 * It is admissible only because the expensive thing is fenced elsewhere.
 * Measured with 8 agents in flight: the agents summed to 5.7% CPU (they wait on
 * the API), while their gates — seven concurrent full test suites, eslint, three
 * tsc — took the machine to a load of 38 on 12 cores. Capping agents was
 * throttling the cheap side. `scripts/slot.ts` now bounds the expensive side,
 * machine-wide and across worktrees, so the number of agents can stop standing
 * in for it.
 */
export const GLOBAL_CAP_OFF = 0;

/** True when the human asked for no ceiling (a FIXED zero — `auto` is a
 *  different answer, and means "you decide"). */
export function isGlobalCapOff(cap: GlobalDispatchCap): boolean {
  return !cap.auto && cap.max === GLOBAL_CAP_OFF;
}

/**
 * The fixed number, inside the bounds and integral. NaN means the minimum: an
 * emptied number field must never be able to write "no agents at all".
 *
 * TRUNCATION, not rounding, and that is not a detail. Three places turn this
 * value into an integer and they have to agree: here (the optimistic value the
 * client shows), `clampInt` on the way into the DB (`server/services/tasks.ts`,
 * `Math.trunc`) and `Math.floor` on the way back out
 * (`server/services/dispatch-capacity.ts`). `<input type="number">` happily
 * hands over 3.6; rounding here showed 4 while the server stored 3, so the
 * field disagreed with itself until a reload. All three floor now, and for
 * values >= 1 trunc and floor are the same function.
 */
export function clampGlobalCap(n: number): number {
  if (!Number.isFinite(n)) return GLOBAL_CAP_MIN;
  // Zero passes through untouched: it is the "no ceiling" sentinel, not a small
  // number to be pulled up to the minimum. Clamping it to 1 would silently turn
  // "run as many as you like" into "run one", which is the opposite setting.
  if (Math.trunc(n) === GLOBAL_CAP_OFF) return GLOBAL_CAP_OFF;
  return Math.max(GLOBAL_CAP_MIN, Math.min(GLOBAL_CAP_MAX, Math.trunc(n)));
}

/**
 * Quanti agenti insieme, davvero, adesso: `auto` prende la raccomandazione
 * viva della macchina, il resto prende il numero fisso. Mai sotto 1 (un tetto
 * di zero non è una board prudente, è una board ferma).
 *
 * `recommended` a `null` significa «nessuna sonda»: si ricade sul numero fisso
 * anche in auto, che è il comportamento dei test e degli host degradati.
 *
 * STA QUI e non solo nel server perché ora ha due lettori: il dispatcher, che
 * lo applica, e il pannello impostazioni della board, che scrive «3 di 8» sotto
 * gli occhi di una persona. Due copie della stessa formula sono il modo in cui
 * il numero mostrato e il numero applicato iniziano a divergere.
 */
export function effectiveDispatchCap(cap: GlobalDispatchCap, recommended: number | null): number {
  if (isGlobalCapOff(cap)) return Infinity;
  return cap.auto && recommended != null ? Math.max(1, recommended) : Math.max(1, cap.max);
}

/**
 * THE OTHER QUESTION, and it is not the same one.
 *
 * `effectiveDispatchCap` answers "may one more agent start", so "no ceiling" is
 * a real answer there. This one answers "how much of the machine does each agent
 * get" — it is the DIVISOR of the core quota — and infinity is not an answer to
 * that: it would hand every agent a slice of zero. Nor is the raw zero, which
 * `Math.max(1, 0)` would turn into 1 and give each of them the whole machine,
 * which is the same inversion the reactive recommendation already caused once
 * (measured: `-j11` per agent under load 45).
 *
 * With no ceiling the sizing question falls back to the STRUCTURAL number: how
 * many this machine sustains in regime, which is exactly what the divisor wants
 * to know and the one number that does not move with the load the agents are
 * themselves making.
 */
export function sizingDispatchCap(cap: GlobalDispatchCap, structural: number | null): number {
  if (isGlobalCapOff(cap) || cap.auto) return Math.max(1, structural ?? 3);
  return Math.max(1, cap.max);
}

/** Le due primitive di collegamento dell'intake. */
export type LinkKind = "subtask" | "chain";

/**
 * La PROPOSTA dell'intake: dove andrebbe un testo nuovo.
 * Vive qui perche' la calcola il server e la disegna il client — due copie
 * libere di divergere erano esattamente cio' che il cancello sui doppioni
 * di tipo esiste per impedire.
 */
export interface LinkProposal {
  targetTaskId: string;
  targetText: string;
  targetStatus: TaskStatus;
  /**
   * Quale delle due primitive il motore consiglia. NON è una decisione: la UI
   * evidenzia questa e lascia l'altra a un click di distanza.
   * - `chain` quando la card sta ancora girando (in_progress/review): il testo
   *   nuovo è un SEGUITO, e riparte dentro la conversazione del bloccante.
   * - `subtask` quando la card non è ancora partita (backlog/todo): il testo
   *   nuovo è un PEZZO di quel lavoro.
   */
  recommended: LinkKind;
  /** 0..1 — copertura pesata dei termini del testo nuovo sulla card. */
  score: number;
  /** Le parole che hanno fatto il punteggio, dalla più rara alla più comune. */
  sharedTerms: string[];
  /** Frase leggibile: va sotto al composer E nel thread delle due card. */
  reason: string;
}

/**
 * Parse a task comment for an agent "question block" — the human-decision
 * request the board renders as a quick-reply:
 *
 *   ```question
 *   Which auth approach?
 *   - JWT in an httpOnly cookie
 *   - Short-lived bearer token
 *   ```
 *
 * The canonical block is composed SERVER-side (tasks service `questionOptions`)
 * so this layout is guaranteed for new comments — but the parser stays
 * tolerant of hand-written LLM variants: `\r\n`, missing newlines around the
 * fences, options inlined on one line. Returns the question + the (possibly
 * empty) option list, or null when the text has no such block.
 *
 * Sta in `shared/` e non più solo nel client perché ora ha un secondo lettore:
 * il SERVER, che deve sapere se il task che entra in review porta una domanda
 * per poterla mettere nei tasti della notifica (`emitReviewReadyEdge` →
 * `push-triggers`). Due parser sarebbero due verità: un'opzione che la board
 * mostra e il banner no è peggio di nessun banner.
 */
export function parseQuestionBlock(text: string): { question: string; options: string[] } | null {
  if (!text) return null;
  // \s+ (not \s*\n): tolerate a block whose newlines were lost/normalized —
  // '```question Question? - a - b```' still parses.
  const m = text.replace(/\r\n/g, '\n').match(/```question\s+([\s\S]*?)```/);
  if (!m) return null;
  const body = m[1].trim();
  if (!body) return null;
  const options: string[] = [];
  const qLines: string[] = [];
  if (body.includes('\n')) {
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const opt = line.match(/^[-*]\s+(.*)$/);
      if (opt) options.push(opt[1].trim());
      else qLines.push(line);
    }
  } else {
    // Degenerate single-line body: split on ' - ' option markers. The first
    // segment is the question; a leading '- ' marks an option-only block.
    const segments = body.split(/\s+-\s+/);
    const first = segments.shift()?.trim() ?? '';
    if (first.startsWith('- ')) segments.unshift(first.slice(2));
    else if (first) qLines.push(first);
    for (const s of segments) { const v = s.trim(); if (v) options.push(v); }
  }
  const question = qLines.join(' ').trim();
  if (!question) return null;
  // "Landa e pubblica" (go online = merge + push + deploy) is NEVER a per-task
  // quick-reply: publishing is a SEPARATE, human-only board action (the "Pubblica"
  // control) with a diff preview to review before pushing. The dispatcher used to
  // make agents offer it at delivery; drop it from the rendered options so old
  // deliveries that still carry it don't show a one-click merge+push button.
  // "Landa su main" (local merge, no push) stays.
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const filtered = options.filter((o) => norm(o) !== 'landa e pubblica');
  return { question, options: filtered };
}

/**
 * Does this parsed block ASK the human something, or is it a DELIVERY that
 * merely offers the next board action as a button?
 *
 * The presence of the fence answered neither question. The kickoff envelope
 * tells a delivering agent to attach `options=["Landa su main"]`, and the
 * server wraps any `options` in a ```question block, so EVERY landable delivery
 * came out shaped like a question. Measured on 13/08 against the live board db:
 * of the 437 agent comments carrying a question fence, 331 are deliveries, not
 * questions — three out of four.
 *
 * So read the OPTIONS instead. All of them board actions ⇒ delivery. A mixed
 * block ("Landa su main" + "Aspetta, ho un dubbio") is still a QUESTION: one
 * option the system cannot execute means a person has to choose.
 *
 * No options at all stays a question, which is this module's own reading
 * (`pendingQuestion`): a question with no buttons has nothing to click but is
 * still waiting for an answer. One legacy shape falls on that side and should
 * not — a delivery whose ONLY option was "Landa e pubblica", which
 * `parseQuestionBlock` filters out of the rendered list. The envelope no longer
 * prompts for that option, so that shape only survives on old cards.
 */
export function questionAsksHuman(q: { options: readonly string[] } | null | undefined): boolean {
  if (!q) return false;
  if (q.options.length === 0) return true;
  return !q.options.every(isBoardActionLabel);
}

/** Il minimo che serve per riconoscere una domanda in coda al thread. */
export type PendingQuestionComment = { content: string; kind?: string | null };

/**
 * Is this row somebody's WORD, as opposed to the thread's plumbing?
 *
 * Two kinds are not: 'status' (transition history, written on every move, never
 * anybody's word) and 'service' (the dispatcher's own bookkeeping, marked at the
 * source). Both can land AFTER the agent has spoken, and every surface that asks
 * "what did the thread say last" has to skip them or it reads the plumbing as
 * the answer: the quick-reply buttons vanish because a queue-hold note took the
 * question's place, the card quotes "In attesa di uno slot" as the delivery.
 *
 * ONE predicate, because there are three readers of that question -
 * `pendingQuestion` here, the card's `selectCardComments`, the drawer's own
 * last-word - and a card whose buttons and whose text disagree is worse than
 * either being wrong: it looks answerable and answers something else.
 */
export function isThreadSpeech(comment: { kind?: string | null } | null | undefined): boolean {
  return !!comment && comment.kind !== 'status' && comment.kind !== 'service';
}

/**
 * La domanda pendente di un task: l'ULTIMA parola dell'agente, se è un blocco
 * ```question.
 *
 * Stessa lettura della card e del drawer (`parseQuestionBlock` sull'ultimo
 * commento, righe `kind: 'status'` escluse perché sono cronologia delle
 * transizioni, non parole di nessuno). Se il banner mostrasse opzioni diverse
 * da quelle della card, quale delle due superfici crede non sarebbe più una
 * domanda con risposta.
 *
 * Due lettori su due lati del filo: il server, che mette la domanda nel fronte
 * `task:review-ready`; e il client, che se la ricava da sé quando il fronte non
 * la porta (server più vecchio del client).
 */
export function pendingQuestion(
  comments: readonly PendingQuestionComment[] | null | undefined,
): { text: string; options: string[] } | null {
  if (!comments || comments.length === 0) return null;
  const speech = comments.filter(isThreadSpeech);
  const last = speech[speech.length - 1];
  if (!last) return null;
  const parsed = parseQuestionBlock(last.content ?? '');
  // Una domanda senza opzioni non ha tasti da offrire, ma resta una domanda: la
  // si dichiara comunque, così chi legge sa che il task ASPETTA una risposta e
  // non è una consegna da approvare.
  return parsed ? { text: parsed.question, options: parsed.options } : null;
}

/**
 * LA PASTIGLIA «NON SU MAIN» PARLA SOLO DI CIÒ CHE È STATO MISURATO.
 *
 * Diceva `status === 'done' && landingState === 'unlanded'`, cioè metà colonna e
 * metà verdetto. Misurate il 13/08 le 14 card che la portavano: 2 erano debito
 * vero, 2 avevano il contenuto su main (un verdetto scritto da un land fallito e
 * mai più riguardato), 3 erano state SUPERATE da lavoro atterrato dopo, e 4 non
 * hanno mai avuto uno sha di consegna — su quelle non è stato verificato niente,
 * mai, e il rosso era la parola di nessuno.
 *
 * Le prime tre righe le raddrizza il verdetto (l'audit periodico, che adesso
 * ricontrolla anche un `unlanded` testimoniato e non chiama debito ciò che
 * qualcuno ha rifatto). Questa funzione chiude l'ultima, ed è la regola che vale
 * per tutte: senza la FOTOGRAFIA della consegna — il commit registrato quando il
 * task è entrato in review — non c'è niente su cui una domanda sia stata posta,
 * quindi non c'è nessuna risposta da mostrare. Si tace.
 *
 * Vive in `shared/` perché la stessa pastiglia la disegnano in tre (la card, la
 * banda del drawer, e il primo gradino del controllo «Consegna» in barra), e tre
 * predicati copiati sono tre momenti diversi in cui uno dei tre smette di essere
 * vero.
 */
export function showsLandingDebt(task: {
  status: TaskStatus | string;
  landingState: string | null | undefined;
  deliveryCommit: string | null | undefined;
}): boolean {
  // Solo `done`: una card in review non è ancora atterrata per definizione, e
  // segnalarlo lì sarebbe rumore su ogni consegna.
  if (task.status !== 'done') return false;
  // `unverifiable` non è un'accusa più debole: è l'assenza di un verdetto.
  if (task.landingState !== 'unlanded') return false;
  return !!task.deliveryCommit;
}

/**
 * THE CARD HAS ALREADY PRODUCED WHAT IT WAS ASKED FOR.
 *
 * A card waiting to START and a card that has already DELIVERED are two
 * different things, and the board has three independent marks that say the
 * second one: the delivery snapshot (`deliveryCommit`), the landing verdict
 * (`landingState === 'landed'`), and the column itself (`review` = handed to a
 * human). Any one of them is enough.
 *
 * Measured on 28/08 on a landed parent: closing its last subtask released it as
 * if it were a peer blocker, and the parent went back to `in_progress` with an
 * agent on top of work that was already on main. Two damages, and the second is
 * the silent one: re-queueing wipes `landingState`, so the card stops saying it
 * landed while git still says it did.
 */
export function hasDeliveredWork(task: {
  status?: TaskStatus | string | null;
  landingState?: string | null;
  deliveryCommit?: string | null;
}): boolean {
  if (task.landingState === 'landed') return true;
  if (task.deliveryCommit) return true;
  return task.status === 'review';
}

/**
 * ITS WORK IS ON MAIN, and that is a fact about git, not about the card cycle.
 *
 * Narrower than `hasDeliveredWork` on purpose: sending a delivered card back to
 * the agent is the normal way to ask for more, but sending back a LANDED one
 * re-opens a cycle over content that is already merged — and the re-queue
 * clears the very field that recorded the merge.
 */
export function isLandedWork(task: { landingState?: string | null }): boolean {
  return task.landingState === 'landed';
}

// ─────────────────────────────────────────────────────────────────────────────
// Deploy proposed at approve (board_settings.deployCommand) — analogue of
// `landingState`, but for running a command instead of a git merge.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a card stands relative to the deploy proposed at approve: `'proposed'
 *  | 'running' | 'deployed' | 'failed' | null` (`null` = never proposed —
 *  board with no `deployCommand`, or a card not yet approved). Kept as the
 *  literal union everywhere it is used (`Task.deployState`, this function's
 *  parameter): nothing validates it against a runtime list yet, so a named
 *  type here would be a second declaration nobody imports. */

/** The button's text — a reserved quick-reply, executed by the server and
 *  never by the agent (same treatment as `LAND_ACTION_LABEL` above). */
export const DEPLOY_ACTION_LABEL = 'Deploya ora';

/**
 * THE SAME PILL as `showsLandingDebt`, for deploy: persisted, not derived from
 * the thread, so a card reopened after a network error does not lose the
 * button just because the proposal comment has scrolled out of view.
 *
 * Holds on ANY status of the card (not just `done`): a post-approve `reject`
 * does not withdraw a deploy proposal already made, and that is intentional —
 * the deploy is an action on the BOARD (the main checkout), not a verdict on
 * the task.
 */
export function showsDeployProposal(task: { deployState: string | null | undefined }): boolean {
  return task.deployState === 'proposed';
}

/**
 * La ricevuta di un land — il server risponde `202` (accodato), non `200`
 * (fatto).
 *
 * Esiste perché `POST …/tasks/:id/land` rispondeva `200` con la card e faceva
 * la fusione dopo (`void landTask(...)`): chi chiamava riceveva la card, non
 * l'esito. Misurato l'11/08, ~20 land in raffica ⇒ 4 fusioni riuscite e 16 card
 * chiuse col codice ancora sul loro branch, senza una riga che lo dicesse.
 *
 * `ahead` è quante fusioni ci sono davanti sulla stessa board: toccano tutte
 * main nello stesso checkout, quindi vanno in fila — e mettersi in fila si dice.
 */
export type LandingPhase = 'queued' | 'running' | 'settled' | 'failed';

export interface LandingTicket {
  taskId: string;
  phase: LandingPhase;
  /** Quanti land ci sono DAVANTI a questo nella stessa fila. 0 = tocca a lui. */
  ahead: number;
  queuedAt: string;
  /** ISO in cui il ticket si è chiuso, `null` finché non è finito. */
  settledAt: string | null;
  /** Il motivo del `failed`. `null` in ogni altra fase. */
  error: string | null;
  /**
   * L'esito del land, disponibile su `phase === 'settled'`. `null` finche'
   * non e' finito o se l'esito non e' determinabile.
   * - `landed` il commit e' su main
   * - `unlanded` il merge e' stato rifiutato (checkout sporco, conflitto, ecc.)
   * - `unverifiable` il merge e' uscito zero ma non si e' potuto rileggere main
   * - `skipped` non c'era niente da atterrare (nessun ramo proprio)
   * - `nothing` il ramo non portava commit che main non avesse gia'
   */
  outcome: 'landed' | 'unlanded' | 'unverifiable' | 'skipped' | 'nothing' | null;
  /**
   * La ragione del rifiuto quando `outcome === 'unlanded'`. Corrisponde al
   * testo scritto nel thread della card dal sistema. `null` in tutti gli
   * altri casi.
   */
  reason: string | null;
}
