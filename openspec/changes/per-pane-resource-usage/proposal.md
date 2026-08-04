## Why

La status bar sa dire quanto consuma **Topics nel suo insieme** — CPU e memoria, shell
più lato server — ma non sa dire **quale pane** se lo stia mangiando. Con dieci tab
aperte fra browser, terminali e chat, "4,4 GB" non aiuta a decidere cosa chiudere.

La richiesta è un tooltip di consumo su ogni tab, al passaggio del mouse. Cercando dove
attaccarlo è emerso che **il dato non esiste**, su nessuno dei due lati:

- **Shell (Tauri)** — `perf_metrics` cammina l'insieme dei processi "responsabili" e ne
  somma footprint e CPU (`desktop-tauri/src-tauri/src/lib.rs`). Espone `cpu_sampled` /
  `cpu_pids`, cioè *quanti* processi ha misurato, ma **non quale pid appartiene a quale
  webview**: l'associazione non viene mai costruita. Un WKWebView è un processo XPC
  figlio del sistema, non della shell, e nulla oggi lo lega al `label` della sua finestra.
- **Server** — `fleet-usage.ts` risolve le radici per *tipo* (`pty-bridge`, `ai-bridge`,
  `webrtc-bridge`) e somma l'albero di ciascuna. Il pty-bridge è una radice sola con
  sotto **tutti** i `claude` di **tutte** le sessioni: `roots[]` sa dire "il pty-bridge
  tiene 1,2 GB su 14 processi", non "la sessione X ne tiene 300 MB".

Quindi non è un tooltip da aggiungere: è una **mappa pane → processi** da costruire su
entrambi i lati, e poi da esporre. Da qui una change invece di un ritocco.

### Cosa è attribuibile, e cosa no

Non tutte le pane hanno un processo, e questa è la parte che decide la forma della
feature invece di essere un dettaglio:

| Pane | Processo proprio | Attribuibile |
|---|---|---|
| terminale / sessione Claude | sì, albero PTY col pid di testa | **sì** — il bridge lo riporta già |
| browser | sì, webview nativa (`WebviewBuilder::new(&label…)`) | **sì** — via `-[WKWebView _webProcessIdentifier]`, verificata sul runtime |
| topic, kanban, chat, file, editor, session-viewer | **no** — componenti React nell'unico renderer | **no** |

Per l'ultima riga non esiste una misura: sono tutte lo stesso processo, e nessun `ps`
può separare due componenti che condividono un renderer. L'unica cosa onesta è che
quelle pane **dichiarino di non avere un processo proprio**, distinto sia da "non
misurato" sia da uno zero. Una quota stimata (per nodi DOM, per superficie, per quota
parte del renderer) sarebbe un numero inventato con l'aria di una misura, ed è
esplicitamente esclusa (RES-ATTR-05).

Il risultato utile resta: le pane che pesano davvero — terminali con dentro un `claude`,
e browser con dentro un sito — sono esattamente quelle che un processo ce l'hanno.

Il momento è quello giusto perché le due metriche sono appena state rese confrontabili:
la CPU è normalizzata sui core (scala 0-100 della macchina) e la memoria usa
`phys_footprint` da entrambi i lati. Un numero per-pane costruito prima di questi due
passaggi sarebbe nato su unità incoerenti.

## What Changes

- **Mappa pane → pid, lato server.** Il pty-bridge registra, per ogni sessione che
  ospita, il pid del processo di testa. `FleetUsage` guadagna una attribuzione per
  sessione accanto a quella per `kind`, senza perdere i totali di oggi.
- **Mappa webview → pid, lato shell.** La shell associa ogni WKWebView al `label` della
  sua finestra/pane, così il footprint e la CPU già misurati diventano attribuibili.
- **Un canale unico verso il client**, che unisce le due metà e sa dire di ogni pane:
  CPU (scala macchina), memoria (`phys_footprint`), numero di processi.
- **Tooltip sulla tab** (`PaneTabBar`), con lo stesso vocabolario della status bar.
- **Onestà sulla copertura.** Una pane la cui misura non è (ancora) attribuibile — pid
  appena nato senza delta CPU, webview non ancora associata — dice "non misurato", non
  zero. È la regola che il modulo CPU ha già adottato dopo il caso `ps pcpu`, e il
  motivo per cui `cpu_sampled < cpu_pids` viene mostrato invece che nascosto.

## Impact

- **Specs**: `resource-attribution` (nuova capability).
- **Codice**: `server/lib/fleet-usage.ts`, il registro sessioni del pty-bridge,
  `desktop-tauri/src-tauri/src/lib.rs`, `client/src/hooks/useSystemStatus.ts`,
  `client/src/components/Layout/PaneTabBar.tsx`.
- **Rischio principale**: il campionamento per-pane moltiplica le letture per numero di
  pane. Va tenuto sullo stesso TTL della flotta (`FLEET_TTL_MS`, 4 s) e sullo stesso
  `ps` già speso — non una lettura per tab.
- **Non incluso**: nessun cambiamento a come CPU e memoria sono *misurate*. Quella parte
  è chiusa (scala 0-100 sui core; `phys_footprint` su entrambi i lati). Qui si
  attribuisce soltanto.
