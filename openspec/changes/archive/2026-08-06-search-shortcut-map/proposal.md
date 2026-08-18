# Proposal — search-shortcut-map

## Why

I quattro tasti della ricerca erano incrociati, e sotto di essi il contesto su
cui devono lavorare spariva da solo.

**Il difetto che li rendeva inservibili non era nei tasti.** `focusedProjectPath`
(`hooks/usePanelLifecycle.ts`) riconosceva solo la TAB del progetto o una chat
che vi appartiene. Ma aprendo un progetto il fuoco scivola quasi subito su una
pane INTERNA — terminale, git, file, browser — che non è un `project:` pane id e
non sta in `topics`. Da lì il progetto spariva pur essendo a schermo intero, e
⌘F non rispondeva: il sintomo riportato («premo sul progetto dalla tab bar e poi
⌘F non fa niente»).

**E i tasti:**

| | prima | problema |
|---|---|---|
| ⌘F | trova un PROGETTO | in ogni applicazione del mondo ⌘F vuol dire «cerca QUI DENTRO», non «cambia contesto» |
| ⌘P | «Quick-open file» | apriva un grep nel CONTENUTO: l'etichetta diceva una cosa e il tasto ne faceva un'altra |
| ⌘⇧F | alias IDENTICO di ⌘P | due accordi per la stessa cosa, e rubava la F mentre ⌘F faceva tutt'altro |
| ⌘⇧P | — | libero |

La ricerca per NOME, intanto, esisteva solo sepolta dentro ⌘K — dove per giunta
tagliava a 20 PRIMA di ordinare, quindi `store.ts` non mostrava nessuno dei suoi
11 file veri (misurato).

## What

1. **`focusedProjectPath` riconosce anche le pane interne** via `projectOpenPanes`,
   gated su «quel progetto è ancora aperto» (la mappa è upsert-only).
2. **Mappa nuova**: ⌘⇧P trova un progetto · ⌘P apre un file per nome · ⌘F cerca
   dentro · ⌘⇧F ritirato.
3. **⌘F è multi-progetto**: progetto a fuoco più quelli aperti. `allSettled` e
   non `all` — un progetto sparito non deve far sparire i risultati degli altri.
4. **`FileSearch` è UNA superficie con due modi**, e il modo è CONTROLLATO da
   chi apre: premere l'altro tasto commuta invece di chiudere.
5. **UN matcher con punteggio** (`lib/fuzzyScore`), usato dalla ricerca per nome
   e da ⌘K. Ordina PRIMA di tagliare.

## Prerequisito, fatto prima

⌘F multi-progetto lancia N grep. Con l'implementazione di prima erano N × 159 s
senza timeout né kill, sul server di produzione. Vedi il commit «Il path dal
client entrava senza bussare»: perimetro, timeout, drenaggio, e il contenimento
del path — la cui allowlist è esattamente la lista che ⌘F deve percorrere.

## Non-goals

- ⌘K resta la ricerca globale, invariata nel comportamento.
- La ricerca dei MESSAGGI (che vede il 4,3% del testo e applica il LIMIT prima
  dello scarto degli orfani) NON è toccata qui: è un lavoro suo.
