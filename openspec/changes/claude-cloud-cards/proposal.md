## Da decidere

Risposte di Attilio del 26/10:
- **Scopo: il carico, non il credito.** Si sposta fuori dal Mac il peso degli agenti; il
  bonus cloud non c'entra.
- **Fasi: «valutiamo bene prima».** Niente è ancora scelto. La Fase 2 (dove sta la board) è
  una valutazione aperta, vedi «Da valutare».
- **Concorrenza: la decide il pacer.** Tante card insieme quante ne regge la quota,
  distribuite sugli account; nessun tetto fisso.

Resta suo: installare l'app GitHub di Claude sui repo delle card cloud (la UI dell'org lo vuole
da un owner).

---

# Card cloud: le card della board girano sulle sessioni cloud di Claude

## Why

Il tetto a quante cose facciamo insieme è la quota, non la RAM. Ma oggi la RAM la consuma il
Mac: il 26/10 la pressione era a 2, lo swap a 6,4 GB su 7 e il carico a 136 su 12 core. Ogni
agente al lavoro pesa 1,5-3 GB, tra CLI, tsserver, dev server e browser. Una sessione cloud
di Claude è una VM da 16 GB che non si paga a parte e conta solo sulla quota del piano (doc
ufficiale, «no separate charge for the cloud VM»). L'abbiamo già usata a mano: l'08/10 le tracce
T1-T12 di topics-app sono girate in parallelo su due account, con `cloud-lancia`,
`cloud-veglia` e `cloud-rispondi`. Manca solo che sia la board a farlo.

## Cosa esiste già (letto nel codice il 26/10)

- `AIProvider` (`server/providers/types.ts:469`) con un `StreamHandler` che normalizza ogni
  provider in frame `stream:*`. La vista chat (`client/src/components/Chat/*`) mostra eventi
  strutturati, non un terminale.
- `claude-code.ts` interpreta già lo stream-json della CLI. **Gli eventi di una sessione cloud
  (`GET /v1/sessions/<sid>/events`) hanno la stessa forma**: `system/init`, `assistant`,
  `user`, `result`, `control_request` (campionato su una sessione vera il 26/10). Si aggiungono
  `code_change_published` e `vcs_state_changed`, che dicono il ramo consegnato.
- Il dispatcher (`task-dispatcher.ts:3063`) crea un topic con `{provider, model, effort}` e la
  card lo segue tramite `assigned_topic_id`. Consegna, review e landing leggono un ramo.
- La corsia dei nodi remoti (`task-dispatcher-remote-node.ts`, KANBAN-76) è costruita ma non è
  mai girata in produzione. È la base della Fase 2.

## What Changes

**Fase 1: provider `claude-cloud`** (un file adattatore e il ramo nel dispatcher).
- *Crea*: `POST /v1/sessions` con il payload della CLI, letto dal `--debug-file` alla voce
  «Creating session with payload». Se fallisce si ripiega su `claude --cloud` in un PTY
  (`cloud-lancia`, già provato). Prima del lancio il ramo base va pubblicato: la sessione
  clona da origin.
- *Segue*: `GET events?after_id=` ogni 2 s mentre lavora e ogni 30 s da ferma; gli eventi
  passano al parser di `claude-code.ts` e da lì ai frame che la chat già mostra.
- *Scrive*: messaggi con `POST events` (ripiego documentato: `claude -p --cloud <sid>`).
  Il permesso: `control_request` diventa `tool_permission_required` e la risposta torna come
  `control_response` (lo stesso giro di `cloud-rispondi`).
- *Consegna*: il ramo letto da `code_change_published` diventa `delivery_branch`, e da lì
  review e landing vanno come oggi.
- *Card*: «dove gira» = locale | nodo | cloud. Nel caso cloud, `createTopic` con
  `provider: 'claude-cloud'`; quante card insieme e su quale account lo dice il pacer
  (`CLOUD_ACCOUNT=auto-N` esiste già).

**Fase 2: la board fuori dal Mac.** Il server di Topics, con board, dispatcher e provider
`claude-cloud`, va su un Hetzner CX53 (16 vCPU e 32 GB, 29,49 €/mese da API il 26/10). Il Mac
diventa un nodo della corsia KANBAN-76, per i compiti che solo lui sa fare (WebKit, video,
Keychain). Telefono e Mac lo raggiungono dal relay Cloudflare che c'è già. Questa fase prende il
posto delle fasi 1-2 di `cloud-nodes`.

## Stato al 26/10

Fase 1 costruita sul ramo `proto/claude-cloud`: card «dove gira = Cloud Claude» → sessione cloud →
ramo piantato qui → review. Barra in `specs/acceptance.md`, verde, video in `prova/`.
Non provato su una sessione vera: interrupt e archivio (forma letta dalla CLI 2.1.309).

## Barra

- Fase 1: `bun test server/providers/claude-cloud.test.ts` su una registrazione di eventi veri,
  e uno scenario spec-flow con video. Il percorso: card → sessione cloud → ramo consegnato →
  card in review, col diff letto da Topics.
- Mutazione: si ferma il polling a metà sessione, e la card deve finire in `needs_input` o in
  «ferma», mai in `delivered`.
- Ciò che è verde resta verde: la suite del dispatcher.

## Fuori

- Cloudflare come posto dove far girare il calcolo: i container arrivano al massimo a 12 GiB e
  tutto il resto andrebbe costruito da zero (studio del 26/10,
  `~/.claude/jarvis/docs/agenti-in-parallelo.md`).
- Self-hosted environments, che sono solo per Team ed Enterprise (noi siamo su Max).
- Connettore MCP della board dentro le sessioni cloud: per ora lo stato della card si ricava
  dagli eventi.

## Rischi

- `/v1/sessions` non è documentata (beta `ccr-byoc-2025-07-29`) e può cambiare. Per questo sta
  in un solo adattatore, con il ripiego sulla CLI documentata (`--cloud`, `-p --cloud`,
  `--teleport`). Un'altra via documentata per crearle sono le routine con `/fire`
  (100 lanci l'ora), ma hanno il repo fisso e il testo arriva marcato come non fidato.
- Le sessioni non hanno il Keychain, il gateway MCP, WebKit né le regole locali (le regole vanno
  nel prompt o nel `CLAUDE.md` del repo). Una VM ferma va in pausa, e i lavori in background si
  perdono.

## Da valutare prima di scegliere (richiesto da Attilio il 26/10)

- **Quanto carico toglie davvero la Fase 1: misurato il 26/10.** Prototipo e banco sul ramo
  `proto/claude-cloud` (a548d7a841, `scripts/bench/cloud-vs-local/RESULTS.md`). Col
  typecheck, 4 card locali superano 4,5 GB in 20 s e portano la pressione a 2. Le stesse 4 card
  in cloud pesano 25 MB in tutto, restano a pressione 1 e finiscono tutte, in 75 s di media.
- **Dove mettere la board** se la Fase 1 non basta:
  - Hetzner CX53: stesso codice, ma è un server da gestire.
  - Cloudflare DO + D1: niente server, ma va riscritto il dispatcher.
  - Mac: costo zero, ma la board muore quando il Mac dorme.
- **Cosa resta per forza sul Mac**: verifiche WebKit, video, Keychain. Contare quante card
  della board ne hanno bisogno.

## Non ancora specificato

- Come far parlare con la board una sessione cloud bloccata su una domanda, senza un umano su
  claude.ai.
