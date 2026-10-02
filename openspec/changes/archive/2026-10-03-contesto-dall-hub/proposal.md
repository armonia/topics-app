# Change: contesto-dall-hub

## Da decidere

1. **Il runtime nativo legge `~/.agents/AGENTS.md` e `~/.agents/skills`** (consigliato): è la fonte unica che `agents-build` rigenera già con import risolti e stile. Oggi `server/lib/native-parity.ts` riespande gli `@import` di CLAUDE.md per conto suo, perde lo stile e legge le skill da due cartelle sue. Alternativa: tenere CLAUDE.md e aggiungere solo lo stile.
2. **La «Global Memory» di Topics si ritira** (consigliato): è un archivio che nessun altro harness legge. Dal 25/08 al 02/10 conteneva una stringa di test e non se n'è accorto nessuno. Il pannello mostra in sola lettura le fonti dell'hub, ognuna col link al suo file. La memoria del topic resta. Alternativa: tenerla, ma scritta dentro `~/.agents/` così la leggono tutti.
3. **Quale strumento preferire nei doppioni lo dice TOOLS.md, non il prompt di Topics** (consigliato): da lì arriva a ogni harness tramite `agents-build`. I doppioni sono board via gateway contro `mcp__topics__*_task`, `spawn_agent` contro Agent, `send_mail` contro `gws-mail`. Alternativa: una riga nel blocco iniettato da Topics.
4. **Un processo di test non apre lo stato vivo** (consigliato): `createAppContext` esce se `STATE_DIR` è il repo e il processo gira sotto `bun test`. Oggi c'è il cancello sul DB, ma la memoria del 25/08 e i 3 topic «bench progetto» del 16/08 sono finiti nello stato vivo.

ok / ok ma 2 no

## Why

Topics è il quinto lettore di un contesto che l'hub `~/.agents` ha già reso unico per Claude Code, Codex, jcode e OpenClaw. Lo ricostruisce a modo suo e in più ha una memoria propria. Ogni copia può divergere senza che nessuno se ne accorga, e la stringa di test rimasta lì cinque settimane lo dimostra.

## What changes

- `native-parity.ts`: `readUserRules` → contenuto di `~/.agents/AGENTS.md`; `skillDirs` → `~/.agents/skills`.
- `pushMemoryBlocks`: niente più blocco `memory:global`; la route `/api/memory` globale risponde 410. Lo stesso controllo dal pannello mostra le fonti dell'hub.
- TOOLS.md (hub): una riga di preferenza per ciascuno dei tre doppioni.
- `server/utils.ts`: guardia contro lo stato vivo sotto test.

## Barra

- `bun test server/context` verde, con un caso nuovo: l'envelope nativo contiene una riga presa da `~/.agents/AGENTS.md` (finto HOME) e nessun blocco `memory:global`.
- La guardia ha un test che diventa rosso quando la si toglie.
- `agents-doctor` esce 0.
