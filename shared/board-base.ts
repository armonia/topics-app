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
 * The SEPARATOR, instead, is TWO characters and not one: `\` as well as `/`.
 * Until 06/09 the basename was cut on `/` alone, and a Windows path contains
 * none: `dirName` became the WHOLE path, so the id was
 * `C:\Users\...\Temp\e2e-archrestore-123-yv2opn` instead of
 * `e2e-archrestore-123-yv2opn`. Measured on the Windows PC on the first e2e
 * run (card 9ff7427c). That id ends up inside a URL path
 * (`/api/boards/<id>/tasks`, where the WHATWG parser rewrites backslashes into
 * slashes: client and server stop naming the same board), in DOM attributes
 * and in the `tasks` rows; the board opened empty.
 *
 * The hash does NOT change (it runs on the whole string, which is untouched):
 * only the part in front moves, and only for paths containing a backslash,
 * that is none of the ones written on macOS or Linux. The ids already written
 * with the whole path (boards born on Windows) are rewritten by the migration
 * `20260907132557-board-id-windows-path`, which cuts at the same point.
 *
 * Parente ma NON la stessa cosa di `shared/project-keys.ts:projectHash`, che
 * gira lo stesso djb2 sulle chiavi `ui_state` ma restituisce l'hash intero e
 * senza prefisso: identità diversa, store diverso, resta separata.
 */
export function projectIdForPath(projectPath: string): string {
  const parts = projectPath.replace(/[\\/]+$/, '').split(/[\\/]/);
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
 * The five headings of a delivery summary, in the order the reviewer reads them.
 * A card left in review must be decidable from the card alone, without opening
 * the diff, the thread or the PR. The headings are written in the reviewer's
 * language and are FIXED on purpose: the server recognises them by exact text
 * (`missingReviewCardFields`), so no prose parser has to guess.
 */
export const REVIEW_CARD_FIELDS = [
  "**Cosa e perché**", // allow-italian: heading matched verbatim
  "**Prova**", // allow-italian: heading matched verbatim
  "**Come verificarlo tu**", // allow-italian: heading matched verbatim
  "**Rischio e come si annulla**", // allow-italian: heading matched verbatim
  "**Decisione**", // allow-italian: heading matched verbatim
] as const;

/** The `Decisione` line of a technical card: nothing for the person to decide. */
export const REVIEW_CARD_NO_DECISION = "nessuna: atterra da sola"; // allow-italian: shown verbatim to the reviewer

export const REVIEW_CARD_RULE =
  `THE DELIVERY SUMMARY IS THE REVIEW CARD. The \`summary\` you send with status="review" must let the reviewer decide from the card alone, without opening the diff, the thread or the PR. Write it in the reviewer's words, no jargon, as five short lines, each starting with its bold heading verbatim and in this order: ${REVIEW_CARD_FIELDS[0]} (1-2 sentences: what changes for the person and why) · ${REVIEW_CARD_FIELDS[1]} (command and exit code, CI link, screenshot or video already attached) · ${REVIEW_CARD_FIELDS[2]} (one gesture, when it takes the human eye; otherwise say none is needed) · ${REVIEW_CARD_FIELDS[3]} (what could break and how to undo it: plain revert, migration, setting) · ${REVIEW_CARD_FIELDS[4]} (one line, your pick first; or "${REVIEW_CARD_NO_DECISION}" when the card is technical). A missing heading gets a warning note on the thread, to fix at the next delivery.`; // allow-italian: the headings are quoted verbatim

