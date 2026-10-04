## Da decidere

Sotto-agenti sul motore di Topics invece che su una CLI Claude Code: 3 scelte prima del codice.
1. Il figlio è una chat nativa a sé (sessione propria, card in chat, si ferma col suo Stop), non un turno annidato nel padre: profondità, budget, canale verso la UI e annullamento esistono già per le chat, quindi le quattro condizioni di CHAT-NTOOL-03 si chiudono senza costruirle (o: turno annidato dentro il padre, più stretto ma tutte e quattro da scrivere).
2. Default nativo per tutti i figli, CLI Claude Code solo se la chiamata chiede `runtime: "claude-code"` (o: nativo solo per i figli di chat native, CLI per i figli di chat claude-code).
3. Profondità massima 2 (un figlio può delegare una volta) e i tetti di oggi restano: 5 per chat, 6 vivi su tutto il Mac (o: profondità 1, i figli non delegano).

Fuori: figli Codex, migrazione dei figli già vivi (finiscono come sono nati).
«ok» = tutte le consigliate · «ok ma 2 no» = cambio la 2.

---

# Proposal: subagent-nativi

> Bozza del 2026-10-04, **non approvata**: niente codice finché `.openspec.yaml` non dice `status: approved`.

| # | Dove cambiarla |
|---|----------------|
| 1 | `CHAT-NTOOL-03` (voce «Sub-agente»); design §1 |
| 2 | `SUBAGENT-08` (catena del modello, diventa catena del runtime); design §2 |
| 3 | `SUBAGENT-15` (tetti); design §3 |

## Why

Attilio, 04/10: «ancora vedo agenti claude code invece che topics». Da MSEL-06 le chat girano sul
motore nativo, ma `spawn_agent` (`server/mcp/topics-mcp-server.ts:628`) apre sempre una CLI Claude
interattiva in un PTY (`server/lib/subagent-launch.ts:37`, «the child, which is always a Claude CLI»).

Misure del 04/10 alle 17:55: 4 sessioni terminale `claude` vive, 3 figlie di chat (`topic:ae217a6b` ×2,
`topic:d740f8ae`); footprint delle CLI `claude` sul Mac fra 159 e 825 MB l'una. Un figlio nativo gira
dentro il server: niente processo, niente trust dialog da accettare (`acceptTrustDialog`, 295b06814),
niente seed via PTY che può perdersi, e la lingua e il modello del padre arrivano dal prompt nativo.

Il blocco era voluto: CHAT-NTOOL-03 vieta un `task` nativo finché mancano profondità, budget, canale
UI e annullamento per un turno annidato. Una chat figlia non è un turno annidato: ha già tutti e
quattro come qualunque chat.

## What Changes

- `spawn_agent` crea una sessione figlia (`topic:<padre>/agent-<id>`) e ci manda il prompt sul motore
  nativo; `get_agent_output`, `send_agent_input`, `stop_agent` leggono e scrivono quella sessione.
- Esito, risveglio del padre e card restano quelli di `subagent-tool-standard`, alimentati dallo
  stato della chat figlia invece che dal transcript della CLI.
- Profilo (`~/.claude/agents`): il suo prompt e il modello diventano system prompt e modello del figlio
  nativo; gli strumenti del profilo filtrano quelli nativi.
- `runtime: "claude-code"` nella chiamata mantiene il percorso di oggi.

## Impact

`server/mcp/topics-mcp-server.ts`, `server/lib/subagent-*.ts`, `server/providers/native/`,
`server/routes/subagent-exit.ts`; spec `chat` (CHAT-NTOOL-03), `agents` (SUBAGENT-08/15).
