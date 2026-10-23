# D2g — «Mostra archiviate» non mette nel DOM tutto l'archivio

Requisito nuovo: `IDLE-03` in `openspec/specs/performance/spec.md`.

## Barra prima/dopo, numeri

- Prima: con «Mostra archiviate» acceso ogni chat archiviata era una riga. Sul database vero del
  15/10: 1.888 archiviate, 1.244 in un progetto, oltre 30.000 nodi DOM contro un budget di 5.000.
- Dopo: ogni gruppo (timeline, progetto, sezione di worktree, sezione per stato, spazio) disegna le
  25 archiviate più recenti e una riga «Mostra altre 25», raggiungibile da tastiera. Fissate e attive
  restano fuori pagina; la ricerca le trova tutte.
- `bun test client/src/lib/sidebarArchivePaging.test.ts`: 4/4 verdi.
- Mutanti, in una copia nello scratchpad: l'helper senza taglio (pass-through) fa 3 rossi su 4;
  l'helper del primo giro, che riordinava, 2 rossi su 4.
- `bun run typecheck`, `typecheck:e2e`, `lint` exit 0; i 20 `check:*` del gate veloce verdi.
  `TopicTree.tsx` 3.014 righe (tetto 3.039): la paginazione sta in `useArchivedSidebarPages.tsx`.
- Scenario e2e nuovo in `tests/e2e/dom-node-budget.spec.ts`: 2.000 archiviate fra due progetti e
  le chat senza progetto; 25 per gruppo, nodi entro 5.000, Invio sulla riga ne aggiunge 25, spento e
  riacceso riparte da 25. Lo gira la CI (clip), con la mutazione del taglio.

## Fatto

- Paginazione pura in `client/src/lib/sidebarArchivePaging.ts`: toglie righe e non riordina mai.
- `useArchivedSidebarPages.tsx` tiene le pagine per gruppo; `ArchivedSidebarMore.tsx` è la riga.
- Testi in `i18n-it.ts` e `i18n-en.ts`, con le chiavi `.one` e `.many` come vuole il file.

## Trovato e corretto in revisione (giro di Codex)

- Spento e riacceso, il gruppo tornava alla pagina di prima e non a 25: lo stato ricordava solo
  l'ultimo valore dell'interruttore. Ora si azzera durante il render, come `NightModeCard.tsx`.
- Le archiviate finivano tutte in fondo al gruppo: con l'interruttore acceso la timeline cambiava
  ordine. Ora la pagina toglie e basta.
- L'e2e non era mai stata girata: cliccava il primo «Mostra altre» aspettandosi il progetto Alpha
  (il primo in pagina è Beta, più recente), chiudeva male il menu prima di aprire i progetti e
  «puliva» con 2.000 DELETE che archiviano soltanto. Ora conta il totale, chiude il menu con
  `closeProfileMenu`, e la pulizia la fa il reset ermetico del file successivo.
- Il requisito era finito sotto `IDLE-01`, che parla di fotogrammi a riposo: ora è `IDLE-03`.

## Trovato e non fatto

- Le e2e che accendono «Mostra archiviate» oggi: `sidebar.spec.ts` e
  `topics-archive-boot.spec.ts`. Seminano poche chat, sotto la pagina: devono restare verdi.

## Rifiutato

- Una finestra virtuale nell'albero: con gruppi, trascinamento e tastiera costa quanto quella della
  board, e le archiviate servono a ritrovare.
- Toccare `ensureArchivedTopics`: fuori dal recinto.