/** Headings of `REVIEW_CARD_FIELDS` the text does not contain, in order. */
export function missingReviewCardFields(text: string): string[] {
  return REVIEW_CARD_FIELDS.filter((h) => !text.includes(h));
}

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
  "· VIDEO .webm/.mp4/.mov ≤20s — proving the delivery takes TWO OR MORE STATES (appears, stays, disappears; scroll, open/close, streaming, a multi-step flow): a still screenshot cannot prove a behaviour. Do not open a browser by hand to film or shoot: a task tab (open_browser_pane) that no window shows runs in a headless one. Screenshots and clips come from the project's e2e spec instead: `page.screenshot` at several widths, `test.use({ video: 'on' })`, run with the project's e2e command; if a guard on the machine stops it, follow what it prints. A clip of a surface ALREADY ON SCREEN is `screencapture -V <seconds> -R <x,y,w,h> <file>.mov`, for a browser pane only after `browser_focus_tab` brought it forward. When a card asks for several widths or a side-by-side comparison, the proof is the spec's images, attached with comment_task media. Name the spec in the delivery comment; the preview is a SCREENSHOT of one state, the spec's clip, or a DIAGRAM of the flow.",
  "· DIAGRAM .svg — the delivery has NO rendered surface (a plan, an architecture, a protocol, a migration): you DRAW the structure — boxes, arrows, five words per node — you do not photograph the document.",
  "A TAB of the task (open_browser_pane) does NOT replace the preview: the live page dies with the server that serves it, the preview stays.",
  "The preview is an ATTACHMENT, not source. Never leave it in the repo root: an untracked file there BLOCKS the land (it would be swallowed by the realign merge, and the land refuses rather than swallow it — measured twice on 18/08), and a committed one is repo litter. Write it under ~/.topics/media/, or if it genuinely documents a decision worth keeping, under docs/archive/ — never the root.",
  "The screenshot has to show YOUR work, not the app with nothing open: a shot of the empty \"Welcome to Topics\" shell (no topic selected) is not evidence of anything, and a gate now rejects it on the auto-captured path. Look at the file before you attach it.",
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
  "THE SEVEN CODE GATES, and ALL of them hold before you deliver — the script names you read in `package.json`, the gates you do not: types (`bun run typecheck`), lint (`bun run lint`), dead code (`bun run check:deadcode`), unit tests (`bun run test:touched`, which picks the tests of your diff by itself: the test files you changed plus every test that imports what you changed, and the whole suite when you touched config, lockfile or test setup; do not choose them by hand; the FULL `bun run test:unit` is what the board measures when you deliver, in your worktree or on the pull request CI as the UNIT line further down says, and its verdict comes back in the `update_task` result: do not run the whole suite yourself, and never in the background with nohup, because under a fleet it is the single heaviest thing on this machine and on 2026-09-04 two orphaned copies of it, left by a cut turn, drove the load to 115 on 12 cores), prose (`bun run check:emdash`), comment language (`bun run check:comment-language`), identifier language (`bun run check:identifier-language`: every NEW name you declare, constants and test fixtures included, must be an English word or go into PROJECT_WORDS with a reason; on 2026-09-04 thirty-five Italian test names landed green through the other six and turned main red).",
  "The fifth one is new and it surprises people: `check:emdash` rejects the long dash in ANY text in the repo, protocol strings and the comments you write in the code included. You do not replace it with a short dash: the sentence the dash was holding together was two sentences, and they split. If the character IS the data, the line ends with `// allow-emdash: <reason>`.",
  "THE REPO IS ENGLISH, and that includes the comments you write. `bun run check:comment-language` is a ratchet: it does not ask you to translate what is already there, it fails when a file gains a NEW Italian comment line. So write the comment in English the first time, because a comment written in Italian will not land. When the Italian IS the subject (a quoted message, a term of art, someone's exact words), the line ends with `allow-italian: <reason>`. This is about the CODE. What you write to the person on the board follows the language line above, which is a separate question.",
  "The third one is the one everybody forgets: for the dead-code gate, a file NOBODY IMPORTS is dead code. So a script you run by hand (a probe, a bench, a measurement) has to be DECLARED among the project entries in the same commit that adds it — with knip: the entry with the `!` suffix in `knip.jsonc` (like `scripts/disk-report.ts!`), and next to it the comment line that says how it is run.",
  "E2E NEVER RUNS ON THIS MACHINE (decided 2026-09-15): do not run `bun run check:e2e-touched` (only `--list`, which launches nothing), `playwright test` in any form, or a client build meant for e2e, and never install or launch a browser, in the foreground or in the background. In 15 hours on 2026-09-15 agents ran 21 `check:e2e-touched`, 71 raw `playwright test` and 27 client builds by themselves, 99 of those 119 backgrounded with `&`, while the board re-ran the e2e at delivery anyway. Write or change the e2e spec under `tests/e2e/` and commit it; whether this board measures it when you deliver is said by the E2E line further down. Targeted `bun test <file>` stays allowed.",
].join("\n");

// end-allow-emdash

/**
 * THE TWO ACTIONS THAT LEAVE THE MACHINE, and how they are asked for.
 *
 * A dispatched agent reads ONLY the envelope: no CLAUDE.md, no docs/. So two
 * tools that are not named here do not exist for it, and it will hand a draft
 * email back to the person in a comment because it does not know it could send
 * it.
 *
 * The line also says the thing a model would get wrong on its own: the
 * confirmation is NOT a step it performs (ask in the thread, wait for a
 * comment, then send). The SERVER stops and opens the question, one per
 * message. An agent that "asks first" by itself makes the person answer twice,
 * and the second wait is the real one.
 */
