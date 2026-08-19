# Mappa del browser di Topics

Sintesi della serie «Browser: cosa ci manca davvero» (card padre `a68393f4`).
Misura del 19/08/2026, fatta sul codice, non sui README.

**Fonti.** `~/Downloads/browser-main` (Pippo, browser WebKit/SwiftUI nativo per
macOS 15+: 175 file Swift, 25.593 righe, 13 aree in `pippo/Features`), il codice
di Topics (`client/src/components/Browser/*`, `server/browser-*.ts`,
`desktop-tauri/src-tauri/src/lib.rs`), e la valutazione del 04/08 in
`docs/chrome-devtools-mcp-vs-topics-browser.md`.

## In tre righe

Il divario con un browser vero non è sul motore: è sull'**ingresso** e sulla
**memoria**. Topics apre benissimo una pagina che gli hai già dato, ma non ti
aiuta a trovarla, e domani non se la ricorda. Il lato agente, che ad agosto era
il buco (rete, dialoghi), nel frattempo si è chiuso: quel confronto oggi lo
vinciamo.

## 1. Elenco spuntato

Legenda: **sì** presente, **metà** parziale o indiretto, **no** assente,
**n/a** non ha senso in quel prodotto.

### A. Navigazione, cioè quello che fa una persona

| | Topics | Pippo |
|---|---|---|
| indietro/avanti, con la cronologia sul tasto premuto a lungo | sì | sì |
| ricarica | sì | sì |
| ferma il caricamento | no (c'è la barra di avanzamento, non il tasto) | sì |
| barra indirizzo con host in evidenza e `https://` nascosto | sì | sì |
| suggerimenti mentre scrivi | **no** | sì (`Features/Launcher/Suggestions`) |
| motore di ricerca scelto dall'utente | **no** (Google fisso in `browserNavUrl.ts:204`) | sì (`SearchEngineService`) |
| pagina della scheda nuova | metà (in costruzione, card `3bf61316`) | sì |
| cronologia globale, cercabile | **no** (solo gli URL recenti della pane) | sì (`Features/History`) |
| preferiti | no (si fissa la *tab di Topics*, non il sito) | no (stessa scelta: tab fissate) |
| trova nella pagina, con n/m | sì | sì |
| download con avanzamento | sì | sì |
| menu contestuale nella pagina | sì | sì |
| favicon, con segnaposto quando manca | sì | sì |
| zoom | sì | sì |
| picture in picture | metà (quello che dà WebKit dal player, nessun comando nostro) | sì (`Features/Player`) |
| blocco contenuti e pubblicità | no | sì (`AdBlockService` + liste filtro) |
| password e passkey | no (deleghiamo al sistema) | sì (`Features/Passwords`) |
| importazione da un altro browser | metà (solo i cookie da Chrome) | sì (`Features/Importer`) |
| lettore, traduzione, stampa | no | metà |
| browser predefinito del sistema | n/a | sì (`DefaultBrowserManager`) |

### B. Identità e sessione

| | Topics | Pippo |
|---|---|---|
| profilo dati isolato per scheda | sì (uno store per `contextId`) | sì (spaces e profili) |
| navigazione privata | metà (ogni pane nasce già isolata) | sì |
| «dimentica questo sito», che elenca prima di cancellare | **sì** | no |
| import dei cookie dal Chrome dell'utente | **sì** (`browser_import_chrome`) | n/a |
| stato di login salvato e reiniettabile altrove | **sì** (`browser_save_state`/`load_state`) | no |
| pulizia della cache senza perdere il login | **sì** (`browser_purge_cache`) | no |

### C. Guida da agente (qui il metro è chrome-devtools, non Pippo)

16 tool montati in `server/browser-tool-spec.ts`. I due buchi nominati il 04/08
sono **chiusi**: `browser_network` esiste, e i dialoghi non bloccano più la
pagina in silenzio (`browser_status.lastDialog`). Restano nostri e non
replicati altrove: snapshot **incrementale** con `[ref]` stabili, screenshot che
torna un *path* e non entra nel contesto, sessioni salvabili, lettura a video
via modello di visione.

### D. Il guscio, dove non c'è partita

Schede, split e gruppi del progetto; la stessa pane vista dal telefono (co-browse
cross device); tre motori sotto la stessa superficie (WKWebView nativa,
Chromium dell'utente per le estensioni, sessione condivisa sul server);
reclamo e smontaggio delle viste orfane; la pane come **tab di un task**, che
resta lì per chi rivede il lavoro.

## 2. Pane oppure scheda nuova: il criterio

È la domanda che decide tutte le altre, e la risposta non è «quanto browser
vogliamo fare», è **di chi è la pagina**.

- **Pane dentro un topic = uno strumento.** La pagina appartiene a un lavoro:
  l'ha aperta l'agente o l'hai aperta tu per quel lavoro, si guida da fuori,
  regge l'evidenza, e muore quando il lavoro finisce. Qui non servono preferiti
  né spaces: serve che la sessione sia solida, che la memoria si liberi, che
  quello che è successo si possa dimostrare.
- **Scheda nuova = un luogo.** Ci arrivi senza sapere dove vai. Qui servono
  ingresso (suggerimenti, motore di ricerca, pagina iniziale) e memoria
  (cronologia, riapertura), cioè esattamente le tre righe in grassetto della
  tabella A.

Da qui la regola con cui abbiamo scelto le cose che valgono la pena:

> Vale la pena tutto ciò che serve ad **aprire** e a **ritrovare**.
> Non vale la pena ciò che serve ad **abitare** il browser.

Abitare è il mestiere di Safari e di Pippo: preferiti, spaces, blocco contenuti,
gestore di password, lettore, essere il browser predefinito. Se lo facciamo,
manteniamo un secondo browser per sempre e non lo useremo comunque.

## 3. Le quattro cose che valgono la pena

**1. La barra che suggerisce, e la scheda nuova che ricorda.** Storico globale
dei siti con frecency, suggerimenti mentre scrivi, e la pagina iniziale che
mostra i soliti quattro posti. Oggi una pane vuota è un campo cieco: se non hai
l'URL in memoria, non parte niente.
Ritorno **alto**, costo **basso**. Già in corso sulla card `3bf61316`.

**2. La cronologia della pane sopravvive alla pane.** Riaprire dove si era
rimasti quando un topic si riapre, e poter rispondere a «dove ero finito ieri».
Oggi gli URL recenti vivono nella toolbar della pane e muoiono con lei, quindi
il lavoro di navigazione fatto per un task non è né riprendibile né
ispezionabile.
Ritorno **alto**, costo **medio** (persistenza per topic, non un archivio globale).

**3. Le identità salvate diventano una voce visibile.** `browser_save_state` e
`browser_import_chrome` esistono già e li usa solo l'agente. Portarli nella
toolbar («entra come…», «questa scheda usa il profilo X») risolve a mano il caso
più frequente e più fastidioso: la pagina dietro un login.
Ritorno **medio-alto**, costo **medio**: il motore c'è, manca la superficie.

**4. Il motore di ricerca e la pagina iniziale si scelgono.** Google cablato in
una costante è un difetto, non una scelta di prodotto, e costa mezza giornata
levarlo.
Ritorno **medio**, costo **basso**. Da fare insieme al punto 1, è la stessa
schermata di impostazioni.

Una quinta, minore, se avanza tempo: il **tasto ferma** accanto a ricarica, che
oggi manca e su una pagina che non finisce di caricare lascia senza uscita.

## 4. Cosa non copiare, e perché

- **Preferiti e spaces.** Nemmeno Pippo ha i preferiti: usa le tab fissate. Noi
  le abbiamo già, e sono a livello di guscio, dove servono.
- **Blocco contenuti.** Liste filtro da aggiornare, regole da compilare, siti che
  si rompono: manutenzione a vita per un problema che qui non abbiamo (le pane
  vivono su pagine di lavoro, non su portali pieni di pubblicità).
- **Gestore di password e passkey.** Custodire segreti è un mestiere serio; il
  nostro modo è il profilo di sessione, che non conserva password.
- **Browser predefinito del sistema, lettore, traduzione.** Sono il mestiere di
  chi *abita* il browser.
- **Il ramo performance/audit di chrome-devtools.** Già escluso il 04/08:
  appartiene al livello QA, non al browser dell'agente.
