# T9 - Istantaneita' percepita

**GOAL.** Lo streaming di un messaggio lungo non ri-parsa niente di gia' scritto,
una pane nascosta tiene il suo stato, i cambi di vista non tagliano netto, e la
latenza si misura dal guscio vero.

## Perche' ora

Topics e' **oltre lo stato dell'arte sulla misura**: `check-ink-latency`,
`check-route-latency` con baseline in CI, `check-drag-frames`,
`check-scroll-fluidity`, `idle-frame-budget`. Quasi nessuno nella categoria ce li
ha. Quattro buchi precisi.

1. **Il markdown si ri-parsa intero a ogni token.** Il commento lo ammette:
   `client/src/components/ChatMarkdown.tsx:165-172`, «O(n^2) as a message
   streams». La memo e' chiavata su `children`, che cambia a ogni chunk, quindi
   durante lo streaming non prende mai.
2. **Zero `<Activity>`.** I pane nascosti non tengono lo stato ne'
   pre-renderizzano. La memoria del progetto registra questa classe come
   vissuta: «stato muore col pane», «usePaneAlive», «spinner per pane» al
   reload, «bozza e rimonta» del composer.
3. **Zero View Transitions e 5 `useTransition` in tutto.** Apertura e chiusura
   di pane, cambio di tab, card verso drawer tagliano netto.
4. **Nessun numero dal guscio reale.** Tutte le barre girano in Chromium
   sintetico, mentre il prodotto gira in WKWebView.

E una trappola trasversale: la copia locale che regge il primo fotogramma sta in
`localStorage` **al 99,1% dei 5 MiB**, con gli errori di quota inghiottiti. Il
dizionario italiano e' il 21% dell'entry, 187 KB parsati prima di qualsiasi
pixel, e chiudere il debito di lingua lo allarga: le due liste di lavori sono in
conflitto finche' il dizionario non si divide.

## Cosa cambia

1. Markdown diviso in blocchi su confini stabili (riga vuota, heading, chiusura
   di fence), memo per blocco, solo il blocco di coda ri-parsato, completamento
   del markdown parziale. Evidenziazione dei code block rinviata.
2. `<Activity mode={visible ? 'visible' : 'hidden'}>` al posto del rendering
   condizionale dei pane. React 19.2 e' gia' installato, nessuna dipendenza
   nuova. Attenzione ai due casi che 19.3 ha corretto proprio li'.
3. Bump React 19.2 a 19.3 (minore) e marcatura come Transition dei cambi di
   vista, con `addTransitionType` dove lo stesso cambio deve animare in modo
   diverso.
4. `PerformanceObserver({type:'event', durationThreshold:16})` con ring buffer,
   il peggiore della sessione esposto nel pannello perf che esiste gia'. Event
   Timing e' Baseline da dicembre 2025, quindi funziona in WKWebView.
5. Il dizionario si divide per rotta, e la copia locale esce da `localStorage`.

## Barra

- `check:ink` sul messaggio in streaming: costo per chunk O(1).
- `check:inp-shell`, nuovo: p95 dell'interazione dal guscio vero sotto la
  soglia fissata al primo giro.
- Una pane nascosta e riaperta mostra lo stato di prima, con video.
- Nessun errore di quota inghiottito: gli scarti si contano e si vedono.

## Fuori

VirtuosoMessageList. Deciso il 22/10: non si compra, quindi le 2.490 righe di
`MessageList.tsx` restano codice nostro e non sono un lavoro di questa traccia.
