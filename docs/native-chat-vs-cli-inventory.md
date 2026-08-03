# Chat nativa di Topics vs Claude Code CLI — inventario di ciò che manca

> Task board `6cab2cf4` — 2026-08-03. Inventario con **evidenza dal vivo**, non a memoria.
> Serve a far nascere le implementazioni successive già ordinate per impatto.

## TL;DR

La chat nativa di Topics **non** è una chiamata API a tool ridotti: spawna il **binario `claude` reale**
(`server/providers/claude-code.ts:1593-1622`) in modalità `--print` + stream-json bidirezionale,
`--permission-mode bypassPermissions`, **senza `--allowedTools`/`--disallowedTools`**. Quindi in teoria
ha tutti i tool built-in della CLI installata. Il problema non è "il set è tagliato" — è che **la CLI
installata (v2.1.220) parla un vocabolario di tool diverso da quello per cui è scritto il client**, e che
la modalità `--print` **non espone i tool interattivi** (AskUserQuestion, ExitPlanMode). Da qui il bug
d'origine: `AskUserQuestion` in una chat nativa "non esiste".

## Metodo (cosa ho verificato dal vivo)

Ho **replicato lo spawn esatto di Topics** (stessi flag di `claude-code.ts:1593-1622`) contro il binario
reale `claude 2.1.220` (`which claude` → `~/.local/bin/claude`) e ho letto i frame stream-json:

1. **`system/init`** — lista dei tool "always-on": ripetuto 3× (raw, HOME pulito, spawn-Topics-identico).
   Set stabile: `Task, Bash, Cron{Create,Delete,List}, DesignSync, Edit, Enter/ExitWorktree, LSP, Monitor,
   NotebookEdit, Read, PushNotification, RemoteTrigger, ReportFindings, SendMessage, Skill,
   Task{Create,Get,List,Output,Stop,Update}, ToolSearch, WebFetch, WebSearch, Workflow, Write`
   + `mcp__gateway__*` (ereditati) + il bridge `mcp__topics__*`.
   **Assenti per nome**: `TodoWrite`, `AskUserQuestion`, `ExitPlanMode`, `Glob`, `Grep`.
2. **Emissione reale** — ho chiesto alla CLI di fare una todo list → ha emesso **`tool_use name:"TaskCreate"`**
   (×3), non `TodoWrite`.
3. **AskUserQuestion** — chiesto esplicitamente di chiamarlo: **nessuna emissione** in `--print`
   (25s, kill). Chiesto un piano da approvare in `--permission-mode plan`: il modello ha usato `Bash`
   ripetuto, **niente `ExitPlanMode`**.

Ciò che **non** ho potuto verificare a schermo nell'app viva: nessuna istanza Topics era in esecuzione e
avviare Tauri + login + Playwright era sproporzionato per un inventario. Le righe marcate come rese a
schermo incrociano il set di tool live (punti 1-3) con il codice di rendering del client (puntatori sotto).

---

## Tabella 1 — TOOL

Legenda: **OK** = presente e reso · **DEGRADA** = c'è ma peggio · **MANCA** = assente/non innescabile.

| Tool CLI | Stato | Da dove | Impatto d'uso | Puntatore |
|---|---|---|---|---|
| **AskUserQuestion** | **MANCA** | built-in provider (interattivo) | Il modello non si ferma a farti scegliere in modo strutturato: procede o scrive testo libero. Detector+form GIÀ pronti ma mai innescati in `--print`. | `--print` a `claude-code.ts:1594`; detector `ask-user-detector.ts:39`; form `ToolInputForm.tsx:48` — **live: 0 emissioni** |
| **TodoWrite / task tools** | **DEGRADA** | built-in, ma la CLI emette `TaskCreate`/`TaskUpdate` | La todo list appare come tool generico (JSON grezzo): niente `TodoCard`, niente `TodoStrip`. | client normalizza solo `todowrite` `toolDetail.ts:134`; nessun case `taskcreate`; **live: emesso `TaskCreate`** |
| **ExitPlanMode / EnterPlanMode** | **MANCA / DEGRADA** | built-in (interattivo) | In `--print` non viene emesso → niente plan-mode gating. Anche se emesso, `PlanCard` è senza bottoni approva/rifiuta. | non emesso (live); `PlanCard` senza azioni `ToolCards.tsx:315`; approva solo via euristica prosa legacy `MessageContent.tsx:1229` |
| **Artifact** | **N/A** | — | Claude Code non ha un tool Artifact (è di claude.ai). L'equivalente sono file+diff, presenti. | nessun tool `Artifact` nel set live |
| **Skill** | **OK** | built-in | Presente e reso con card dedicata. | live init `Skill`; `SkillCard` `ToolCards.tsx:453` |
| **WebSearch / WebFetch** | **OK** (search: lieve DEGRADA) | built-in CLI (non MCP) | Presenti. WebSearch cade nella card "search" condivisa con grep/glob: nessuna vista risultati-con-citazioni. | live init; `FetchCard` `ToolCards.tsx:204`, `SearchCard` `:174`; nota provider `claude-code.ts:255` |
| **NotebookEdit** | **DEGRADA** | built-in | Presente ma senza rendering dedicato → cade in `UnknownCard`. Impatto basso (uso raro). | live init `NotebookEdit`; nessun case in `toolDetail.ts`; fallback `ToolCards.tsx:495` |
| **Monitor / Bash background** | **OK** | built-in | Presente, card dedicata. Ma è una vista statica del payload, non uno stream che si aggiorna da solo. | live init `Monitor`; `MonitorCard` `ToolCards.tsx:393`, `BashOutputCard` `:413` |
| **MCP montati via gateway** | **OK** (bridge-only: MANCA) | ereditati da `~/.claude.json` | Nella chat nativa normale i `mcp__gateway__*` ci sono. Gli agenti board (`mcp_policy=bridge-only`) li perdono di proposito. | `resolveInheritedMcpServers` `claude-code.ts:288`; live init mostra `mcp__gateway__*`; strip `claude-code.ts:371` |
| **Bridge `mcp__topics__*`** | **OK** | topics-mcp-server | ~27 tool (task, browser, run_script, agenti, progetti). Resi da `McpCard` generico. | `server/mcp/topics-mcp-server.ts:46`; live init mostra il bridge |