export const OUTBOUND_TOOLS_RULE =
  "MAIL AND GOOGLE ARE TOOLS, and the confirmation is NOT yours to run. `send_mail(to, subject, body, account?, attachments?)` sends from one of the mailboxes this installation declares; `google_call(service, resource, method, params?, body?)` reads and writes Drive, Calendar, Sheets, Docs, Tasks, People and Gmail through one door. Call them with the FINAL text: the server opens the confirmation itself, in this card's thread, and nothing is spawned until a person answers, ONE answer per message (a yes never covers the next one). So do not ask in the thread first and do not wait for a comment before calling: that makes the person answer twice. Google reads run with no question; anything that writes asks. Every send and every write leaves a one-line trace on the card, without the body. Attachments must be paths inside your workspace, and their BYTES are frozen when the question is asked: the person is shown name, size and fingerprint, changing the file afterwards changes nothing except that you are asked again, and a frozen copy that does not match what was confirmed stops the send instead of leaving. That check runs right before the spawn and does NOT make the send tamper-proof: anything running as this machine's user is already inside the boundary and can call the mail CLI without Topics at all, so the confirmation is worth exactly two things - it stops MISTAKES and it leaves a trace on the card. ONE CONFIRMATION PER CARD AT A TIME: if another session of this task already has one open, yours is refused with that reason - come back when it is closed, do not open a second one. SENDING MAIL IS NOT ON THE GOOGLE DOOR: every Gmail call that puts a message on the wire is refused there, use `send_mail`; that door takes API names (letters, digits, dot, underscore) in its four fields and nothing else.";

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
 * How an agent offers a choice to the human on the board: its own pick first, marked.
 *
 * Measured on 2026-09-15 over 2,486 agent comments (45 days): 78 decisions went out
 * as quick-reply buttons and only 13 of them said which option the agent would take.
 * The human then decides blind, or opens the thread to reconstruct a view the agent
 * already had. The in-chat panel solves this with `recommended: true` (a chip); board
 * options are plain strings, so the mark lives in the label. The word follows the
 * language the agent is writing in, which is why both spellings are named.
 *
 * AND THE MARK STOPS AT THE RESERVED LABELS, which is not a nicety: the option text
 * travels to the server and is matched BY VALUE (see `normalizeActionLabel` and the
 * block on `LAND_ACTION_LABEL` below), and the suffix survives normalization because
 * it is made of letters. Measured on the live DB on 2026-09-16: of 1,451 comments
 * carrying a ```question fence, 1,166 offer `Landa su main` and 34 offer
 * `Approva il piano` — this is the dominant branch, not an edge case. A marked
 * `Landa su main (consigliata)` stops being a board action (`isBoardActionLabel`
 * false, `questionAsksHuman` true): the click wakes the agent up instead of merging.
 * A marked `Approva il piano (consigliata)` stops arming `tasks.plan_comment_id`
 * (`hasPlanApproveOption` false), which is the exact regression the comment on
 * `PLAN_APPROVE_LABEL` records as already paid for. The labels are spelled out here
 * rather than interpolated because they are declared further down this module and a
 * template literal would read them in their temporal dead zone; the drift gate is the
 * test that asserts this string quotes each of them verbatim.
 */
export const RECOMMENDED_OPTION_RULE =
  "WHEN YOU OFFER OPTIONS, YOUR PICK GOES FIRST AND SAYS SO. Put the option you would choose as the first element of `options` and end its label with \" (consigliata)\", or \" (recommended)\" when you are writing in English. In the same one-line question, add why in a few words. Only when you truly have no preference, say that instead and name what would settle it. A neutral list hands the human a decision you were in a position to make. NEVER MARK A LABEL THE BOARD EXECUTES ITSELF: `Landa su main`, `Landa e pubblica`, `Approva il piano`, `Da rivedere`, `Rimetti in coda i sottotask`, `Archivia i sottotask`, `Promuovi i sottotask a task`, `La prendo in mano io`. Those are a contract the server matches BY VALUE, and a suffix breaks it. A marked `Landa su main` is no longer a merge order but a question that only wakes you up again, and a marked `Approva il piano` never registers the comment as the plan. Offer those VERBATIM and put your pick first by ORDER alone."; // allow-italian: the reserved labels are quoted verbatim on purpose, the server matches them by value

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

/**
 * The park reason written when a board cannot be mapped back to a project
 * directory. It doubles as the marker `sweepUnresolvedProjectParked` matches
 * on, so only cards parked for exactly this cause come back by themselves.
 */
export const UNRESOLVED_PROJECT_PARK_REASON =
  "Auto-dispatch fermato: la cartella del progetto di questa board non si trova. " + // allow-italian: stored reason, matched by value
  "La card torna in Todo da sola appena si ritrova."; // allow-italian: stored reason, matched by value

/**
 * The text this park wrote before the automatic return existed. Rows carrying
 * it were parked for good by a person's decision as much as by the cause, so
 * the sweep never matches it; only the hand gesture clears it.
 */
export const LEGACY_UNRESOLVED_PROJECT_PARK_REASON =
  "Auto-dispatch fermato: non riesco a risalire alla directory del progetto per questa board. " + // allow-italian: stored reason, matched by value
  "Apri il progetto in una tab (o registralo) e riporta il task in Todo."; // allow-italian: stored reason, matched by value

