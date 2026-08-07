# Change: autonomy-level-needs-permission-channel

> **CHIUSA il 07/08/2026.** Il canale esiste. Questo documento resta come
> registro: cosa mancava, perché non era «un cablaggio dimenticato», e — la
> parte che serve davvero a chi arriva dopo — **perché la prova che avevamo
> non provava niente**. La strada scelta è la **A** descritta più sotto.

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

## Cosa è successo dopo — e perché è finita male prima di finire bene

Il selettore è tornato, e il 06/08 la migration 081 ha portato tutti i topic
senza scelta su `auto-apply` per uscire da plan mode (la CLI 2.1.223 aveva tolto
`ExitPlanMode`, quindi «ask» non poteva più né agire né consegnare il piano).

`auto-apply` mappa su `acceptEdits`. E `acceptEdits`, in `--print`, **chiede** il
permesso per tutto ciò che non copre. Senza canale, chiedere significa negare in
silenzio:

```
Claude requested permissions to use mcp__gateway__kiwi__search-flight,
but you haven't granted it yet.
```

Quindi da quel giorno, su **515 topic su 518**, sono morti muti **ogni tool MCP**
e **ogni scrittura fuori dalla cwd**.

**La trappola vera, quella da non ripetere.** La mappatura non era stata scelta a
naso: c'era una prova, scritta nel commento di `autonomy-mode.ts` e ripetuta
nella migration 081 — «`acceptEdits` → esegue (provato con un comando shell).
Nessun blocco». La prova era reale ed era **la prova sbagliata**. Tabella di
verità misurata il 07/08 (stesso prompt, stessa cwd, `--print`, server MCP
locale; identica su CLI 2.1.221 e 2.1.224, quindi **non è una regressione**):

| modalità | Bash | Write dentro | Write fuori | tool MCP |
|---|---|---|---|---|
| acceptEdits | OK | OK | **NEGATO** | **NEGATO** |
| auto | OK | NEGATO | NEGATO | NEGATO |
| bypassPermissions | OK | OK | OK | OK |
| dontAsk / manual / plan | OK | negato | negato | negato |

`Bash` è **l'unica capacità che passa in tutte e sei le modalità**. Il probe che
doveva convalidare la mappatura esercitava esattamente quella. Un probe che
tocca una capacità che non può fallire non è una prova: è una rassicurazione.

**Perché sembrava intermittente.** L'unica cosa che teneva vivi gli strumenti MCP
era la riga `"mcp__topics__*"` dentro `.claude/settings.local.json` del repo
topics-app — **gitignorata**. Stesso strumento, stessa modalità, cambia solo la
cartella: repo `OK`, worktree `OK` (eredita dal repo), **HOME `NEGATO`**. Le chat
senza progetto non hanno mai avuto un solo tool MCP.

## Perché non era un cablaggio dimenticato (l'analisi del 30/07, confermata)

La leva per gli override per-topic esisteva ed era collaudata:
`getTopicSpawnOverridesForSession()` in `server/providers/claude-code.ts` legge
già `effort`, `model` e `mcp_policy`. Il problema era a valle: tutti i
`--permission-mode` che chiedono inoltrano la richiesta su un canale di controllo
che Topics non gestiva. Nel server non c'era **una sola** occorrenza di
`can_use_tool`, `control_request` o `permission_request`.

Quell'analisi era corretta e incompleta in un punto: dava per scontato che
l'unica strada fosse implementare il protocollo di controllo. Ne esisteva una
seconda, più corta, che nessuno aveva verificato perché **non è documentata**.

## Cosa è stato fatto (strada A, per la porta che non sapevamo ci fosse)

`--permission-prompt-tool <tool MCP>` dirotta la richiesta di permesso su uno
strumento MCP invece che sul prompt interattivo. **Non compare in `--help` dalla
2.1.224**, ma è accettato e funziona in `--print` — verificato sul filo. E Topics
attacca già un server MCP a ogni sessione.

