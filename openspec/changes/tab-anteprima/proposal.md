# Tab di anteprima, e gli agenti fuori dalla barra

## Da decidere
Niente: scelte tecniche prese dall'agente.

## Perché
Il 10/11 Attilio vede «un sacco di tab». Misura sul DB vivo: 131 chat aperte, 111 nate da Jarvis
(«Jarvis, canali» 79, «Jarvis, lavori programmati» 32); la finestra di progetto `~/.claude/jarvis/home`
aveva 47 tab, 40 chat di Jarvis + 7 browser, 0 in anteprima. Entravano dal ramo delta-add di
`useProjectChatSync` (ogni topic nuovo del progetto = una tab) e da `pane:focus-suggest`.
Dentro un progetto, il clic dalla barra laterale aggiungeva sempre una tab fissa.

Stato dell'arte: VS Code `workbench.editor.enablePreview` (tab in corsivo sostituita dalla prossima,
fissata da modifica o doppio clic), Zed fa lo stesso con le preview tabs. Topics ha già il modello
(`lib/previewTabs.ts`, corsivo in `PaneTabBar`) ma solo per la barra standalone e per i file.

## Cosa cambia
1. Una chat aperta in anteprima dentro un progetto (clic dalla barra laterale, «apri la sessione» della
   card) prende il posto della chat provvisoria del gruppo; diventa fissa con un clic o un tasto dentro,
   un messaggio, o il doppio clic sulla tab. ⌘-clic apre fissa.
2. `isAgentOwnedTopic` (sottoagente, figlia di una radice di Jarvis via `parentId`, card dispatchata
   `mcpPolicy: bridge-only`): non apre tab né dal delta-add né da `pane:focus-suggest`. Resta nella barra
   laterale, nell'Agenti e sulla board.
3. Migrazione una tantum per progetto: le tab di agenti già aperte si chiudono al primo carico (non si
   archivia niente, la chat attiva resta).

## Barra
`bun test client/src/lib/agentTabs.test.ts client/src/components/Layout/hooks/useProjectChatSync.test.tsx`
(exit 0) · mutazione: togliere `if (isAgentOwnedTopic(topic)) continue;` fa uscire 1 ·
`E2E_EVIDENCE=1 E2E_VIDEO=1 npx playwright test tests/e2e/tab-anteprima.spec.ts` (video).

## Fuori
Barra standalone (ha già l'anteprima), tab browser e terminali, `taskBrowserTabs.ts` (le tab del
browser delle card hanno già il loro parcheggio).

## Non ancora specificato
Se Attilio vuole l'anteprima anche per i terminali aperti dagli agenti nel progetto.
