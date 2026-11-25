> **Archiviata (2026-11-20):** costruita, `server/services/subagent-remote-spawn.ts`, `node-child-run.ts`, requisiti SUBAGENT-25..29 già in `openspec/specs/agents/spec.md`, coperti da `terminal.agent-spawn-remote.test.ts` e `subagent-remote-*.test.ts` (f5f88a1ce, #1353).

# Sottoagenti su PC e nodo, non solo sul Mac

Oggi `spawn_agent` gira SEMPRE sul Mac: una card ha già la corsia remota
(`task-dispatcher-remote-node.ts`, `POST /api/nodes/runs` in `routes/nodes.ts`,
`node-client.ts`), un figlio no — nasce come PTY interattivo locale
(`routes/terminal.ts:634-800`, `createSession(...)`) o come checkout nativo in
un worktree locale (`ctx.worktreeManager.create`). Col Mac sotto il pavimento di
memoria (`DISPATCH_MEM_FLOOR_GB = 12`, `dispatch-capacity.ts:281`) i figli
aspettano in coda mentre il nodo permanente (cx53, 30 GB, mai sotto 12 GB
disponibili in 4 giorni di `sar`) e il PC sono liberi.

**Misura di partenza** (365 figli dal 01/11): 94 in repo GitHub, 108 in git
locale (82 in `~/.claude/jarvis/home`), 163 in cartelle non git (`~/Projects`,
doc, `/tmp`). Solo i primi due gruppi (202/365, il 55%) possono lasciare il Mac
senza bisogno del suo filesystem.

## Deciso

1. **Trasporto = git, non sync live.** Il figlio parte da uno snapshot del
   lavoro del genitore — `HEAD` + `git stash create` — spedito come bundle,
   la stessa strada di `branchBundle` (`task-dispatcher-remote-node.ts:565`,
   `routes/nodes.ts:634-636`, `plantCarriedBranch`), che funziona anche su un
   repo locale senza `origin` GitHub (il caso jarvis/home). Il nodo lavora sul
   suo ramo; il lavoro torna via `fetchBundle`, il risultato testuale torna al
   genitore come oggi (`subagent-result.ts`). Niente Mutagen/rsync
   bidirezionale: genitore e figlio sugli stessi file in due posti fa conflitti
   silenziosi.
2. **Chi va fuori / chi resta.** Fuori: un figlio in un repo git (GitHub o
   locale) che non ha bisogno del Mac. Resta: cartelle non git, un figlio che
   tocca macOS/browser/sessioni/Jarvis vivo (la stessa marca `stayLocal` delle
   card, `task-shapes.ts:221,492-494,576-585`), un runtime `claude-code`
   esplicitamente chiesto quando quel runtime non è disponibile sul nodo.
3. **Pavimento del Mac non si applica a un figlio remoto**, come `isRemoteTask`
   per le card. Scelta del posto: un nodo con posto libero (`machines.slots`,
   migration `020-machines.sql` + `20261109090000-machine-slots.sql`), poi il
   Mac.
4. **Prezzo vero per chi resta sul Mac.** Un figlio pesa oggi ~50 MB ma paga lo
   stesso pavimento di 12 GB pensato per una card da 3 GB CLI / 1,5 GB nativa
   (`childAdmissionPreview`, `task-dispatcher.ts:1707-1715`, che oggi chiama
   `floorVerdict(false, undefined, price)` con il prezzo di una card, non del
   figlio). Un figlio che resta locale deve prezzarsi sul suo costo vero.
5. **Resta una chat figlia.** Il figlio remoto resta visibile nella sidebar
   sotto il genitore (`parentSessionKey`, broadcast in `terminal.ts`);
   `stop_agent`/`send_to_agent`/`read_agent` funzionano uguali. `stop_agent` su
   un figlio remoto chiama `cancelRun` (`node-client.ts:211,551`), come oggi per
   una card.

## Fuori

Spostare chat o sessioni della UI. Nodi nuovi o spesa aggiuntiva (si usano
quelli già pairati). Sync live di cartelle. Nipoti: il tetto di profondità
sottoagenti è già 1 (`spawn_agent` di un sottoagente è già rifiutato con 429,
`boardSpawnRefusal` in `routes/terminal.ts`) e questa change non lo cambia — un
figlio remoto non apre nipoti né sul nodo né sul Mac.

## Non ancora specificato

- Cosa succede se il nodo scelto va offline a metà corsa: ripiego sul Mac con
  lo stesso stash, o la corsa resta ferma finché il nodo non torna.
- Isolamento worktree (`isolation: "worktree"`) oggi crea il checkout in
  locale via `ctx.worktreeManager.create`; su nodo va creato lì con lo stesso
  bundle, non sincronizzato dopo.

## Barra

Vedi `specs/acceptance.md`.
