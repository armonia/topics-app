# Proposal: ai-control-hierarchy-topics-switch

> Approvata il **2026-09-22 14:56** (vedi `.openspec.yaml`). Risposta esatta di
> Attilio: «**deve essere tutto solido e pulito procedi**». Card Topics
> `3ee1b43a-c267-469a-b4ad-f031d4940bb2`, che nomina questa change e ne chiede
> l'implementazione.

## Da decidere

Una sola scelta, gia' data: la gerarchia del controllo AI si corregge, e
l'instradamento leggero Topics esce dalla lista dei provider.

1. **Uno switch separato, in cima**, decide se usare l'instradamento leggero
   Topics. **Sotto**, si sceglie fra ogni provider reale dello snapshot, poi fra
   i modelli compatibili. **Risposta: approvata.**

## Why

Oggi le due domande sono mescolate in una sola lista, e non sono la stessa
domanda.

- **`topics` e' un provider come gli altri.** `shared/task-coding-models.ts:3`
  elenca `CLAUDE_CODING_PROVIDERS = ['topics', 'claude-code', 'jcode']`, e il
  valore selezionato e' `provider:model` (`topics:claude-opus-5`,
  `topics:auto`). Scegliere «Topics» nel menu sovrascrive quindi il provider,
  che e' esattamente cio' che non deve fare: Topics non e' un fornitore di
  modelli al pari di Anthropic o OpenAI, e' il modo in cui il turno viene
  instradato.
- **Lo switch esiste gia', ma altrove e invisibile dove serve.**
  `AGENT_RUNTIMES = ['cli','jcode','topics']` (`shared/types.ts:118`), default
  `topics`, vive in Impostazioni (`Settings/AgentRuntimeChoice.tsx`) e si
  persiste in `app_settings.agent_runtime` via `/api/app-settings`, risolto da
  `resolveAgentRuntime()`. Chi apre il selettore non lo vede.
- **Conseguenza misurabile:** due assi indipendenti scritti in due posti
  diversi, con una voce di menu che ne confonde uno con l'altro. Cambiare
  instradamento sembra cambiare fornitore.

## What changes

- Il primo livello del menu elenca **ogni provider dello snapshot**: i `ready`
  selezionabili, i non-`ready` **visibili con il motivo ma disabilitati**.
  Nessuna voce provider Topics sintetica.
- Lo switch dell'instradamento leggero sta **sopra**, con stato proprio.
  Cambiarlo non tocca provider ne' modello.
- **Nessuna migrazione distruttiva.** I valori interni e legacy `topics:<model>`
  e la entry di snapshot restano quanto serve: il provider sintetico si
  nasconde dal menu e si mappa sullo switch. I dati salvati e i turni in volo
  restano validi.
- Stessa semantica, condivisa o dimostrabilmente equivalente, in chat, composer
  task e impostazioni board.

## Non-goals

Inventare integrazioni non installate. Rinominare o rimuovere `topics` dal
contratto dello snapshot. Toccare il default `DEFAULT_AGENT_RUNTIME`. Aprire un
progetto multiaccount. Cambiare la semantica di `resolveAgentRuntime` (vuoto →
`topics` come delega, illeggibile → `cli` come errore).
