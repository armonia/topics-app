# Design — agent-inline-browser

## Il seam: l'apertura ha già tre fork, questo è il quarto

`POST /api/topics/:id/browser/open-pane` (`server/routes/topics.ts:1707-1812`) è
l'unico punto in cui un agent non-SDK apre un browser, e sceglie **già** tra tre
superfici diverse a parità di chiamata:

| Chi chiama | Fork | Frame WS | La pane entra in pane-store-v2? |
|---|---|---|---|
| terminale (`term-<id>`) | pane vicino al terminale | `browser:open-near-pane` | sì |
| agent su un task | gruppo nel drawer del task | `browser:open-task-tab` | **no** |
| chat (topic) | pane globale accanto alla chat | `browser:navigate` | sì |
| **chat, uso interno (nuovo)** | **card inline nel messaggio** | `browser:inline-tab` | **no** |

Il fork nuovo è modellato sul fork task, che è l'unico già dimostrato "fuori dal
layout globale": conia un `contextId` con un prefisso proprio, lo lega al topic, e
broadcasta. La differenza è che il fork task ha comunque una superficie di rendering
(il gruppo nel drawer) mentre qui **non c'è nessuna superficie viva**: la navigazione
avviene sul contesto headless server-side, che `browserService` sa già creare e
guidare, ed è lo stesso oggetto che i tool `browser_*` raggiungono passando
`contextId` (`server/browser-tab-inventory.ts`, memory `mcp-browser-any-tab`).

Conseguenza importante e gratuita: **nessun tool nuovo**. `browser_observe`,
`browser_act`, `browser_extract`, `browser_get_text`, `browser_screenshot`,
`browser_eval` accettano già un `contextId` opaco e lo validano contro l'inventario
vivo. Un contesto `agent-…` è vivo esattamente come un `task-…`.

## Chi decide "serve solo all'AI"

Tre candidati, uno solo regge:

1. **Euristica sull'URL** (localhost → utente, docs → inline). Indovina, sbaglia in
   silenzio, e sbaglia proprio nei casi che contano (un OAuth su un dominio ignoto).
   Scartata: è la "schifezza" nominata nel task.
2. **Impostazione utente globale** ("gli agent non aprano pane"). Sposta la decisione
   su chi non ha il contesto della singola chiamata.
3. **L'agent lo dichiara, con un default che gli costa qualcosa sbagliare.** ✅

Vince la 3, in questa forma: `surface: "inline" | "pane"`, **default `"inline"`**.
Il default è inline perché l'errore in quella direzione è recuperabile con un click
(la card sta lì, si promuove), mentre l'errore opposto — una pane non richiesta —
riorganizza il layout dell'umano e non si "annulla". La descrizione del tool dice
quando passare `"pane"`: *"solo quando l'URL serve all'umano — login/OAuth, un dev
server o un'anteprima da revisionare, una pagina che gli hai promesso di mostrargli"*.

Corollario elegante: **`browser_focus_tab` è il verbo di promozione**. Semanticamente
significa già "porta questa tab davanti agli occhi dell'utente"; applicato a un
contesto inline, monta la pane vera. L'agent che scopre a metà lavoro di dover
mostrare qualcosa non ha bisogno di riaprire niente: focalizza.

## Modello dati

Una sessione inline per `contextId`, per topic:

```ts
interface InlineBrowserSession {
  contextId: string;        // agent-<topic8>-<seq>
  topicId: string;
  url: string;              // URL corrente (dopo redirect)
  title: string;
  toolUseId?: string;       // il tool call che l'ha aperta → ancora la card in chat
  openedAt: number;
  lastActiveAt: number;
  state: 'live' | 'suspended';
  steps: { at: number; tool: string; summary: string }[];  // cap 20, FIFO
  frame?: { dataUrl: string; at: number };  // ultimo fotogramma, cap dimensione
}
```

Persistenza: ui-state key `agent-inline-browser:<topicId>`, con la **stessa** meccanica
LWW debounced + `X-Client-Id` + applicazione dei broadcast `ui-state:updated` /
`ui-state:init` già scritta per `taskBrowserTabs` (memory `task-owned-browser-tabs`, fix
cross-device `78926d14`). Riusare quel pattern per intero: è l'unico store dell'app che
ha già pagato il bug del write-only.

**Fuori da `pane-store-v2`, sempre**: nessun `OPEN_PANE`, nessun tombstone, nessun
`browserSingletonReducer`. È l'invariante che rende "invisibile al layout" gratis.
Alla promozione la pane nasce nel pane store **come una pane browser normale**, e da
quel momento la sessione inline passa a `state:'promoted'`→ la card mostra "aperta come
pane" con un link di fuoco, non un secondo sistema di tab (lezione della striscia del
task: mai due rappresentazioni vive della stessa cosa).

### Il fotogramma

L'ultimo fotogramma è l'unico modo di far vedere *qualcosa* senza motore vivo. Vincoli:

- prodotto dal contesto headless con lo screenshot che il servizio già fa
  (`browser-screenshot-file`), **rimpicciolito** e salvato su disco come gli altri media,
  non serializzato nel documento ui-state (che è LWW e viaggia su WS): nel documento va
  il **path/URL**, mai il base64. Questo evita di far esplodere un payload sincronizzato.