---

## Tabella 2 — RESE A SCHERMO

| Blocco emesso | CLI | Topics | Diff | Stato | Puntatore |
|---|---|---|---|---|---|
| Pannello domande | box opzioni interattivo | form radio/checkbox+Other pronto, **ma mai innescato** | in `--print` il tool non arriva → spinner/testo | **MANCA** | `ToolInputForm.tsx:118`; trigger `waiting_for_input` `ToolCallRow.tsx:206` |
| Todo list | lista con stati | `TodoCard` + `TodoStrip` sticky | client aspetta `todowrite`, CLI manda `TaskCreate` → card generica | **DEGRADA** | `ToolCards.tsx:232`, `TodoStrip.tsx:15`; mismatch `toolDetail.ts:134` |
| Piano / plan mode | box "approvi il piano?" | `PlanCard` = `<pre>` senza bottoni | approva/rifiuta solo su euristica prosa, ramo legacy | **DEGRADA** | `ToolCards.tsx:315`; `PlanView.tsx:155`; gate `MessageContent.tsx:1229` |
| Diff di file | diff colorato | `EditCard`/`WriteCard`, unified o Before/After | — | **OK** | `ToolCards.tsx:106` |
| Tool call in corso | spinner testuale | spinner + ring + timer + grouping ≥3 + indicatore turno con token/costo | superiore | **OK** | `ToolCallRow.tsx:146`, `toolGrouping.ts:38`, `MessageParts.tsx:26` |
| Output shell background | stream live | `MonitorCard`/`BashOutputCard` statici | non si aggiorna da solo | **DEGRADA** (lieve) | `ToolCards.tsx:393` |
| Allegati / immagini | path/inline | `MediaImage` + lightbox, thumbnail input | superiore | **OK** | `MessageContent.tsx:236` |
| Thinking | testo grigio | `ReasoningRow` collassabile, interlacciato | superiore | **OK** | `ReasoningRow.tsx:18` |

---

## Tabella 3 — INTERAZIONI

| L'umano può… | CLI | Topics | Stato | Puntatore |
|---|---|---|---|---|
| Interrompere a metà turno | Esc/Ctrl-C | stop → abort del turno | **OK** | `server/routes/abortClearPolicy.ts` |
| Rispondere a un permission prompt | prompt allow/deny per tool | **mai**: `bypassPermissions`, nessun canale `can_use_tool` | **MANCA** | `DEFAULT_PERMISSION_MODE` `claude-code.ts:1572`; canale assente (autonomy non cablabile) |
| Scegliere un'opzione (AskUserQuestion) | box scelta | form pronto ma tool non innescato | **MANCA** | vedi Tabella 1 riga 1 |
| Riprendere un turno fallito | rilancio manuale | reattach/`--resume` alla stessa sessione | **OK** | `--resume` `claude-code.ts:1621` |

---

## Prime 5 mancanze per impatto (candidate a task top-level)

1. **AskUserQuestion non arriva mai in chat nativa** — `--print` non espone il tool interattivo; detector+form
   già pronti girano a vuoto. È il bug d'origine. → task: portare le domande dalla CLI al topic
   (canale alternativo o input-mode diverso).
2. **Todo list resa come JSON grezzo** — la CLI 2.1.220 emette `TaskCreate/TaskUpdate`, il client conosce solo
   `TodoWrite`. Fix piccolo e ad alto ritorno: mappare i nuovi nomi in `toolDetail.ts`.
3. **Plan mode senza gating** — `ExitPlanMode` non emesso in `--print` e comunque `PlanCard` è senza bottoni
   approva/rifiuta. → wiring approvazione sul blocco strutturato, non sull'euristica prosa.
4. **Nessun permission prompt** — con `bypassPermissions` non puoi negare un tool a metà turno; manca il canale
   `can_use_tool`. → livello di autonomia realmente cablato.
5. **Output shell background statico** — `MonitorCard`/`BashOutputCard` non si aggiornano dal vivo. → stream
   incrementale nella card.

## Nota di manutenzione

Il set di tool "always-on" dipende dalla **versione della CLI installata** (`resolveCliPath`
`claude-code.ts:107`); qui misurato su **v2.1.220**. Il mismatch di nomi (TaskCreate vs TodoWrite) è figlio
di questa versione: va ri-verificato a ogni bump del binario `claude`.
