# D2d · bundle iniziale sotto 400 KB

**Barra prima:** build iniziale exit 0; `check:bundle` con `entry_eager` a 1.708.681 raw / 546.357 gzip. Applicando lo stesso tetto di 400.000 byte (baseline gzip 392.156 con tolleranza 2%), il codice iniziale esce 1: 546.357 > 399.999.

**Barra dopo:** build finale exit 0; `entry_eager` 872.422 raw / 281.160 gzip. Il tetto registrato è 392.156 gzip, che con la tolleranza esistente vale 399.999 byte. `check:bundle`, typecheck, lint e test client mirati exit 0.

## Fatto

- `client/src/App.tsx`: `TopicTree`, `PanelGrid`, `Inbox`, PairingApproval, notifiche, prompt push e menu contestuale sono caricati dinamicamente. I fallback mantengono lo spazio della sidebar, della griglia e del pulsante Inbox; gli overlay non spostano il layout.
- `client/src/components/Layout/ChatPanel.tsx` e `ProjectWindow.tsx`: `ChatPane` e il transcript arrivano al primo montaggio della chat; il fallback conserva l'area del contenuto.
- `scripts/bundle-baseline.json`: baseline `entry_eager` aggiornata a 872.422 raw / 392.156 gzip; con la tolleranza del 2% il tetto compresso è 399.999 byte.
- `bun run build:client` finale: exit 0. `bun run check:bundle`: exit 0, eager 546.357 → 281.160 gzip (-48,5%); critical path 710.110 → 444.915 gzip. `total_assets` 8.916.372 raw, entro la tolleranza esistente.
- Sul grafo statico iniziale, gzip -9 individuale dei sorgenti: `i18n-it.ts` 71.143, `App.tsx` 57.700, `useChat.ts` 55.872, `TopicTree.tsx` 52.014, `PanelGrid.tsx` 51.737, `shared/board.ts` 50.878, `MessageList.tsx` 48.733, `usePanelLifecycle.ts` 46.286, `ChatPane.tsx` 43.012, `useTauriBrowser.ts` 41.836, `PaneTabBar.tsx` 34.492, `ChatInput.tsx` 33.500, `GroupLayout.tsx` 31.966, `shared/types.ts` 30.004, `selectionStyles.ts` 27.788 byte.
- Nel grafo statico residuo dopo gli split, i primi 15 sorgenti gzip -9 sono: `i18n-it.ts` 71.143, `App.tsx` 57.898, `useChat.ts` 55.872, `shared/board.ts` 50.878, `usePanelLifecycle.ts` 46.286, `useTauriBrowser.ts` 41.836, `shared/types.ts` 30.004, `selectionStyles.ts` 27.788, `RemoteBrowserPanel.tsx` 26.939, `useRemoteBrowser.ts` 26.323, `lib/board.ts` 25.133, `types/index.ts` 23.741, `lib/api.ts` 22.749, `ws-outbound.ts` 21.768, `tabLink.ts` 18.251 byte. Le nuove chunk misurate da Vite: `TopicTree` 25.780 gzip, `PanelGrid` 39.890, `ChatPane` 68.760.
- Metodo della classifica: gzip -9 di ogni sorgente raggiungibile staticamente, preso da `git archive HEAD` prima e dal working tree dopo. Vite non emette sourcemap né manifest con la ripartizione dei byte minificati per modulo; i numeri per sorgente sono una classifica di peso, non contributi esatti al JS minificato.
- `bun run typecheck`: exit 0 su client, test client, server (0 errori), e2e e relay. `bun run lint`: exit 0, 4 warning, 0 errori. Test client mirati (`inAppBanner`, `inAppBannerTimers`, `usePanelGridPersistence`): exit 0, 22 pass, 0 fail.

## Trovato e non fatto

- Le e2e complete non girano sul Mac per le regole locali; le esegue la CI sulla PR. Non ho fatto commit o push: la worktree locale vieta entrambi. La prova di comportamento browser resta quindi al workflow CI.
- La classifica esatta dei moduli dentro il chunk minificato richiederebbe una sourcemap o un plugin di report Rollup; la build disponibile non li produce. Ho riportato la classifica gzip dei sorgenti e le dimensioni reali delle chunk emesse, senza attribuire loro una precisione che non hanno.

## Rifiutato

- Il warning Vite sui chunk oltre 500 KB riguarda chunk lazy (`mermaid.core` e `cynefin`), non `entry_eager`; il ratchet misura separatamente l'entry e il totale resta entro la tolleranza.

## Giro 2

**Barra prima:** giro 1, `build:client` exit 0; `check:bundle` exit 0, entry gzip 281.160 KB, limite effettivo 399.999 KB.

**Barra dopo:** `bun run build:client && bun run check:bundle` exit 0; entry gzip 281.544 KB, limite effettivo 399.999 KB. Baseline e gate restano quelli del giro 1.

### Fatto

- `TopicTree` e `PanelGrid` usano i loader `retryingChunk` condivisi con `lazyWarm`; `ChatPane` usa un loader condiviso da `ChatPanel` e `ProjectWindow`. Il gate aspetta sempre i primi due e aggiunge `ChatPane` solo se `panesOnFirstFrame` trova una chat visibile.
- Inbox, PairingApproval, InAppBanners, PushEnrollPrompt e ContextMenu restano lazy con `retryingChunk`.
- Test mirati Bun exit 0: 15 pass, 0 fail; includono la selezione dei loader, il rendering caldo senza fallback e il controllo del wrapper condiviso. Mutazione in copia, `ChatPanel` con `lazy` nudo: il test diventa rosso, exit 1.
- `bun run typecheck` exit 0. `bun run lint` exit 0, 4 warning già esistenti, 0 errori. `check:bundle` exit 0: entry gzip 281.544 KB; critical path 445.303 KB.

### Trovato e non fatto

- Le e2e restano alla CI, come da brief locale; sul Mac sono vietate salvo le spec WebKit autorizzate.

### Rifiutato

- Il warning Vite sul chunk `index` oltre 500 KB misura il JavaScript minificato non compresso; l'entry gzip resta 281.544 KB e il gate compresso è verde.
