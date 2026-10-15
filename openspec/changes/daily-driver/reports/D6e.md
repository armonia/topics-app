# D6e — esito

## Barra prima

`git status --short` → 0 file modificati. Test baseline non eseguiti prima delle modifiche.

## Barra dopo

- `./scripts/qa-gate.sh --veloce` → exit 0: 21 cancelli statici, `check:deadcode-blindspots`, typecheck e lint tutti verdi.
- Test mirati finali (`grants`, `principals`, `identity`, socket, `recipients` e setaccio) → 64 pass, 0 fail.
- `server/guest-media-sizes.test.ts` + `server/security-boundaries.test.ts` → 12 pass, 0 fail.
- Test WS isolato in `project-broadcast-visibility` → 1 pass, 0 fail. Il file intero → 6 pass, 2 fail: i due `iconChange` non ricevono l'evento entro 20 s.
- `bun test server/lib/` → 3010 pass, 2 skip, 3 fail, exit 1. Dettagli sotto.

## Fatto

- **5.2** `isGuestSocketData` legge `principal.confined`; il dato WS non contiene più `deviceRole`. I casi provano che `deviceRole=owner` non prevale su un principale confinato e viceversa. Prova: `bun test server/lib/grants.test.ts` → exit 0.
- **5.3** Ogni socket conserva principali e revisione. Al cambio di `principals_rev`, il filtro li risolve di nuovo prima di decidere sul frame; il test revoca la proprietà a una socket aperta e il frame privato viene respinto senza riconnessione. Prova: `bun test server/lib/socket-principals.test.ts` → exit 0.
- **5.4** L'identità HTTP e la rubrica dispositivi derivano il confinamento dai principali. Query esplicite escludono `role`; le scritture legacy restano compatibili. Il setaccio copre le sorgenti runtime sotto `server/` e `server.ts`, riconosce `SELECT role`, `SELECT d.role` e `SELECT *`. Prova: `bun test tests/unit/no-device-role-read.test.ts` → exit 0.
- **Mutazioni in copia scratch:** ripristinare la decisione su `deviceRole` → 2 test rossi; saltare la ri-risoluzione → 1 test rosso; iniettare `SELECT role FROM devices` → setaccio rosso. Tutti e tre i comandi mutanti sono usciti 1; la copia è stata rimossa.
- 5.2–5.4 spuntati in `sharing-orgs/tasks.md`; `git diff --check` → exit 0.

## Trovato e non fatto

- `bun test server/lib/` ha tre rossi non legati alla traccia: `trash.test.ts` riceve `moveToTrash(...).ok === false`; `dev-bundle-reload.test.ts` riceve 0 eventi invece di 1; `claude-transcript-path.test.ts` fallisce con `EPERM` creando una directory sintetica sotto `~/.claude/projects`. Per renderli verdi serve un ambiente con Trash, watcher e scrittura home funzionanti.
- Il file completo `tests/integration/project-broadcast-visibility.test.ts` ha due rossi in `iconChange` (`gotIt=false` dopo 20 s); il caso WS pertinente passa isolato. Per i due test serve il watcher filesystem operativo.

## Rifiutato

- Rimuovere `devices.role` o `task_shares` non è 5.4: è il passo 8.1, fuori scope, e `role` serve ancora al rollback. Nessuna migration modificata.

## Verifica sul Mac, dopo la consegna

- **I rossi della sandbox non erano rossi.** Sul Mac `bun test server/lib/` esce 0: 3.013 pass, 2
  skip, 0 fail. `project-broadcast-visibility`, `no-device-role-read`, `guest-media-sizes`,
  `security-boundaries`, `browser-viewport-wiring`: 34 pass, 0 fail. Nella sandbox di Codex cestino,
  watcher e scritture sotto la home non funzionano.
- **Chi cambia diritti passando il comando alla regola nuova: nessuno.** Lettura in sola lettura del
  database vivo: 2 dispositivi attivi, entrambi proprietari sia per `devices.role` sia per la regola
  nuova (persona in `installation_owners`, non revocata); 10 revocati, senza poteri in tutte e due.
  Nei log del server dall'8/10 (66 MB) zero avvisi `[principals] divergenza`.
- **Un solo punto crea le socket** (`upgradeWebSocket`), e riceve il principale dall'identità della
  richiesta: le socket locali non hanno `deviceId` e restano del proprietario per scelta.
- Cancelli dopo il commit: typecheck, lint, 0 file non aggiunti, 0 cancelli statici rossi.

## Verifica avversaria, e cosa ne è uscito

- **Il verificatore ha refutato la promessa larga del 5.3**: «una socket aperta segue un cambio di
  principali in entrambe le direzioni» vale per la chat, non per le socket del browser e del
  terminale (autorizzate all'upgrade) né per un focus di attenzione registrato da proprietario.
  Oggi nessun gesto lo produce: nessun codice scrive `installation_owners`, e revoca e
  riassegnazione chiudono tutte le socket del dispositivo (`deviceSockets` si riempie in cima a
  `open`, prima dei rami browser e terminale) e con loro il focus (`forgetSocket`). Promessa
  ristretta in `tasks.md`, limite scritto in `limiti-accettati.md` e accanto al calcolo di
  `confined` in `principals.ts`. Nessun codice nuovo per un caso che il prodotto non produce.
- **`POST /api/auth/logout` revocava senza chiudere le socket**, contro il suo stesso commento
  («uscire è una revoca come le altre»). Nessun client lo chiama oggi; corretto lo stesso perché è
  una riga e toglie l'unica eccezione alla regola. Test nuovo in `auth-routes.test.ts`: rosso prima
  della riga (`closed` vuoto), verde dopo.
- **D6e aveva rotto tre test che nessuno aveva girato** (`tests/integration/auth-routes.test.ts`:
  proprietario rifiutato come destinatario, rubrica senza proprietario, rifiuto come codice). Tutti
  e tre costruivano il proprietario col vecchio `role` su uno schema senza la 084, dove con la regola
  nuova nessuno è proprietario. Riscritti sul modello nuovo (`freshDbWithPeople`: il proprietario è
  la persona di default di `installation_owners`); il primo ora controlla anche il codice
  `device_not_guest`, così non passa per un motivo sbagliato. I 19 file server che costruiscono un
  proprietario: 273 pass, 0 fail.
- Nota del verificatore: `GET /api/auth/devices` ora dice `role: 'guest'` per i dispositivi
  revocati (prima riportava la colonna). Nessuna interfaccia lo mostra; è il verso giusto.
