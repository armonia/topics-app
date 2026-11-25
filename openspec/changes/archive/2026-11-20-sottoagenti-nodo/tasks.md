# Tracce: sottoagenti-nodo

Change in `draft`. Prima di qualunque passo di implementazione:
`grep -qx 'status: approved' openspec/changes/sottoagenti-nodo/.openspec.yaml`.
Se esce non-zero, ci si ferma qui: questa PR consegna solo la proposta.

1. Marca per-figlio equivalente a `stayLocal` delle card (repo git sì/no,
   macOS/browser/sessioni/Jarvis vivo, runtime `claude-code` chiesto) in
   `subagent-seed.ts` / `terminal.ts` spawn route. Barra:
   `server/routes/terminal.agent-spawn.test.ts`.
2. Scelta del nodo per un figlio idoneo: posto libero su `machines.slots`,
   poi Mac — stesso schema di `isRemoteTask` per le card
   (`task-dispatcher-remote-node.ts`). Barra:
   `server/services/task-dispatcher-remote-node.test.ts`.
3. Trasporto bundle per il figlio: stash + `branchBundle` all'andata,
   `fetchBundle` al ritorno, riuso di `plantCarriedBranch`
   (`routes/nodes.ts:634-636`). Barra: test di integrazione nodo finto.
4. `stop_agent` su un figlio remoto ⇒ `cancelRun`. Barra:
   `server/routes/terminal.agent-spawn.test.ts` (nuovo caso).
5. Prezzo vero per il figlio che resta sul Mac: `childAdmissionPreview`
   (`task-dispatcher.ts:1707`) smette di prezzare col costo di una card.
   Barra: `server/services/dispatch-capacity.test.ts`.
6. Prova dal vivo (barra §d): 8 figli in parallelo, Mac sotto 6 GB, `ps` senza
   processi remoti sul Mac.
