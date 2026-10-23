# D6 · Per tutti: si installa, si capisce da sola, si aggiorna, si usa anche fuori casa

Regole comuni: `tracks/_comuni.md`. Porta a termine change che esistono già, e non ne riscrive le
decisioni.

**GOAL.** Una persona del team installa Topics sul suo Mac o sul suo PC e arriva alla prima
conversazione utile senza aiuto. Poi lo usa ogni giorno: si aggiorna da solo, dice da solo cosa non
va, e si apre dal telefono anche fuori dalla rete di casa.

## Da dove si parte

- **`primo-avvio`.**
  - Proposta del 27/08, con i bivi chiusi.
  - Nel client non c'è niente: `git grep` di `onboarding` e `firstRun` in `client/src` trova 0 file.
  - Chi apre l'app la prima volta vede l'app vuota.
- **`relay`.**
  - Il Mac chiama fuori, il relay è un Durable Object per installazione, e i payload sono cifrati
    end-to-end.
  - 14 compiti su 24 spuntati, ultimo commit 14/09.
- **Quasi finite:**
  - `device-auth`, 19 compiti su 20;
  - `sharing-orgs`, 26 su 30.
- **Due percorsi diversi.**
  - Il proprietario usa un server dal checkout, sotto launchd.
  - Gli altri usano l'app installata, con il server compilato dentro.
  - Chi sviluppa non vede i difetti dell'installato: il bridge PTY, per esempio, è in Node da una
    parte e in Rust dall'altra (D3).
- **Concorrenti.**
  - Happy e OpenCode abbinano il telefono con un codice o un QR (`docs/competitors/happy.md`,
    `opencode.md`).
  - Claude Code ha Remote Control, con sole connessioni HTTPS in uscita, e un'app mobile
    (`claude-code-native.md`).

## Cosa si fa

1. **Primo avvio.** Si costruisce come lo descrive `primo-avvio`: una schermata, quattro riquadri con
   lo stato rilevato, saltabile.
2. **Relay.** Si finisce `relay`. L'abbinamento del telefono passa da un QR, con il flusso di
   approvazione di `device-auth`.
3. **Stato e diagnosi**, sulla regola «ogni funzione ha un interruttore e uno STATO».
   - Una pagina mostra ogni sottosistema: server, bridge PTY, ai-bridge, motori del browser,
     relay, watcher, CLI di Claude e login, dimensione del db.
   - Per ognuno: stato, ultimo errore e cosa fare.
   - `/doctor` in chat mostra la stessa cosa.
4. **Installazione provata da una macchina pulita.**
   - Un job di CI installa il pacchetto della release su macOS, Windows e Linux, avvia l'app e
     aspetta che il server compilato risponda.
   - Lo stesso giro prova l'aggiornamento dalla versione precedente.
5. **Il percorso degli utenti si prova a ogni release.**
   - Le differenze fra server dal checkout e server installato sono elencate in un posto solo, con
     il motivo.
   - Il job di installazione del punto 4 prova il percorso dell'installato.

## Barra

- **Primo avvio.** Scenario spec-flow con video: profilo vuoto, primo avvio, quattro riquadri,
  prima chat. Scenario «Salta»: si arriva all'app di oggi.
- **Relay e telefono.** Scenario e2e: il telefono si abbina col QR, l'approvazione arriva dal Mac, il
  telefono apre un topic attraverso il relay.
  - Un test sul Worker verifica che il payload inoltrato non contenga il testo in chiaro.
- **Mutazione.** In una copia si toglie la cifratura dal client del relay: il test del payload deve
  fallire.
- **Stato.** e2e: si spegne il bridge PTY, la pagina di stato lo mostra rosso con il motivo, si
  riaccende e torna verde.
- **Installazione.** Il job `install-smoke` è verde su tre sistemi: installazione,
  `GET /api/health` entro 20 s, aggiornamento dalla release precedente.
- **Le barre di `primo-avvio`, `relay`, `device-auth` e `sharing-orgs`**, così come sono scritte là.

## Fuori

- Account in cloud e login con password: `device-auth` ha scelto l'identità per dispositivo.
- Un'app mobile nativa: il telefono usa il client web.
