# Proposal: active-agents-feedback

> Bozza del 2026-09-27, **non approvata**: niente codice finché
> `openspec/changes/active-agents-feedback/.openspec.yaml` non dice `status: approved`.
> Card Topics `1f773f2f-95b0-4c9c-a9b8-d2a2c850109b`.

## Da decidere

Agenti in background visibili: 2 scelte prima del codice.
1. Glifo: lo stesso anello, grigio e lento, terzo stato accanto al blu che gira e all'ambra ferma: la chat non risponde e non aspetta te, l'invio è libero (o: l'anello blu di un turno aperto, e la chat sembra a metà risposta)
2. Il numero sul pulsante del menu conta anche le chat in background, una per chat, col gruppo «In background» nel livello: quel lavoro occupa RAM adesso e quella riga dice cosa spegnere (o: elencate nel livello ma fuori dal numero)
Compreso, senza scelta: riga sopra il composer «In attesa di N in background: nomi», che dopo 10 min senza notizie lo dice; lo Stop resta quello del composer; stesso glifo su riga sidebar, tab e progetto chiuso.
Col sì: /api/topics/streaming porta i task di ogni riga background; quelle chat restano fuori dagli insiemi di streaming, quindi self-heal e invio non cambiano. Costo: un lavoro che la CLI smette di raccontare resta acceso fino a 2 ore.
«ok» = tutte le consigliate · «ok ma 2 no» = cambio la 2.

Dove cambiarla: la scelta 1 è BGVIS-01 (glifo), la 2 è BGVIS-03 (conteggio), in
`specs/chat/spec.md`.

## Why

Durante un turno aperto il feedback c'è già: spinner sulla riga
(`client/src/components/Sidebar/TopicItem.tsx:511`), roll-up del progetto
(`Sidebar/TopicTree.tsx:1290`), riga viva in chat con frase, timer e token
(`Chat/MessageParts.tsx:243`), badge «Agenti attivi»
(`Sidebar/IdentityBlock.tsx:189`).

Il buco è quello lasciato dalla PR #141 (25/09). Un turno che finisce con un
Agent, un Bash, un Monitor o un Workflow ancora in background produce in
`/api/topics/streaming` una riga `state:"background"`
(`server/routes/topics.ts:1160`, `server/providers/background-probes.ts:95`), e
il client la tiene di proposito **fuori** da ogni insieme di streaming
(`client/src/state/useSignalsSync.ts:120-122`). `backgroundWorkSessions` la legge
un solo consumatore, lo Stop del composer (`Chat/ChatInput.tsx:388,1496`,
`Chat/composerAction.ts:79`). `useTopicLoading` (`state/signals.ts:1041`) e
`activeAgentRowsFrom` (`state/signals.ts:1313`, che legge solo `liveStream` e
`hydratedStream`) non la vedono.

Risultato: una chat che aspetta i propri agenti in background non ha spinner in
sidebar, in tab o sul progetto, non ha una riga in chat e non conta fra gli
agenti attivi. È esattamente «niente dice che sta aspettando».

## What changes

- **Server, un campo in sola lettura.** La riga `background` porta anche
  `tasks: {type, description}[]` e `lastSignalAt`, letti da
  `pp.background` (`server/providers/claude/background-work.ts:59-70`) tramite
  una sonda nuova del provider, accanto a `backgroundState`
  (`server/providers/claude-code.ts:2786`).
- **Stato client.** Lo stesso poll scrive, oltre a `backgroundWorkSessions`
  (che resta com'è per il composer), il lavoro in background **per topic**.
  Quelle chat **non** entrano in `liveStreamTopics` né in
  `hydratedStreamTopics`.
- **Glifo.** Terzo stato di `LoaderSlot`/`OrbitLoader`
  (`client/src/components/Layout/StreamingIndicator.tsx:94,151`),
  `data-loader-state="background"`, sulla riga di sidebar, sulla tab
  (`Layout/PaneTabBar.tsx:1703`) e sul roll-up del progetto chiuso.
- **Riga in chat** sopra il composer, accanto a `SubAgentsStrip`
  (`Chat/ChatPane.tsx:1848`), con i nomi dei task.
- **Agenti attivi.** `activeAgentRowsFrom` restituisce anche un gruppo
  `background`, mostrato in `Sidebar/AgentLines.tsx` sotto un'intestazione
  propria.

## Non-goals

Toccare il giudice di stallo, il goal loop, il reaper o
`BACKGROUND_WORK_CAP_MS` (lato server, restano come sono). Cambiare lo Stop del
composer o la route di stop (`server/routes/topics.ts:2449`). Far rispondere le
sonde di background a provider diversi da claude-code. Notificare la fine del
lavoro in background. Mostrare l'output dei task (lo fa già la card della shell,
`tests/e2e/chat-background-shell-live.spec.ts`).

## Rischio

Se le sessioni in background finissero in `hydratedStreamTopics` o
`liveStreamTopics`, `reconcileServerStreams` e il composer tratterebbero la chat
come un turno in volo: invio bloccato o accodato, e una riapertura fantasma del
turno. Per questo BGVIS-02 lo vieta con uno scenario proprio.
