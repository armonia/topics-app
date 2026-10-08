# Change: memoria-claude-nel-nativo

## Why

Una chat sul runtime nativo partiva senza memoria: niente `MEMORY.md`, niente richiamo delle schede. La stessa chat su `claude` aveva l'indice del repo (o di `~`) e, a ogni prompt, le schede pertinenti proposte dall'hook `memrecall`. Era l'unico punto in cui le chat di Attilio restavano senza memoria.

## What changes

- `native-parity.ts`: `claudeMemoryDir` (stessa regola di Claude Code: radice git comune, anche dai worktree, `/` e `.` → `-`), `readClaudeMemoryIndex` (200 righe / 25k caratteri come Claude Code), `recallMemoryContext` (lancia `memrecall --hook` con lo stesso JSON dell'hook, asincrono, muto oltre 3 s), `nativeWorkingDir`.
- `assemble.ts`: blocco `user:MEMORY.md` nella cartella del turno (`TOPICS_WORKSPACE` senza progetto).
- `adapt.ts`: il blocco è solo per il nativo (`NATIVE_ONLY_BLOCKS`), con slot `user-memory` deduplicato.
- `routes/chat.ts`: sul nativo il richiamo va DOPO il testo del messaggio, in `<memory-recall>`, come l'hook della CLI.

## Barra

- `bun test server/lib/native-parity.test.ts server/context` verde; tre mutazioni (filtro solo-nativo, taglio a 200 righe, interruttore del richiamo) lo fanno diventare rosso.
- `bun run typecheck:server` a 0 errori, `bun run lint:server` e `bun run test:unit` verdi.

## Fuori

- La memoria propria di Topics resta ritirata (`contesto-dall-hub`): qui si legge quella di Claude Code, non se ne crea un'altra.
- Il recupero e la sua qualità stanno in `memrecall` (`~/.claude/jarvis/memory-recall`), con la sua barra `memrecall --eval`.

## Deciso da me

- Il richiamo non è uno slot di sistema: uno slot sparito al turno senza risultati farebbe dire al modello «Context no longer in effect: memory», che è falso. Va in coda al messaggio del turno, dove lo mette anche Claude Code.
- Si lancia solo quando il provider è `topics`: per `claude` e `codex` lo fa già il loro hook, e farlo due volte costerebbe ~0,3 s a turno per niente.
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY` spegne indice e richiamo, come per la CLI: OpenClaw lo accende perché ha una memoria sua.
- `memrecall` si cerca anche in `~/bin` e `~/.local/bin`: il PATH di launchd non li ha. Senza `memrecall` la chat va avanti senza richiamo.
