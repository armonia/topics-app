# D5b · Worktree pronte all'uso

**Barra prima:** non misurata prima del primo edit. **Barra dopo:** `bun test server/services/worktree-ready.test.ts server/services/worktree-manager.test.ts server/lib/project-scripts.test.ts server/services/task-dispatcher.test.ts` → 271 pass, 0 fail; `bun run typecheck` → 0 (include `typecheck:e2e`); `bun run lint` → 0; mutazione in copia → il test dell'inclusione fallisce, exit 1 atteso. E2E con video: scritta e typechecked, da eseguire in CI; il brief vieta questa suite sul Mac.

## Fatto

- `.worktreeinclude` usa le regole d'esclusione Git; copia solo file non tracciati, ignora symlink e impedisce pattern `..` e sorgenti risolte fuori dalla radice. Test unitario verde; la copia mutata non copia `.env` e il test diventa rosso (exit 1).
- Configurazione scelta: `.topics/worktree.json`, con `setup`, `run`, `archive` facoltativi in forma `{ "command": "...", "args": [...] }`; `setup.timeoutMs` è facoltativo, default 120 s, massimo 600 s. Tiene insieme le azioni di lifecycle di Topics senza alterare i manifest del package manager.
- `setup` gira dopo copia e dipendenze; esito, exit code e ultime 20 righe finiscono nel thread della card. Un errore o timeout non blocca il turno. `run` entra nel runner script esistente; `archive` gira prima della rimozione.
- `TOPICS_PORT` è assegnata stabilmente per il set di worktree esistente, con porte 20000–39999 e collisioni risolte ordinando i percorsi; è esposta nelle API worktree e passata agli script.
- Spec browser per due card: `.env`, setup, run, porte distinte, stabilità dopo riavvio. `bun run typecheck` include `bun run typecheck:e2e` → 0; l'esecuzione con video resta al gate CI.
- Prove: Bun 1.4.2; suite mirata 271/271, `bun run typecheck` exit 0, `bun run lint` exit 0, `git diff --check` exit 0. Quattro warning lint client preesistenti, zero errori.

## Trovato e non fatto

- La spec e2e non è stata eseguita: `BRIEF-locale.md` vieta le e2e Chromium sul Mac e riserva la spec nuova alla CI. Serve il workflow «Clip di consegna» dopo la consegna del ramo.
- Revisione indipendente non eseguita in questa consegna locale; resta il gate prima del merge previsto dalle regole comuni.
- Nessuna dipendenza o migration aggiunta. Scelta di configurazione e default timeout decisi qui, senza risposta richiesta dal brief.

## Rifiutato

- Symlink verso file ignorati: darebbero alla worktree accesso in scrittura al checkout sorgente; i symlink selezionati vengono saltati.
- Setup non riuscito come errore di creazione: lascerebbe la card senza turno; l'esito visibile permette di lavorare e correggere il setup.

## Giro 2 · revisione

- **Porte in ordine di nascita, non di percorso.** Con l'ordine per percorso una worktree nuova il cui hash collide prendeva la porta di una più vecchia, magari con il suo server già acceso. Ora l'ordine è `createdAt` (persistito, quindi uguale dopo un riavvio). Test nuovo «a newcomer whose hash collides never moves the port of an older worktree»: rosso con l'ordine per percorso (exit 1, copia nello scratchpad), verde ora.
- **`git ls-files` asincrono.** Sul checkout vero di topics-app impiega 0,74 s (cammina anche `node_modules`): sincrono, fermava ogni socket del server per quel tempo. Ora `spawnBounded` con tetto di 30 s.
- **La copia non costa la worktree.** Un errore di `.worktreeinclude` si logga e la creazione prosegue.
- **Tetto del setup a 300 s**, non 600: dipendenze più setup devono stare nei 600 s di attesa del dispatcher.
- L'esito del setup si toglie dalla mappa quando la worktree viene cancellata; tolto `worktreeRunScript`, mai chiamato.
- Requisito nuovo WORKTREE-15 in `openspec/specs/worktrees/spec.md`; `@covers` nel test bun, annotazione nella e2e.
- Mutazione della SCOPE rifatta sul codice nuovo, in copia: senza `copyFileSync` il test della copia esce con 1.
