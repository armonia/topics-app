# D4c · Stato e interruttore del mirror nativo

## Barra · prima → dopo

- Prima: test server esistenti `bun test server/browser-host-mirror.test.ts server/browser-ws-messages.test.ts` → 38 pass, 0 fail, exit 0. Nessuno stato host, nessun interruttore di condivisione.
- Dopo: `bun test server/browser-host-mirror.test.ts server/browser-ws-messages.test.ts client/src/lib/nativeDomHost.test.ts client/src/hooks/nativeExecutorSocket.test.ts` → 77 pass, 0 fail, 168 assert, exit 0. `./scripts/qa-gate.sh --veloce` → tutti i cancelli verdi, exit 0; `bun run typecheck` include `typecheck:e2e`, exit 0; `bun run lint` exit 0. `git grep -n 'nativa (privata)' -- client/src` → 1, exit 1 come richiesto. `git diff --check` exit 0.
- Mutazione in copia: rimosso il rifiuto input dopo lo stop; il solo test del gate input è rosso, atteso 0 input host, ricevuto 1, exit 1.

## Fatto

- `server/browser-host-mirror.ts`, `server/lib/native-dom-host.ts`, `shared/browser-ws-messages.ts`, `server.ts`: stato host limitato al suo socket, conteggio per dispositivo, traffico aggregato in KB/s, età dell’ultimo frame e ultimo errore di relay. Aggiornamenti accorpati a non più di uno al secondo.
- Stop condivisione: arresta il recorder, svuota il buffer e rifiuta ogni messaggio viewer prima del relay. I viewer vedono la pausa; chi entra durante la pausa non riceve snapshot. Ripresa richiede il nuovo snapshot. La pausa sopravvive anche alla disconnessione dell’host e impedisce il fallback Chromium.
- `client/src`: pillola nella tab, stato nel foglio, comando stop/ripresa, avviso nel viewer; etichetta aggiornata in italiano e inglese.
- `server/browser-host-mirror.test.ts`, `server/browser-ws-messages.test.ts`, `tests/e2e/browser-host-status.spec.ts`: conteggio device, privacy del messaggio, stop/input/frame, snapshot alla ripresa e contratto; requisito `BROWSER-NATIVE-HOST-STATUS-01` in `openspec/specs/remote-browser/spec.md`. Copertura spec: 0 scoperti.
- E2E non eseguita sul Mac come prescritto; `typecheck:e2e` è verde. La spec con video resta alla CI «Clip di consegna».
- Nessun commit o push. `git add -N` sul `.git` protetto è fallito; i cancelli sono stati eseguiti con un indice temporaneo in `/private/tmp`, senza alterare l’indice condiviso.

## Revisione (15/10)

- Lo stato andava al primo socket nativo del contesto, non all'host registrato: con due finestre sullo stesso contesto la pillola poteva comparire su quella sbagliata. Ora `hosts.isHost`.
- Il foglio mostrava «0.0 KB/s · 45000 ms» su una pagina ferma: quel numero è l'età dell'ultimo frame, non un ritardo. Ora dice «ultimo frame 45 s fa» (`browser.tab.hostLastFrame`).
- La e2e non provava il punto 3 del brief: la pagina contava i tocchi ma nessuno toccava. Ora un secondo viewer su WebSocket grezzo, che ignora la schermata di pausa, manda lo stesso clic: arriva mentre il Mac condivide (controllo), non arriva in pausa. Il punto di sincronia è la sua chiusura: il server tratta i frame di un socket in ordine e la chiusura dopo, quindi quando l'host vede scendere i dispositivi il clic in pausa è già stato scartato.
- **L'interruttore non funzionava.** La prima clip (run 38697963916) era rossa: l'avviso di pausa non compariva mai. Il Mac manda `set_native_host_sharing` dal socket dell'esecutore, e `server.ts` scarta ogni frame di quel socket che non è in `NATIVE_DELEGATE_FRAME_TYPES` (`server/browser-native-delegate.ts`) prima di arrivare al ramo che lo gestisce. I test unitari chiamavano `hostMirror.setSharing` direttamente e non lo vedevano. Ora il tipo è nell'elenco, e il test dell'elenco lo nomina.
- Clip dopo la correzione: run 38700373273 verde (1 passed, 9,6 s). Mutante che toglie il rifiuto dei viewer in pausa da `routeViewer` (run 38700377104): rosso alla riga 46, «a tap sent while the Mac does not share must not reach the page», 2 tocchi invece di 1.

## Trovato e non fatto

- Il bottone vero nella UI Tauri non lo preme nessun test: la e2e manda lo stesso frame che manda `createNativeDomHost().setSharing`, dal socket dell'esecutore.

## Rifiutato

- `git grep` exit 1 è l’esito corretto: la dicitura «nativa (privata)» non compare più. I quattro warning React di lint sono avvisi preesistenti, 0 errori; nessuno riguarda il nuovo stato.
