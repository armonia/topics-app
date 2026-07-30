# Change: autonomy-level-needs-permission-channel

## Why

Il selettore **Autonomy Level** nelle impostazioni di un topic mostrava
`Ask — Approve each action` **selezionato**, su ogni topic, mentre lo spawn della
CLI usava `bypassPermissions`: nessuna approvazione, per niente. Non era un
valore neutro mostrato per caso — `'ask'` è il default di schema di
`topics.autonomy_level`, quindi tutti i **461** topic del DB reale lo portano, e
tutti mostravano quella scritta.

Un controllo che *appare impostato* e non fa niente è peggio di un controllo
assente: chi lo legge conclude che l'agente chieda prima di agire, e prende
decisioni su quella convinzione (che progetto aprire, quanto fidarsi di un
worktree). Il 30/07 il selettore è stato **rimosso** dal modal; la colonna, la
`PATCH` che la scrive e il tipo `AutonomyLevel` restano intatti — i dati non si
buttano per una UI.

Questo documento esiste perché la rimozione non è la fine della storia: registra
**perché** non era collegabile, così chi riprova non ripete l'indagine.

## Perché non è un cablaggio dimenticato

La leva per gli override per-topic esiste ed è collaudata:
`getTopicSpawnOverridesForSession()` in `server/providers/claude-code.ts` legge
già `effort`, `model` e `mcp_policy` dalla riga del topic, li traduce in flag di
`argv`, e la `PATCH` forza un respawn quando cambiano (migration 033). Aggiungere
`autonomy_level` a quella funzione è meccanico.

Il problema è a valle. I `--permission-mode` che la CLI accetta sono
`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan` — non
esiste un `default`. E **tutti quelli che chiedono** inoltrano la richiesta di
permesso su un canale di controllo che Topics non gestisce:

- `manual` chiede per ogni strumento;
- `acceptEdits` accetta le modifiche ai file e chiede per **tutto il resto**,
  quindi si blocca al primo `Bash`.

Nel server non c'è **una sola** occorrenza di `can_use_tool`, `control_request`
o `permission_request`: verificato con grep su tutto `server/`. Ciò che assomiglia
a un canale di richiesta — `pendingInputs` / `resumeWithToolResponse` /
`stream:tool_user_input_required` — è guidato da
`detectUserInputRequest({ name: toolName, input })`, cioè riconosce il **tool
AskUserQuestion**, non le richieste di permesso della CLI.

Conseguenza: collegare oggi `'ask'` o `'auto-apply'` a un permission mode che
chiede significa che il turno resta appeso finché non scatta il watchdog. Non è
una funzione a metà: è una trappola.

## Cosa servirebbe per riaccenderlo

Due strade, non equivalenti.

**A. Gestire il canale di permesso della CLI (la strada vera).**

1. Nel provider, riconoscere le richieste di controllo in ingresso sullo stream
   JSON e instradarle come una richiesta pendente per `sessionKey` + tool id —
   la stessa forma che `pendingInputs` ha già per AskUserQuestion, quindi il
   percorso di risposta (`resumeWithToolResponse`, scrittura su stdin) è in gran
   parte riusabile.
2. Un evento in uscita nuovo (registrato in `shared/ws-outbound.ts`, con il suo
   payload in `ws-outbound-payload-shape.test.ts`) che porti al client
   *strumento, argomenti e perché sta chiedendo*.
3. UI: una riga di approvazione nella chat, con Consenti / Consenti sempre /
   Nega. «Consenti sempre» deve scrivere da qualche parte, o l'utente la rivede
   a ogni turno.
4. Un timeout esplicito: una richiesta senza risposta deve **negare** e chiudere
   il turno con un motivo leggibile, non lasciarlo appeso al watchdog.
5. Solo allora `getTopicSpawnOverridesForSession` mappa i tre livelli.

**Trappola da non ripetere:** i topic dispatchati dalla board non possono
chiedere niente a nessuno. Se il livello resta `'ask'` per default di schema, il
giorno in cui il mapping si accende **ogni dispatch si blocca**. Chi implementa
deve decidere prima cosa vale per un topic creato dal dispatcher, e la scelta
va scritta in una migration, non lasciata al default della colonna.

**B. Allowlist dichiarative (`--allowedTools` / `--disallowedTools`).**

Non richiedono canale: la CLI non chiede, semplicemente non ha lo strumento.
Ma non esprimono «chiedimi prima»: esprimono «questo non lo puoi fare». Sono una
funzione diversa e vanno chiamate col loro nome — non «Autonomy Level» — perché
scegliere l'insieme È progettare una politica, e sbagliarlo dà sicurezza finta.

## Impatto

- `client/src/components/Modals/TopicSettingsModal.tsx` — selettore rimosso, con
  il motivo in un commento accanto.
- `topics.autonomy_level`, `PATCH /api/topics/:id`, `AutonomyLevel` — **intatti**.
  Nessuna migration: tutti i 461 valori restano `'ask'`, che non significa più
  niente per nessuno e non fa danni.
- Nessun cambio di comportamento: lo spawn usava `bypassPermissions` prima e lo
  usa dopo. Cambia solo che l'app non afferma più il contrario.
