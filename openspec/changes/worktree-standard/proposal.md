# Worktree standard: una radice, un progetto per repo, un ciclo di vita misurato

## Perché
Oggi le worktree di Topics nascono ovunque (`~/.topics/worktrees`, `$TMPDIR`, le cartelle di Claude Desktop, cartelle sorelle `<repo>-wt-*`), un percorso di worktree può diventare un progetto con la sua board (5 progetti-worktree sulla macchina del 24/11), e nessuno conta ciò che resta sul disco: 37 cartelle e 16,8 GB senza riga nel DB. Gli altri strumenti convergono su radice unica + `progetto/nome` (Conductor, Codex, Vibe Kanban) e i guasti noti vengono da due cose: pulizie che rimuovono lavoro vivo e perdite di disco che nessuno vede (Cursor 100k fd e kernel panic dentro il repo, codex#35383 con 202 GB in `/tmp`).

## Cosa cambia
- **Radice configurabile** (`app_settings.worktree_root`, default `<casa di Topics>/worktrees`, quindi zero migrazione); ordine: env `TOPICS_WORKTREES_DIR` › impostazione › default. Struttura fissa `{radice}/{slug-progetto}/{nome}`. Mai dentro il repo né in `/tmp`.
- **Checkout usa-e-getta nella radice**: `{radice}/_scratch/{land|realign|integrazione|node-checks}/{id}` al posto di `$TMPDIR`, con una spazzata d'avvio.
- **GC su righe e radice insieme**, marcatore di proprietà e `git worktree lock` mentre un agente lavora; mai rimosse worktree lockate, sporche, non pushate, con card attiva o più giovani di 24 h; ref d'archivio prima di ogni rimozione; anteprima (`dryRun`).
- **Tetti come impostazioni**: worktree per progetto (default 20), pavimento disco (default 12 GB), `CARGO_TARGET_DIR` condiviso per progetto (`cargo_target_mode`).
- **Un worktree non è mai un progetto**: `canonicalProjectFor(path)` risolve la common dir git; un path di worktree porta al progetto del repo.
- **Accorpa / separa** per i repo fratelli: `projects.parent_id` + `merge_mode`, board e sidebar mostrano il figlio sotto il padre; nessuna riga di `tasks` riscritta.
- **Adotta / sposta** le worktree fuori radice, con anteprima, solo se pulite e senza sessione viva.

- **Worktree fatti da altri (addendum cross-macchina)**: una porta di registrazione aperta dal solo token degli hook (`POST /api/worktrees/register`, `GET /placement`, `POST /unregister`), il creatore in `worktrees.source`, marcatore v2, lock per creatore (`claude-code:` tolto solo a sessione finita e niente da perdere), GC che legge i due archivi; le regole di percorso provate anche per Windows.

Sette tracce più T8 e T13 dell'addendum; il dettaglio e le barre in `tasks.md` e `specs/acceptance.md`, i requisiti in `specs/worktree/spec.md` (WORKTREE-STD-01..10).

## Barra
Ogni traccia ha il suo comando che esce non-zero (elenco in `tasks.md`); in complesso: `bun test` dei file nuovi di ogni traccia esce 0, `bun scripts/worktree-orphans.ts --check` esce 0 sulla macchina vera dopo il GC (nessun fantasma, orfano non registrato o riga senza cartella; scansione sotto i 2 s), lo scenario e2e di accorpa/separa con video esce 0, e ciò che è verde resta verde (`worktree-manager`, `worktree-gc*`, `task-automerge*`, `project-path-resolver`, `tasks` dalla CI della PR).

## Fuori
- Spostare da sé le worktree create da altri (Claude Desktop, fratelli, `/private/tmp`): si vedono, si adottano o si spostano a mano con anteprima.
- Riscrivere `tasks.project_id` o `topics.project_path` esistenti.
- Template di percorso con variabili; symlink di `node_modules`.
- Dipendenze da un orchestratore esterno e dalle sue cartelle di build: regola zero, Topics è per chiunque.
- Una libreria git in Rust: solo se la scansione della radice misura più di 2 s a giro (barra di T3), allora sidecar `topics-wt` con stessa interfaccia JSON.

## Da decidere
Niente: nessuna spesa, nessun dato di persone vere, nessuna operazione irreversibile senza ref d'archivio e anteprima. Le scelte tecniche le prende l'agente e le dice a fine lavoro.

## Non ancora specificato
Come si dà un nome leggibile alle worktree create dal flusso «Adotta» di una cartella senza progetto noto: non so ancora formulare quale nome basti quando né il ramo né la cartella lo dicono.
