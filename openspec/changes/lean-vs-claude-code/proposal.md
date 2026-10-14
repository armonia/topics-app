# lean-vs-claude-code: Topics deve costare meno della CLI nativa, non di più

## Da decidere

Il repo è pubblico: pushare il ramo lo pubblica, e senza push lo scenario BOARD-21
non ha il suo video (il Mac non è il posto dove girarlo).

1. Push di `perf/lean-vs-claude-code`, clip di BOARD-21 con il workflow «Clip di
   consegna», poi PR. **Consigliata:** è la sola prova filmata che non carica il
   Mac, e `push-guard` controlla i commit prima che escano.
2. Il ramo resta locale finché il proprietario non lo guarda.

**Risposta (14/10, vedi `.openspec.yaml`): push, PR e merge su main a CI verde.**

## Perché

Il 14/10 Topics è stato messo a confronto con 24 alternative open source alla CLI
di Claude Code e con la CLI stessa, su usabilità, gestione, sistema e core. Due
sprechi misurati sulla macchina vera:

- **I lavori interni pagavano il contesto dell'utente.** Titoli, giudici, scelte
  del modello: 1.119 one-shot in 14 giorni, ciascuno con 14.879 token di prefisso
  (CLAUDE.md, stile di output e hook dell'utente) riscritti nella cache da 1 h, a
  prezzo doppio, perché il prompt cambia a ogni chiamata. Un titolo costava
  $0,0596; senza quel contesto costa $0,0069 (1.722 token).
- **Il feed globale da ~155 KB si scaricava 720 volte l'ora.** Il log del server
  (13-14/10) non dice chi chiede, e la lettura ogni 5 s sembrava dell'app desktop:
  era il contatore di SwiftBar (`claude-sessions.5s.sh`, repo
  `claude-discord-presence`), che scaricava il feed intero per contarci i task
  `in_progress`, il 98% delle letture. Le finestre dell'app lo rileggono a ogni
  evento, fino a 70 volte l'ora, e anche senza cambi lo scaricavano, parsavano e
  confrontavano.

Già fatto lo stesso giorno, fuori dal repo: cartella dati da 8,1 a 0,58 GB (backup
compressi, ripristino verificato byte per byte) e 16 processi orfani chiusi.

## Cosa cambia

1. **One-shot magri** (CCLI-13). Un lavoro interno parte senza CLAUDE.md, stile e
   hook dell'utente. Una risposta che l'utente legge (modifica di un messaggio,
   rigenerazione, ripiego SSE) si dichiara `userFacing` e li tiene.
2. **Feed rivalidato** (KANBAN-98). Il feed porta un ETag; il client lo rimanda e
   su 304 riusa le righe che ha. L'ETag è esposto a CORS: l'app desktop legge da
   `tauri://localhost`, e senza esposizione il suo fetch lo vedeva `null`, cioè il
   rimedio non scattava proprio nella finestra aperta tutto il giorno. L'app desktop di
   questo Mac serve la UI da `public/` del checkout (`topics-dev.json`): il client
   nuovo arriva con la build del client, senza ricompilare Tauri.
3. **Il contatore, fuori dal repo** (`claude-discord-presence` 75122ce): chiede
   `?status=in_progress`, 12 byte e 1-3 ms di server invece di 155.611 byte e
   12-37 ms, con lo stesso conteggio.

## Barra

`specs/acceptance.md`: test unitari e cancelli (escono non-zero), mutazioni sui
punti critici, clip di BOARD-21. Dopo il deploy: nel log del server le letture del
feed ogni 5 s costano 1-7 ms invece di 25-160, le riletture delle finestre senza
cambi tornano 304, e G3 di `topics-bar` torna verde quando
i transcript vecchi escono dalla finestra di 14 giorni. Ciò che è verde resta verde.

## Fuori

- Il contatore resta ogni 5 s: è il suo campionamento della CPU, e ora la lettura
  costa 12 byte.
- La memoria della webview principale (~750 MB): misura a parte.
- Il motore nativo e i suoi termini OAuth: resta com'è (scelta del 14/10).

## Deciso da me

- Chi è «utente» lo dice il chiamante (`userFacing`), non una lista di prompt: due
  chiamanti oggi, e uno nuovo sbaglia verso il risparmio, mai verso la spesa.
- Le impostazioni dell'utente restano caricate (`--setting-sources user,project,local`):
  il loro `env` instrada la CLI verso il proxy degli account. `--bare` no: toglie l'OAuth.
- ETag = hash del corpo (`Bun.hash`), non un `max(updated_at)`: il feed è derivato,
  e solo il corpo dice se è cambiato. Il server lo costruisce comunque; risparmia
  rete, parse e confronto.
- `no-store` resta: un `If-None-Match` messo dalla pagina scavalca la cache HTTP,
  quindi il 304 arriva al codice che l'ha chiesto.
- Le letture d'avvio salvano l'ETag ma non lo mandano: il coalescer condivide la
  richiesta fra chiamanti, e un 304 deve rispondere a chi l'ha chiesto.
- Le letture filtrate (`?status=`) non rivalidano: nessuno le chiama in giro.
- Parità con la CLI 2.1.299 verificata con un turno vero: 0 eventi `unknown`. Non
  entra nella barra fissa, costa una chiamata vera a ogni giro.
