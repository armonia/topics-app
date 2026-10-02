# Tasks

- [x] `native-parity.ts`: `readUserRulesSource` legge `~/.agents/AGENTS.md`, ripiego su `~/.claude/CLAUDE.md` con import espansi.
- [x] `skillDirs`: solo `~/.agents/skills` quando c'è; le due cartelle storiche restano come ripiego.
- [x] Blocco regole e blocco skill con `sourceUri` della fonte: il pannello le mostra in sola lettura.
- [x] Memoria globale ritirata: niente blocco `memory:global`, route `/api/memory` (GET/PUT) e `DELETE /api/memory/global` → 410; client senza ramo globale.
- [x] Memoria del topic letta da `STATE_DIR`, la stessa radice in cui scrive la route.
- [x] TOOLS.md dell'hub: una riga per ciascun doppione (board, subagent, mail).
- [x] `assertNotLiveStateUnderTest` in `createAppContext`, con test che diventa rosso senza la guardia.
