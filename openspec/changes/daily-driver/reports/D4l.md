# D4l · Swipe dal bordo nel viewer

## Barra prima

- Worktree pulita su `daily/d4l-edge-swipe`, Bun 1.4.2.
- `./scripts/qa-gate.sh --veloce`: exit 0. Il comando era partito prima del codice ma è terminato durante la scrittura, quindi non vale come baseline indipendente.

## Barra dopo

- `bun test client/src/lib/edgeSwipe.test.ts`: 6 pass, 0 fail, exit 0.
- Mutazione in copia, navigare da qualsiasi punto: 5 pass, il caso dal centro fallisce, exit 1.
- `bun run typecheck:e2e`: exit 0. `bun run typecheck`: exit 0. `bun run lint`: exit 0, 4 warning in file preesistenti non toccati.
- `bun run check:spec-coverage`: 1279/1279 coperti, 0 scoperti, ambigui o penzolanti, exit 0.
- `./scripts/qa-gate.sh --veloce`: tutti i cancelli verdi, exit 0. `check:bloat` passa con `DomCoBrowse.tsx` a 786 righe.
- `git diff --check`: exit 0.

## Fatto

- Swipe orizzontale entro 20 px dal bordo: sinistra torna indietro, destra avanti; soglia `min(30% della pane, 120 px)`, con slop di 8 px che preserva i tap. `client/src/lib/edgeSwipe.ts` è pura e coperta da 6 unit test.
- Il viewer mostra una freccia che segue il dito e si riempie alla soglia. Durante lo swipe riconosciuto non scorre né inoltra scroll; al rilascio invia una sola azione di navigazione. Centro e gesto che si impegna prima in verticale restano sul percorso di scroll. Selezione e lock dell'agente bloccano la navigazione.
- La logica touch è in `useDomCoBrowseTouch`: `DomCoBrowse.tsx` resta sotto il tetto di 800 righe.
- Nuovo requisito `BROWSER-DOM-NAV-EDGE-01`, coperto dalla unit e dalla nuova spec e2e; l'host e2e conta back e forward ricevuti.
- Il bordo è misurato sul contenitore del viewer, perché il mirror può essere centrato e più stretto della pane. Una revisione interna di Codex ha fatto correggere due casi: scroll di avvio prima di riconoscere l'asse e tap al bordo con jitter.

## In revisione

- Sul telefono i due bordi dello schermo sono già del cassetto (`useSidebarSwipe`, 28 px, attivo
  solo nel layout a una colonna, `useLayoutMobile`, sotto i 768 px): con il viewer a tutta larghezza lo stesso dito avrebbe aperto il
  cassetto e fatto «indietro» insieme. Lì il viewer non avvia lo swipe; su iPad e desktop, dove il
  gesto del cassetto è spento, resta pieno. Il riconoscimento della striscia è
  `startsOnScreenEdge`, con il suo unit.

## Trovato e non fatto

- `tests/e2e/browser-edge-swipe.spec.ts` non è stata eseguita sul Mac: il BRIEF vieta le e2e locali per questa spec. `typecheck:e2e` è verde; runtime, video e mutazione del caso centrale attendono il workflow CI «Clip di consegna».
- Nessuna prova su iPad vero, fuori ambito dichiarato.

## Rifiutato

- Nessun altro falso positivo. Il primo gate ha rilevato davvero il superamento del tetto di bloat; l'estrazione del hook l'ha riportato sotto soglia.
