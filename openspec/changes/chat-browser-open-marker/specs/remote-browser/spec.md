# Remote browser — l'apertura dice quale contesto, e il focus raggiunge la finestra della topic

## ADDED Requirements

### Requirement: BROWSER-CHAT-05 — Un'apertura dell'agente dice su quale contesto è avvenuta, e «focalizza» la trova ovunque viva

`POST /api/topics/:id/browser/open-pane` e `POST /api/sessions/:sessionKey/browser/open-pane`
SHALL restituire, oltre a `url`, `title` e `visible`, il `contextId` su cui la pagina è
stata aperta, in tutti e tre i rami (chat, task, terminale). Il risultato testuale del
tool MCP `open_browser_pane` SHALL terminare con `[contextId: <id>]`, lasciando
invariato l'inizio della frase (`Opened browser pane at …` o `Browser context ready at …`).
Il risultato di `browser_open` sul percorso SDK SHALL portare la stessa chiave
`contextId`.

Il gestore client di `browser:focus-pane` (il `browser_focus_tab` dell'agente) SHALL
raggiungere il contesto in ogni superficie in cui vive: tab del layout, finestra di
progetto, tab di un task e **scheda della finestra della topic** (che torna ridotta se
era nascosta, con quella scheda attiva). Un contesto che non vive in nessuna superficie
NON SHALL essere riaperto da questo gestore.

#### Scenario: il ramo chat restituisce il suo contesto
- **GIVEN** una topic senza `browserState`
- **WHEN** l'agente chiama `open_browser_pane({ url: "https://example.com" })` e una pane si aggancia
- **THEN** la risposta della rotta contiene `contextId` uguale all'id della topic
- **AND** il risultato del tool comincia con `Opened browser pane at https://example.com` e termina con `[contextId: <id della topic>]`

#### Scenario: il ramo task restituisce il contesto della sua tab
- **GIVEN** un agente che lavora un task col browser del task attivo
- **WHEN** chiama `open_browser_pane({ url, name: "App" })`
- **THEN** la risposta contiene il `contextId` `task-<id8>-<seq>` della tab «App»

#### Scenario: focalizzare una scheda della finestra della topic
- **GIVEN** una pagina che vive come scheda nella finestra della topic, con la finestra nascosta
- **WHEN** arriva `browser:focus-pane` con il suo `contextId`
- **THEN** la finestra torna ridotta con quella scheda attiva
- **AND** nessuna pane nuova compare nel layout

#### Scenario: focalizzare un contesto chiuso non lo riapre
- **GIVEN** un `contextId` che non vive in nessuna superficie
- **WHEN** arriva `browser:focus-pane` con quel `contextId`
- **THEN** nessuna finestra, scheda o pane si apre
