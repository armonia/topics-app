# D4a · Mirror a pezzi e compresso

## Barra · prima → dopo

- Prima: il mirror inviava il FullSnapshot in un solo frame; 4 pagine vere su 5 pesavano 2,1–4,8 MB contro il limite socket di 1 MiB; chiusura 1006 osservata a 1.126.440 B (baseline in SCOPE). Fixture e2e tutte sotto 1 MiB.
- Dopo: `bun test server/browser-host-big-frame.test.ts` → **1 pass, 0 fail, 2,14 s, exit 0**; snapshot 4,8 MB, socket aperti dopo 2 s, ricostruzione identica, frame sotto 512 KiB e compressi. Mutazione isolata a un frame: test rosso, **exit 1**.

## Fatto

- `client/src/lib/nativeDomHost.ts`: il drain conserva il batch e lo legge in blocchi UTF-8 da 192 KiB; i blocchi base64 restano sotto il limite del socket.
- `server/browser-host-mirror.ts`, `shared/browser-ws-messages.ts`, `shared/browser-ws-chunks.ts`: riassemblaggio del lato host, relay del FullSnapshot in frame compressi sopra 1 KiB e ricostruzione lato viewer; limite di 12 MiB, 64 blocchi e una sola ricomposizione pendente per socket.
- `server/lib/websocket-options.ts` è la configurazione condivisa da `server.ts` e dal test Bun. Limite esplicito **512 KiB**; il close 1009 scrive nel log il limite e il motivo.
- `server/browser-host-big-frame.test.ts` → Bun.serve reale con opzioni condivise; durante il burst un viewer si disconnette e si ricollega, il mirror completa comunque la ricomposizione.
- `client/src/lib/nativeDomHost.page.test.ts` → drain reale su 4,8 MB, blocchi ≤192 KiB e ricostruzione identica. Test co-browse mirati → **46 pass, 0 fail, exit 0**.
- `tests/e2e/browser-native-host-sync.spec.ts` → scenario con fixture FullSnapshot da 3 MB e trasporto a blocchi. Revisione indipendente: i due finding (assemblaggio perso alla chiusura viewer e limiti/gate chunk) sono stati risolti; il test copre la disconnessione.
- `bun run typecheck` → exit **0**, cinque target verdi. `bun run lint` → exit **0**, zero errori e quattro warning React; `git diff --check` → exit **0**.

## Trovato e non fatto

- L’e2e non è stata lanciata sul Mac, come vieta il brief; `typecheck:e2e` è verde. La spec la esegue la CI «Clip di consegna».
- La misura live su Wikipedia «Italia» resta al proprietario dopo il merge, come da scope. Nessun push o commit.
- `origin/main` è avanzato di un commit D5f durante il lavoro; tocca anche `server.ts`. Nessun rebase della worktree con modifiche locali, da integrare prima della consegna.

## Rifiutato

- I quattro warning lint non sono errori B1: tre stanno in file non toccati; quello in `useRemoteBrowser.ts:1669` è fuori dal diff. Nessuna modifica ai relativi hook.

## Revisione (Claude)

- **I pezzi della pagina si ricompongono nel client.** Il client rimette insieme i pezzi del drain con `BrowserWsChunkAssembler`, ne legge gli eventi con la stessa `parseHostEvents` di un batch intero (NATDEL-04) e verso il server manda solo pezzi costruiti da sé. Test «pieces from the page are put back together here…»: rosso sulla prima versione del ramo (exit 1, copia nello scratchpad), verde ora.
- **Il tetto in ingresso resta 1 MiB.** Era sceso a 512 KiB per ogni messaggio del client, cosa che la traccia non chiedeva: avrebbe chiuso il socket a qualunque altro messaggio cresciuto oltre. Ora è esplicito in `server/lib/websocket-options.ts`, con il motivo. I frame verso i viewer restano sotto 512 KiB.
- Requisito nuovo NATIVE-HOST-05 in `openspec/specs/remote-browser/spec.md`; `@covers` nel test d'integrazione, nel test del drain e nella e2e.
