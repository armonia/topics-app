# chrome-devtools-mcp vs il browser di Topics

Valutazione del 2026-08-04. Confronto fatto sui tool **realmente montati**, non
sul README: `chrome-devtools` esposto dal gateway (**29 tool**) contro
`server/browser-tool-spec.ts` (**15 tool**).

> Nota sul conteggio: il task diceva «52 tool». La build montata oggi ne espone
> 29. Il numero grande in giro comprende varianti e alias; il confronto qui sotto
> è su ciò che si può davvero chiamare.

## La conclusione in tre righe

Il divario **non è dove sembra**. Il pattern che ci si aspetterebbe di dover
copiare — lo snapshot ad albero di accessibilità con riferimenti stabili — in
Topics c'è già **ed è migliore** (incrementale). Quello che manca davvero è
l'**osservabilità** (rete, dialoghi) e l'**emulazione** (viewport, throttling).
Tutto il ramo performance/audit è fuori scopo: appartiene al livello QA, non al
browser dell'agente.

## Cosa Topics ha già, e meglio

Da verificare prima di "copiare" qualcosa: tre pattern che chrome-devtools
**non** ha.

| | Topics | chrome-devtools |
|---|---|---|
| snapshot degli elementi | `browser_observe`: a11y con `[ref]`, **incrementale** (~0 token quando la pagina è stabile) | `take_snapshot`: completo a ogni chiamata |
| esito di un'azione | `browser_act` restituisce **da sé** il diff dello snapshot | `includeSnapshot: true` da chiedere, e completo |
| screenshot | salvato su **file**, ritorna il path — l'immagine non entra mai nel contesto | ritorna l'immagine |
| sessioni | `browser_save_state` / `browser_load_state` / `browser_import_chrome` | assente |
| pane native | delega WKWebView (Tauri) | solo Chrome |

Le prime tre righe sono decisioni di **economia di contesto**, ed è la ragione
per cui non conviene adottare `take_snapshot` così com'è: sarebbe un passo
indietro.

## Cosa manca davvero, in ordine di ritorno

### 1. Ispezione della rete — ALTO ritorno, sforzo BASSO
`list_network_requests` / `get_network_request`. In Topics **non esiste**: c'è
`browser_console` ma niente per la rete.

È il divario che pesa di più perché cambia cosa un agente può *diagnosticare*.
Oggi, davanti a «il bottone non fa niente», l'agente può solo guardare la console
e i pixel; con la rete vede la chiamata che è partita, il 401, il payload
sbagliato. Metà dei task d'indagine su questa board sono di quella forma.

Stima: **mezza giornata**. CDP `Network.*` è già raggiungibile dal lato
Playwright; il grosso è decidere il filtro di default (URL, tipo di risorsa,
solo fallimenti) perché una lista non filtrata è un muro di token.

### 2. Gestione dei dialoghi — ALTO ritorno, sforzo BASSO
`handle_dialog`. Assente (l'unica occorrenza di "dialog" nel codice è la
descrizione dell'upload, che parla del *file dialog* del sistema).

Un `alert()`/`confirm()` blocca **tutti** gli eventi successivi della pagina:
l'agente non si "sbaglia", si **pianta**, e la diagnosi che arriva all'umano è
«il browser non risponde». È il costo asimmetrico che giustifica un tool piccolo.

Stima: **2-3 ore**. Un listener sul dialogo + un tool con accept/dismiss e testo
opzionale del prompt.

### 3. Emulazione del viewport — MEDIO-ALTO, sforzo BASSO
`emulate`. Topics **legge** il viewport (`browser_status`) ma non lo **imposta**.

Non è teorico: i due task mobile chiusi su questa board (card sotto i 12px,
affordance della toolbar) sono stati verificati misurando a 390px — e c'è
riusciti solo Playwright, non l'agente. Un agente che non può ridimensionare non
può controllare una resa responsive, quindi quel lavoro non è delegabile.

Stima: **2-3 ore** per il solo viewport. Il resto di `emulate` (throttling di
rete e CPU, geolocalizzazione, user agent, `prefers-color-scheme`) è un'altra
mezza giornata e ha ritorno minore — tranne `prefers-color-scheme`, che serve a
controllare il tema chiaro senza cliccare in giro.

### 4. Riempimento di form in blocco — MEDIO, sforzo BASSO
`fill_form` compila N campi in **una** chiamata; `browser_act` ne fa uno per
volta. Un form di login/registrazione da 6 campi costa 6 round trip contro 1.

Non è solo velocità: ogni round trip è un punto in cui la pagina può cambiare
sotto, e i `[ref]` si riassegnano a ogni observe (lo dice la descrizione del tool
stesso). Compilare in blocco riduce anche quella finestra.

Stima: **2-3 ore** — è un ciclo sopra il percorso `act` esistente.

### 5. Attesa esplicita di una condizione — MEDIO, sforzo BASSO
`wait_for(text)`. Assente: oggi si aspetta osservando di nuovo, cioè con un
poll a spese dell'agente.

Stima: **2 ore**.

## Fuori scopo (non copiare)

`performance_start_trace`, `performance_stop_trace`,
`performance_analyze_insight`, `take_heapsnapshot`, `lighthouse_audit`.

Sono strumenti per **auditare una pagina**, e il browser di Topics serve a
**fare cose sul web** (login, moduli, estrazione). Il livello QA di questa casa è
già deciso e sta altrove: Playwright per la regressione visiva, misura del DOM +
axe-core per i controlli assoluti. Aggiungere Lighthouse qui creerebbe una
seconda risposta alla stessa domanda, che è il modo in cui due sistemi divergono.

Se un giorno servisse un audit di performance, la strada onesta è montare
`chrome-devtools` dal gateway per quella sessione — cosa che funziona già oggi —
non riscriverlo dentro Topics.

## Ordine consigliato

1. **Rete** (½ giornata) — sblocca una classe intera di diagnosi.
2. **Dialoghi** (2-3 h) — costo minimo, evita il piantone.
3. **Viewport** (2-3 h) — rende delegabile la verifica responsive.
4. **fill_form** (2-3 h) — meno round trip e meno finestre di rischio.
5. **wait_for** (2 h).

I primi due valgono da soli più dei restanti tre messi insieme, perché cambiano
*cosa* l'agente riesce a capire; gli altri cambiano *quanto in fretta* fa quello
che già sa fare.
