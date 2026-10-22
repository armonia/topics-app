# D4 · Browser e co-browse: regge le pagine vere, dice cosa fa, e l'agente lo usa bene

Regole comuni: `tracks/_comuni.md`. Dipende da D0. I passi B1 e B2 toccano `nativeDomHost.ts` e
`shared/browser-ws-messages.ts`, che un'altra sessione sta modificando sul ramo
`topics/browser-mac-scroll-mirror`: si fanno dopo il suo merge.

**GOAL.** Il co-browse Mac↔iPad, che nessuno dei 31 concorrenti studiati ha
(`docs/competitors/synthesis.md`), funziona sulle pagine vere e non solo su quelle di prova. Il Mac
dice chi guarda e quanto costa. Un riavvio o uno sleep non fanno perdere niente. L'agente vede e
verifica quello che ha cambiato.

## Da dove si parte: audit del 14/10, sola lettura, misure dal vivo

**Cosa è già al top.**
- Disegno a moduli puri e iniettabili: 70 test unitari verdi nel server su 7 file, 84 nel client su
  8 file.
- Una sola pane per contesto, con la guardia contro il dirottamento
  (`server/browser-native-delegate.ts:109-138`).
- Guardia sul proprietario della porta CDP del sidecar (`server/browser-chromium-sidecar.ts`).
- Schemi permessi a ogni navigazione: http, https, about, data.
- `file://` mai nella pane: il file si serve da `/api/media` con `CSP: sandbox`.
- Auth gate a tre assi (`server/lib/auth-gate.ts`).
- Replayer in sandbox senza script.
- Copertura della spec: 85 requisiti su 95 con `@covers`, tutti quelli del co-browse.

**Punti deboli.**

