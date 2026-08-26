## ADDED Requirements

### Requirement: KANBAN-11 — Browser del task sul motore di layout reale, task-scoped

Il gruppo browser di proprietà di un task (nel drawer del Kanban) SHALL usare lo stesso
motore di layout dell'app (`GroupLayout` + `SplitTree` + `PaneTabBar` + `state/layout`),
con split, drag-to-split, tab-stack, riordino e resize dei divisori veri — la stessa UX e
lo stesso linguaggio visivo del resto dell'app. Le tab del task SHALL restare task-scoped:
NON SHALL entrare mai in `pane-store-v2`, NON SHALL essere broadcastate via WebSocket, NON
SHALL essere tombstonate; il loro stato di identità e di layout è persistito per-task via
`ui-state` (LWW debounced), non nel pane store globale. L'invariante che tiene le tab del
task fuori dal layout globale (nessuna divergenza di contextId, nessun
tombstone/LWW/PURGE) SHALL essere preservata: il motore reale è alimentato da uno stato di
layout task-scoped, non riusando il producer `useProjectLayout`.

Solo il gruppo browser SHALL passare al motore reale: Piano, media e Output NON sono
`PaneType` e SHALL restare sulla surface leggera del drawer (nessun `PaneType` fittizio).
Il pop-out verso una finestra d'app e lo spostamento in uno Spazio (`canMoveToSpace`)
SHALL restare disabilitati per il gruppo browser del task — sono gli unici gesti che
sconfinerebbero nel pane store globale.

Chiudere una tab del task SHALL essere un **soft-close**: la tab viene parcheggiata come
anteprima invece di essere distrutta. Sotto la descrizione del task SHALL esserci una
striscia di anteprime (tab attive e parcheggiate) sempre visibile quando il task ha
almeno una tab, da cui una tab si riapre nel layout (unpark) o si rimuove definitivamente.

La feature SHALL essere attiva di default per l'utente reale (flag client e server graduati
a default-ON, con override/kill-switch mantenuti). Il fork server che instrada l'apertura
browser dell'agent verso il gruppo del task (`browser:open-task-tab`) SHALL restare
invariato nel comportamento: sia l'agent (fork server) sia l'utente (`+` nella tab bar)
SHALL poter aprire/guidare le tab del task.

#### Scenario: split di due browser del task affiancati
- **GIVEN** un task con due browser tab aperte nel drawer
- **WHEN** l'utente trascina una tab sul bordo dell'altra (o usa "Split")
- **THEN** le due pane sono renderizzate affiancate dallo stesso motore `GroupLayout`, con divisore ridimensionabile, e nessuna delle due entra in `pane-store-v2`

#### Scenario: soft-close → anteprima riapribile
- **GIVEN** una browser tab del task nel layout
- **WHEN** l'utente la chiude
- **THEN** la tab non è distrutta ma compare come anteprima cliccabile nella striscia sotto la descrizione, e cliccandola si riapre nel layout allo stato precedente (url ripristinato)

#### Scenario: apertura dall'agent atterra nel gruppo del task
- **GIVEN** un agent che lavora il task apre una pane browser sul suo topic (fork server attivo)
- **WHEN** il client riceve `browser:open-task-tab`
- **THEN** la tab compare nel gruppo browser del task (upsert idempotente per contextId), guidabile, senza mai comparire nel layout globale né rubare una tab d'app

#### Scenario: le pane del task non inquinano il pane store globale
- **GIVEN** un task con più browser tab in split
- **WHEN** l'utente riordina, splitta, ridimensiona e chiude tab
- **THEN** nessun `OPEN_PANE`/tombstone/broadcast è emesso verso `pane-store-v2` e lo stato di layout è persistito solo nella key `ui-state` per-task

#### Scenario: Piano/media/Output restano sulla surface leggera
- **GIVEN** un task plan-first con un Piano e un allegato
- **WHEN** il drawer è aperto
- **THEN** Piano e media sono mostrati sulla surface leggera (non nel motore `GroupLayout`), mentre il gruppo browser usa il motore reale
