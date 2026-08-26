# Proposal — feature-weight-inventory

## Why

La barra sa dire quanto pesa **Topics in tutto**, e da `per-pane-resource-usage` sa
anche dire quanto pesa **una singola scheda che possiede un processo**. Resta senza
risposta la domanda che uno si fa davanti a «1,8 GB»: **cosa dentro Topics lo tiene**.

Non è la stessa domanda del tooltip per-tab, e non si risponde con lo stesso dato:

- «quale scheda» ha senso quando la scheda **è** un processo (un terminale con dentro
  un `claude`, una pane browser con dentro un sito). Sono già coperte.
- «quale funzionalità» include cose che una scheda non è: i **task** della kanban
  caricati in memoria, le **anteprime** dei topic, la **coda** dei turni, la cronologia
  dei siti, le **tab dei task** — roba che pesa senza avere né una tab né un processo.

### Cosa è misurabile, misurato prima di progettare

Il dato che decide la forma di questa change, letto il 2026-08-20 sull'app viva:

| | misura |
|---|---|
| stato JS dichiarato dai proprietari registrati | **0,2 MB** (`pane.store` 0,1 · `chat.messages` 0,1) |
| processo renderer (WebContent principale) | **440 MB** |
| lato server, flotta intera | 479 MB su 3 processi |

Cioè: **lo stato JS di una funzionalità non è dove sta il suo peso.** Un inventario che
sommasse `JSON.stringify().length` e lo presentasse come «quanto pesa la kanban»
mostrerebbe 0,1 MB su 440, cioè un numero vero e **irrilevante**, con l'aria di essere
la risposta. È la stessa classe di errore che RES-ATTR-05 vieta già per le pane senza
processo: una quota inventata con l'aria di una misura.

La cosa onesta che si può dire, e che oggi non si dice da nessuna parte, è **quanto
ciascuna funzionalità TRATTIENE**: quante voci, quanti elementi, da quanto tempo. Sono
**conteggi esatti**, non stime — ed è il conteggio che risponde alla domanda vera
(«questa cosa cresce e nessuno la pota?»), che è poi la ragione per cui una funzionalità
diventa cara.

### Perché ora, e perché non basta la sonda che c'è

`devHeapProbe` ha già il meccanismo giusto — i proprietari si **dichiarano** invece di
essere pesati — ma:

1. **è armata a mano** e scrive su `ui-state`: la si usa in diagnosi, non risponde a un
   utente che passa il mouse sulla barra;
2. **ha tre proprietari** registrati su una dozzina di funzionalità che trattengono;
3. **non ha il concetto di funzionalità**: `pane.store` è un modulo, non una cosa che
   l'utente riconosce come «le mie tab».

## What Changes

- **Un registro del peso per funzionalità** (`featureWeight.ts`), estratto dal
  meccanismo di `devHeapProbe` e promosso a superficie di prodotto: ogni funzionalità
  dichiara cosa trattiene, con un'etichetta che l'utente riconosce.
- **Due nature tenute SEPARATE e mai sommate**: `misurato` (MB veri, da un processo:
  terminali, browser, lato server) e `trattenuto` (conteggi esatti: task, tab, chat in
  memoria, anteprime, code). Non esiste un totale che le mescoli, perché non esiste
  un'unità in cui la somma abbia senso.
- **Le sorgenti registrate**: task della kanban, tab aperte (per tipo), sessioni
  terminale, pane browser, messaggi di chat in memoria, anteprime dei topic, coda dei
  turni, cronologia dei siti, tab dei task.
- **Il recap in due superfici**, come chiesto: nel **tooltip della barra** (le prime
  voci, quelle che pesano) e nel **dropdown** (l'inventario intero).
- **Le voci a zero non compaiono.** Un elenco di funzionalità ferme a `0` è rumore che
  si impara a ignorare, e nasconde le due righe che contano.

## Impact

- **Specs**: `resource-attribution` (RES-ATTR-06/07/08, si affiancano a 01-05).
- **Codice**: `client/src/lib/featureWeight.ts` (nuovo), le registrazioni presso gli
  store esistenti, `SidebarStatusBar.tsx`, `PerfSection.tsx`, `devHeapProbe.ts` (che
  diventa un lettore del registro invece di averne uno suo).
- **Non incluso**: nessuna stima ripartita del renderer per funzionalità. Non esiste una
  misura, e inventarla è esplicitamente vietato da RES-ATTR-05; questa change estende
  quel divieto invece di aggirarlo.
- **Rischio**: il costo di raccolta. Le funzioni dei proprietari girano SOLO quando
  qualcuno guarda (hover o dropdown aperto), mai a intervalli fissi — la stessa regola
  di `RES-ATTR-04` che vale già per l'uso per-pane.