1. **`mcp__topics__approval_prompt`** sul bridge (`server/mcp/topics-mcp-server.ts`)
   — gambe di poll come `ask_user_question`, e la regola che governa ogni ramo:
   *torna sempre una decisione, non lancia mai*; quando nessuno ha potuto
   decidere, **nega**.
2. **Rendez-vous** `server/lib/permission-bridge.ts`, indicizzato per
   `sessionKey + tool_use_id` (non per sessione: la CLI può chiedere per più
   `tool_use` dello stesso messaggio — misurati a 170 ms di distanza).
3. **Il pannello** è quello di `AskUserQuestion` (`kind: "questions"`), come per
   l'approvazione del piano: eredita form inline, ambra della tab, risposta dal
   composer e sopravvivenza al reload. Etichette e riconoscimento in
   `shared/permission-decision.ts` — un contratto solo, scritto una volta.
   Con tre differenze volute: occhiello «chiede un permesso», niente «Altro»
   (il testo libero qui vale NEGA, quindi prometterebbe una risposta e ne darebbe
   un'altra), e gli argomenti sotto al nome dello strumento.
4. **`--permission-prompt-tool` allo spawn** quando la modalità può chiedere,
   via `permissionPromptArgs()` — una funzione, non uno spread in mezzo
   all'argv, perché è l'invariante da tenere viva e un test la esegue.
5. **Le regole di «Consenti sempre»** in `tool_grants` (migration 086), non nel
   file gitignorato. Con la scheda **Impostazioni → Permessi** per rileggerle e
   revocarle: un consenso permanente che non si può togliere è una porta che si
   apre e basta.
6. **`mcp__topics__*` non chiede mai.** Sono le mani di Topics: il 7 agosto una
   richiesta di permesso è arrivata su `ask_user_question` — per mostrare un
   pannello serviva il permesso di mostrare un pannello.
7. **La porta unica** `server/lib/human-hold.ts`: «questo turno aspetta una
   persona» aveva due sorgenti e sei posti che dovevano saperlo (tetto di vita,
   reaper, spazzino, snapshot, abort, fine turno). Sei rami da aggiornare a mano
   sono sei occasioni di uccidere un turno sotto un pannello aperto.

**La trappola indicata qui il 30/07 è stata onorata.** «I topic dispatchati dalla
board non possono chiedere niente a nessuno»: la loro autonomia è ora scritta
esplicitamente al momento della creazione (`DISPATCH_AUTONOMY` in `server.ts`),
non lasciata al default della colonna.

## Strada B, e perché resta fuori

**Allowlist dichiarative (`--allowedTools` / `--disallowedTools`).** Non
richiedono canale: la CLI non chiede, semplicemente non ha lo strumento. Ma non
esprimono «chiedimi prima»: esprimono «questo non lo puoi fare». Sono una
funzione diversa e vanno chiamate col loro nome — non «Autonomy Level» — perché
scegliere l'insieme È progettare una politica, e sbagliarlo dà sicurezza finta.
`tool_grants` è la loro versione onesta: nasce da un sì premuto da una persona,
non da una lista scritta a priori.

## Impatto

- `server/lib/permission-bridge.ts`, `server/lib/tool-grants.ts`,
  `server/lib/human-hold.ts`, `shared/permission-decision.ts` — nuovi.
- `server/mcp/topics-mcp-server.ts` — `approval_prompt`, pubblicato SOLO quando
  il canale è acceso (altrimenti resterebbe uno strumento interno nell'elenco
  che il modello vede).
- `server/routes/topics.ts` — `POST …/permission`, `/api/tool-grants`, e il ramo
  che instrada un click di permesso PRIMA di quello della domanda (lì il
  riconoscimento è esatto, qui è un'euristica sul contenuto della riga).
- `server/providers/claude-code.ts`, `server/lib/autonomy-mode.ts` — lo spawn e
  la mappatura, con la tabella di verità scritta accanto.
- `client/…/ToolInputForm.tsx`, `client/…/Settings/PermissionsSection.tsx`,
  `client/src/state/pendingAsk.ts` — il pannello, la scheda, e il divieto di
  rispondere a un permesso scrivendo.
- Migration **086** (`tool_grants`). `topics.autonomy_level` invariata.
