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

## Trovato e non fatto

- Il video e la prova browser reale del comando sul Mac richiedono la CI «Clip di consegna»; questo checkout non ha una Tauri UI avviabile per quel test e il brief vieta di lanciare e2e sul Mac.

## Rifiutato

- `git grep` exit 1 è l’esito corretto: la dicitura «nativa (privata)» non compare più. I quattro warning React di lint sono avvisi preesistenti, 0 errori; nessuno riguarda il nuovo stato.