| id | gravità | cosa | prova |
|---|---|---|---|
| W1 | alta | il primo frame del mirror pesa 2,1-4,8 MB su 4 pagine vere su 5; il server chiude a 1 MiB il socket che porta anche gli op dell'agente | `server.ts:4046` (`maxPayloadLength`), primo drain in un frame solo (`client/src/lib/nativeDomHost.ts:79`, `:337`); riprodotto: chiusura 1006 a 1.126.440 B |
| W2 | media | i frame verso l'iPad viaggiano non compressi, e la compressione darebbe da 7,6 a 8,6 volte meno | `shared/browser-ws-messages.ts:377-382`, `server/browser-host-mirror.ts:205-209` senza il flag di `server/lib/ws-compression.ts` |
| W3 | media | `browser-mirror-scroll-lands.spec.ts:151` è instabile, non corretto: finestre a tempo di 600 e 2.000 ms; su un Mac carico lo stesso salto lo vede l'utente | run 38590516818 rosso 3 su 3, poi verde senza cambi al browser; `client/src/lib/mirrorScroll.ts:20`, `:22` |
| W4 | media | ogni frame passa dal loop principale del server: un fermo di 1,5-8,5 s congela il co-browse | 45 eventi `[LAG]` il 14/10 fra le 10 e le 19, p50 1.468 ms, massimo 8.503 ms |
| W5 | media | dopo un riavvio, un viewer che arriva prima dell'host fa partire un Chromium che muore subito | `server/browser-service.ts:2226`, `server.ts:4360-4410`; 48 SIGTERM nel log |
| W6 | media | al ritorno dell'host si perde la navigazione fatta sull'iPad durante il ripiego | `server/browser-host-mirror.ts:177-193`, nessun test |
| W7 | media | un Mac che dorme si scopre dopo 90-120 s | `server.ts:3119-3120` (battito 30 s, timeout 90 s) |
| W8 | media | sul Mac non si vede che un altro dispositivo guarda e può pilotare la pagina, né quanto costa; l'etichetta «Sessione: nativa (privata)» fa credere il contrario | `client/src/lib/i18n-it.ts:785`, `tabSheetControls.tsx:216` |
| W9 | media | gli iframe cross-origin (pagamenti, video, login) sull'iPad sono un rettangolo vuoto e il tocco non arriva | nessun `recordCrossOriginIframes`; la spec non ne parla |
| W10 | bassa | le pane native non vengono mai scartate: la memoria cresce senza tetto | `client/src/state/pane/residency/policy.ts:111` (`native: Infinity`); due pane da 151 e 259 MB |
| W11 | bassa | codice che non gira: il ramo WebRTC (circa 3.000 righe, il binario non c'è in produzione) e due pipeline rrweb parallele | 0 righe «webrtc» in 6,5 giorni di log |
| W12 | bassa | il traguardo «sotto 150 ms dal tocco alla mutazione» non è mai stato misurato su un iPad vero | la #304 riporta solo la pagina di prova |
| W13 | bassa | le fixture e2e del co-browse sono tutte sotto 1 MiB, quindi W1 passa la CI senza farsi vedere | `tests/e2e/helpers/native-host-page.ts` |
| W14 | bassa | 10 requisiti senza `@covers`, fra storia ed etichette delle tab | `bun run check:spec-coverage` |
| W15 | bassa | rispetto a Safari e Chrome mancano swipe avanti e indietro, blocco dei contenuti, prompt dei permessi e stampa | `docs/browser-confronto-browser-veri.md:148-163` |

**Azioni dell'agente lente** (log del 13-14/10):
- `POST …/browser/act`: p50 3.006 ms, p95 17.778 ms;
- `GET /api/browser/resource`: p95 5.108 ms.

## Cosa prendere dai concorrenti (`docs/competitors/`)

- **Selettore di elemento per l'agente** (Superset, «Design Mode»): si clicca un elemento della
  pagina e all'agente arrivano il frammento di DOM, gli stili calcolati, i metadati del componente e
  uno screenshot del riquadro.
- **Verifica dopo la modifica** (Claude Code, pannello Browser con `autoVerify` e
  `.claude/launch.json`): dopo un cambio al codice dell'anteprima l'agente ricarica, guarda e dice
  se il risultato è quello chiesto.

## Passi, in quest'ordine

1. **B1, mirror a pezzi e compresso (W1, W2, W13).**
   - Lo snapshot va a pezzi da al massimo 256 KiB e il drain ha un tetto in byte.
   - I frame del mirror sopra 1 KiB partono con la compressione.
   - Il limite del server ha un tetto esplicito e un errore leggibile nel log.
2. **B2, eco dello scroll per sequenza, non per tempo (W3).** L'host rimanda l'ultimo scroll
   ricevuto, e il mirror scarta le eco più vecchie qualunque sia il tempo.
3. **B3, stato e interruttore sul Mac (W8).**
   - Una pillola dice «Guardata da N dispositivi», con l'interruttore «Smetti di condividere».
   - Una riga di stato mostra frame al secondo, KB/s, ritardo e ultimo errore.
   - L'etichetta diventa onesta.
4. **B4, riavvio senza Chromium inutili (W5).** Dopo il boot, per un contesto che era ospitato, si
   aspetta fino a 10 s la dichiarazione dell'host prima di lanciare Chromium.
5. **B5, Mac perso in 15 s (W7).** Ping applicativo ogni 5 s sul socket dell'esecutore, host perso a
   15 s, e il viewer viene avvisato subito.
6. **B6, il ritorno dell'host non perde la navigazione (W6).**
7. **B7, il relay del mirror fuori dal loop principale (W4).**
   - Il mirror passa da un Worker.
   - Il ritardo per frame si misura ed entra nella riga di B3.
8. **B8, azioni dell'agente.** Si misura dove vanno i 3 s di p50 di `browser/act` e si toglie
   l'attesa che non serve.
9. **B9, selettore di elemento e verifica dopo la modifica** (dai concorrenti, sopra).
10. **B10, iframe cross-origin dichiarati (W9).** Sul viewer un segnaposto, e il tocco inoltrato al
    frame sul Mac.
11. **B11, tetto di memoria per le pane native (W10).** Sotto pressione di memoria si scarta una pane
    non vista da 10 minuti, che si ricarica al ritorno, come fanno Safari e Chrome.
12. **B12, potatura (W11, W14).**
    - Si decide il ramo WebRTC: tolto, oppure cablato e visibile nel log.
    - Una pipeline rrweb sola.
    - La change superata `browser-native-host-cobrowse` va in archivio.
    - 95 requisiti su 95 con `@covers`.
13. **B13, al tatto come un browser vero (W15, W12).** Swipe avanti e indietro, blocco dei
    contenuti, prompt dei permessi, e latenza misurata su iPad vero.

## Barra

```bash
bun test server/browser-host-big-frame.test.ts       # B1, nuovo
bun test client/src/lib/mirrorScroll.test.ts         # B2, con il caso nuovo a orologio finto
bun test server/browser-host-boot-race.test.ts       # B4, nuovo
bun test server/browser-host-mirror.test.ts          # B6, con il caso del ritorno
bun run check:spec-coverage                          # B10, B12: 95 su 95, nessun requisito scoperto
```

- **B1, test d'integrazione.**
  - Avvia `Bun.serve` con le opzioni WebSocket importate dallo stesso modulo di `server.ts`, non
    una copia.
  - Fa passare un primo drain da 4,8 MB.
  - Verifica che il socket sia ancora aperto dopo 2 s, che il viewer riceva lo stesso
    FullSnapshot, e che ogni frame resti sotto 512 KiB e parta compresso.
  - È rosso su main, con la chiusura 1006.
  - Misura: su Wikipedia «Italia» il primo frame verso il viewer scende da 4,28 MB a meno di 0,7 MB
    sul filo.
  - In CI: `tests/e2e/browser-native-host-sync.spec.ts` con una fixture da almeno 3 MB.
- **B2, ripetizione.** `--repeat-each=30` su `browser-mirror-scroll-lands.spec.ts`, chromium e
  webkit: 0 fallimenti.
- **B3, scenario con video** (`tests/e2e/browser-host-status.spec.ts`, nuovo).
  - Con un viewer connesso, il Mac mostra «Guardata da 1 dispositivo» con KB/s e ritardo.
  - «Smetti di condividere» chiude il mirror.
  - `git grep -n "nativa (privata)" -- client/src` esce 1.
- **B5, caso a orologio finto.** Senza pong per 15 s l'host è perso, e i viewer lo sanno entro 16 s.
- **B7, misura.** Ritardo per frame con p90 sotto 300 ms, e nessun frame fermo oltre 2 s mentre il
  loop principale segnala `[LAG]`.
- **B8, misura.** `browser/act` con p50 ≤ 500 ms nel log di produzione.
- **B9, scenari con video.**
  - Un clic su un elemento manda all'agente DOM, stili e screenshot.
  - Dopo una modifica al CSS l'agente ricarica e conferma.
- **B11, test e misura.**
  - Unit in `policy.test.ts`, rosso su main.
  - Con 8 pane native, 6 delle quali non viste da 10 minuti, la somma dei WebContent delle pane
    sta sotto 600 MB.
- **Mutazione sul punto critico.** In una copia si torna al drain in un frame solo: il test di B1
  deve fallire.

## Fuori

- Le correzioni di sicurezza del browser: sono in D8.
- Il carico del Mac in sé: è nella change `mac-usabile-sotto-carico`.
