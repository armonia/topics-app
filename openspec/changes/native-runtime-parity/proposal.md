# Change: native-runtime-parity

## Why

Un topic sul runtime **nativo** (`provider: topics`, il default della macchina) e una
sessione `claude` nel terminale sembrano la stessa cosa. Non lo erano. Misurato il
02/09/2026 sullo stesso prompt, nella stessa cartella, a un minuto di distanza:

| | nativo | terminale |
|---|---|---|
| modello | `claude-sonnet-5` | Opus 5 1M |
| skill in elenco | **0** | 54 |
| `~/.claude/CLAUDE.md` | assente | in contesto |
| thinking | mai richiesto | effort `high` |

Non è una sfumatura di qualità: è un altro agente. E il modo in cui si sbagliava era
silenzioso — nessun errore, nessun avviso, solo risposte peggiori senza una ragione
visibile.

Quattro cause distinte:

1. **Il modello scelto in Impostazioni non arrivava.** `providers/index.ts` costruisce
   il provider nativo senza `model`, quindi `config.model` è `undefined` e ogni turno
   cade su `DEFAULT_MODEL` (sonnet) qualunque cosa dica `claudeModel`.
2. **Nessun elenco di skill.** Il nativo non ha il meccanismo: `slash-command-source.ts`
   le elenca per la UI, ma niente le mette in contesto e niente le carica.
3. **`~/.claude/CLAUDE.md` non entra mai.** `context/assemble.ts` carica i file di
   PROGETTO (CLAUDE.md, README, AGENTS.md della cartella); le regole globali
   dell'utente non sono file di progetto e nessuno le legge.
4. **L'effort non era collegato.** Lo slider esiste su ogni topic; sul nativo non
   spostava niente perché la richiesta non portava `thinking`.

Un difetto trovato per strada, che valeva da solo la passata: `listSlashCommandFiles`
saltava ogni skill raggiunta da un **symlink** (`d.isDirectory()` è falso su un link).
Su questa macchina significava **12 skill viste su 41** — anche per la UI dei comandi,
non solo per il nativo.

## What changes

1. `resolveClaudeModel()` alla costruzione del provider nativo: l'impostazione conta.
2. Nuovo `lib/native-parity.ts`: `readUserRules()` (con espansione di un livello di
   `@percorso`, senza cui il file di regime arriva dimezzato) e `listSkills()`/`skillsBlock()`
   (nome + descrizione dal frontmatter, anche in forma di blocco YAML; il CORPO non entra).
3. Due nuovi blocchi nell'envelope (`user:CLAUDE.md`, `synthetic:skills`) con due slot
   propri (`user-rules`, `skills`). Il filtro «solo per il nativo» sta in `adaptEnvelope`,
   non in `assembleTopicContext`: la rotta assembla con `providerName: "(pending)"` e
   risolve il provider dopo, quindi un cancello a monte li spegne SEMPRE — e l'ispettore
   continua a mostrarli, che è il modo peggiore di sbagliare.
4. Tool `skill` nel runtime nativo: carica `SKILL.md` a richiesta. Non è un `read_file`
   travestito — le skill stanno fuori dalla workspace, dove `read_file` giustamente non
   arriva. Il cancello sui nomi è quello già scritto in `slash-command-source.ts`.
5. L'effort del topic (o l'impostazione globale) diventa `thinking.budget_tokens`.
   `low` = niente thinking: sotto 1024 l'API rifiuta.
6. `listSlashCommandFiles`: una skill dietro un symlink è installata quanto le altre.

## Out of scope

- Il set di tool del nativo (6: read/write/edit/bash/grep/glob). Mancano `Task`,
  `WebFetch`, `WebSearch`, `TodoWrite`: è la prossima distanza dalla CLI, non questa.
- Gli hook di Claude Code (`SessionStart`, `Stop`, …), che il nativo non esegue.
- I comandi slash dell'utente (`~/.claude/commands`): elencati per la UI, non iniettati.

## Impact

- **Server**: `providers/index.ts`, `providers/native/{provider,agent-loop,tools}.ts`,
  `context/{assemble,adapt}.ts`, `lib/{native-parity,slash-command-source}.ts`.
- **Client**: nessuna modifica.
- **DB**: nessuna migration.
- **Costo**: le regole (~5k token) e l'elenco skill (~1,5k) entrano nel prefisso di ogni
  topic nativo. Sono cache-hit dopo il primo turno (stanno prima della storia), e nel
  turno `lean` non si rimandano affatto.