- aggiornato al massimo una volta per passo e comunque a fine turno, non a ogni frame.
- assente = card senza immagine, non card rotta.

### Costo in token

Il risultato del tool resta **una riga**: URL finale + titolo, come oggi. Log, passi e
fotogramma vivono nel client (dallo store), non nel testo del tool result: la card è
ricca per l'umano e a costo zero per il contesto del modello.

## Ciclo di vita

```
  open_browser_pane(surface:"inline")
        │  conia agent-<topic8>-<seq>, naviga il contesto headless
        ▼
   ┌─ live ─┐  ← browser_* guidano il ctx; ogni passo appende a steps
   │        │
   │  fine turno + idle (default 5 min)
   │        ▼
   │   suspended  ── motore distrutto, url+titolo+frame+log conservati
   │        │
   │        └── "Apri" / browser_focus_tab / nuovo browser_* sullo stesso ctx
   │                     └── ricarica dall'URL → live
   ▼
 promoted ── pane vera in pane-store-v2 (identità = stesso contextId)
        │
        └── chiusura della pane → torna suspended (la card resta nel thread)
```

La sospensione è la risposta alla domanda "e se ne apre venti": venti contesti vivi
sono venti Chromium (memory `reload-orphans-webkit-processes`, `wry non dealloca`).
Venti contesti *sospesi* sono venti righe di JSON. Il prezzo — riprendere ricarica
dall'URL, si perde lo stato di sessione della pagina — è **già** il prezzo accettato
dal browser del task, ed è onesto: la card lo dice ("ricaricherà").

Tetto duro comunque: **massimo N contesti inline vivi per topic** (default 3, come i
tetti di residenza già in uso, memory `pane-residency-cap`); superato il tetto, il meno
recente viene sospeso, non ucciso.

## Superficie in chat

`toolDetail.ts` mappa `open_browser_pane` (e i `browser_*` che portano un `contextId`
inline) a un dettaglio `{ type:'browser', contextId, url, title }`. `ToolCards.tsx`
aggiunge `BrowserCard`, che **legge lo store** per `contextId` (non solo gli argomenti
del tool call, che sono un istante congelato):

- **collassata** (default dopo l'uso, coerente con `CHAT-TOOL-03`): una riga —
  favicon, titolo, host, "3 passi", stato (vivo / sospeso / aperto come pane).
- **espansa**: fotogramma (cliccabile → promuove), lista dei passi, URL completo,
  bottoni "Apri come pane" e "Chiudi" (chiudi = hard-remove della sessione).
- La card è **derivata**, non un secondo stato: se la sessione non è nello store
  (thread vecchio, altro device prima del sync) la card degrada a com'è oggi — riga
  con URL e titolo dal tool result. Nessun buco visivo.

## Superficie in sidebar

`TopicTree` renderizza già righe annidate con `depth` e `nested`
(`TopicItem.tsx:97-100,264`) e conosce già i browser (`browserContexts`, titoli live dal
pane store). Le sessioni inline di un topic diventano righe figlie di quel topic, sotto
le pane esistenti, con: icona browser tenue (stato sospeso = più tenue), titolo pagina
(fallback host), click = promuovi/foca, menu contestuale = Chiudi. Le sessioni
`promoted` **non** compaiono due volte: quando esiste la pane, la riga è quella del pane
store (di nuovo: mai due rappresentazioni vive).

## Rischi e come sono chiusi

| Rischio | Chiusura |
|---|---|
| WKWebView dentro un messaggio che scorre → occlusione/overlay | Vietato per contratto: inline = fotogramma fermo. Il vivo esiste solo da promossa. |
| L'agent smette di mostrare all'umano ciò che gli serve (OAuth invisibile) | Default `inline` + descrizione esplicita + `browser_focus_tab` come promozione + la card è sempre visibile nel thread e a un click dalla pane. |
| Contesti headless accumulati | Sospensione a idle/fine turno + tetto per topic. |
| Doppia rappresentazione (card + pane + riga sidebar) | Stato unico per `contextId`; `promoted` spegne la rappresentazione inline viva. |
| Payload ui-state gonfio dal fotogramma | Nel documento va il path, l'immagine sta su disco. |
| Regressione sugli agent esistenti che si aspettano la pane | Dietro flag; con flag spento il default torna `"pane"` e nulla cambia. |
| Frame WS nuovi senza contract-lock | Aggiornare `tests/unit/ws-outbound-schema.test.ts` nella stessa change (memory `mcp-browser-any-tab`). |

## Alternative scartate

- **Tool separato `browser_open_inline`**: raddoppia la superficie dei tool e lascia
  `open_browser_pane` con il default sbagliato. Un argomento con un default fa lo stesso
  lavoro con meno da imparare.
- **Riusare il gruppo browser del task per la chat**: quel gruppo vive nel drawer del
  Kanban, che nella chat non esiste. Il rendering condiviso qui non porterebbe niente.
- **Pane vera ma "minimizzata"**: sarebbe una pane in `pane-store-v2` che finge di non
  esserci — cioè esattamente la classe di bug identità-pane che il fork task ha evitato.
