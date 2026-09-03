import { realpathSync } from "node:fs";
import { join } from "node:path";
import { scanWorkspaceProjects } from "./project-path-resolver";
import { isBroadCwd } from "../lib/broad-cwd";

/**
 * knownProjectDirs — l'UNIONE delle directory di progetto che il server già
 * conosce. È il confine di ogni endpoint che accetta un `path` dal client.
 *
 * Perché un'unione e non `projectStore`: in questa app quasi nessun progetto è
 * REGISTRATO. Si aprono al volo — picker di cartelle, terminali di Claude Code,
 * finestre di progetto — e non finiscono mai nello store. Un cancello basato
 * solo su `projectStore` 403-erebbe praticamente tutto (è già successo con le
 * favicon: sparite ovunque). Le cinque sorgenti qui sotto coprono i modi reali
 * in cui un progetto entra in questo server, e nessuna di esse è alimentabile
 * CHIAMANDO l'endpoint che si sta proteggendo — per questo l'unione è un
 * confine vero e non input del client travestito.
 *
 * Estratta da `GET /api/projects/icon` (`server/routes/projects.ts`), dove
 * viveva in linea con tutte le sue cicatrici — e dove per un po' è RIMASTA in
 * linea, copiata: l'estrazione aveva convertito le rotte dei file e lasciato
 * indietro la rotta dell'icona. Le due liste sono poi divergute davvero (la
 * sorgente 6 esisteva solo nell'indice della board), che è esattamente il buco
 * che questo modulo doveva chiudere. Ora la rotta dell'icona chiama QUESTA. La stessa lista serve ora anche
 * alle rotte dei FILE, che accettavano un `path` qualunque: `resolveProjectPath`
 * (`server/utils.ts`) fa un `resolve()` nudo, mentre il suo gemello
 * `resolveSafePath` la allowlist ce l'ha da sempre — e `/api/files/search`
 * spawna `grep` su ciò che gli si dà. Due copie di questa lista sarebbero due
 * confini che divergono, cioè un buco che si riapre da solo.
 *
 * Realpath su tutto: il confronto dev'essere a prova di symlink.
 */

export interface KnownProjectDirsCtx {
  db: { query: (sql: string) => { all: () => unknown[] } };
  loadTopics: () => { topics: Record<string, unknown> };
  worktreeStore: { list: () => unknown[] };
  /** Sintassi a METODO, non proprietà-freccia: TypeScript è bivariante sui
   *  metodi, e serve perché `ProjectStore.list` dichiara `archived?: boolean`
   *  mentre qui passiamo `null` — che è il valore load-bearing per «anche gli
   *  archiviati» (`project-store.ts:149-153`: undefined significa SOLO gli
   *  attivi, quindi omettere l'opzione escluderebbe metà dei progetti). */
  projectStore?: { list(opts?: { archived?: boolean | null }): unknown[] };
  /** Il workspace di OpenClaw (`<OPENCLAW_DIR>/workspace`). Omesso = si deduce
   *  dall'ambiente con la STESSA regola di `server/utils.ts:133`, così anche i
   *  chiamanti che non ce l'hanno sottomano (le rotte dei file) vedono la
   *  sorgente 6 invece di ritrovarsi un confine più stretto degli altri. */
  workspaceDir?: string;
}

/** La stessa risoluzione di `server/utils.ts:133` (`OPENCLAW_DIR`), a cui si
 *  appende `workspace`. Duplicata qui e non importata perché quella vive dentro
 *  la closure di `createUtils`, non è un export. */
function defaultWorkspaceDir(): string {
  const openclaw =
    process.env.APP_DATA_DIR || process.env.OPENCLAW_DIR || `${process.env.HOME}/.openclaw`;
  return join(openclaw, "workspace");
}

/** Le dir note al server, realpath'd. Set vuoto = nessun accesso concesso. */
export function knownProjectDirs(ctx: KnownProjectDirsCtx): Set<string> {
  const out = new Set<string>();
  // HOME, realpath'd like every entry, so the comparison in `add` is
  // symlink-proof on both sides.
  const home = (() => {
    const h = process.env.HOME || "";
    try { return h ? realpathSync(h) : ""; } catch { return h; }
  })();
  const add = (pth: unknown) => {
    if (typeof pth !== "string" || !pth) return;
    let real: string;
    try { real = realpathSync(pth); } catch { return; /* gone or unreadable */ }
    // A root at HOME (or above it) is not a project boundary, it is the
    // absence of one: with it in the set, `isInsideKnownProject` says yes to
    // every file under home. Source 4 fed it for free, because a terminal
    // opened without `cwd` is stored with the HOME default, and the file
    // routes then served `~/.zshrc` and `~/.ssh/known_hosts` (measured
    // 2026-09-03). The other sources can carry it too (a project pane opened
    // on `~`), so the rule sits on the single entry point rather than on one
    // source.
    if (isBroadCwd(real, home)) return;
    out.add(real);
  };

  // 1. Progetti registrati (pochi, in questo setup).
  try {
    for (const p of ctx.projectStore?.list({ archived: null }) ?? []) add((p as { path?: string }).path);
  } catch { /* store assente */ }
  // 2. Il progetto di ogni topic.
  try {
    for (const t of Object.values(ctx.loadTopics().topics)) add((t as { projectPath?: string }).projectPath);
  } catch { /* topics illeggibili */ }
  // 3. I worktree.
  try {
    for (const w of ctx.worktreeStore.list()) add((w as { absPath?: string }).absPath);
  } catch { /* store assente */ }
  // 4. La cwd di ogni sessione di terminale.
  try {
    for (const row of ctx.db.query("SELECT DISTINCT cwd FROM terminal_sessions").all() as Array<{ cwd?: string }>) {
      add(row.cwd);
    }
  } catch { /* tabella assente */ }
  // 5. I progetti aperti come FINESTRA e mai registrati altrove: esistono solo
  //    negli snapshot di UI persistiti (pane id + expandedNodes della sidebar).
  //    Senza questa sorgente il cancello escludeva ogni progetto aperto col
  //    picker — la regressione «le icone dei progetti non si vedono più».
  //    Entrambe le codifiche circolano: il pane id percent-encoda il path
  //    (`project:%2FUsers%2F…`), la sidebar lo tiene grezzo (`project:/Users/…`).
  try {
    const projTokenRe = /project:((?:%2[Ff]|\/)[^"\\]*)/g;
    for (const row of ctx.db.query("SELECT value FROM ui_state").all() as Array<{ value?: string }>) {
      const v = row.value;
      if (typeof v !== "string" || !v.includes("project:")) continue;
      let m: RegExpExecArray | null;
      while ((m = projTokenRe.exec(v)) !== null) {
        let p = m[1];
        try { p = decodeURIComponent(p); } catch { /* token grezzo */ }
        add(p);
      }
    }
  } catch { /* tabella assente */ }
  // 6. I progetti che il server ENUMERA nel workspace di OpenClaw — figli
  //    diretti con un marcatore (`scanWorkspaceProjects`). È la sorgente da cui
  //    l'indice della board (`GET /api/all-boards/projects`) tira fuori i `path`,
  //    e il path è l'UNICA cosa da cui nasce un'icona
  //    ([[project_board-project-index-is-the-only-path-source]]). Mancava qui:
  //    un progetto del workspace mai legato a un topic, mai aperto in una
  //    finestra e senza terminale dentro compariva NELLA LISTA e prendeva 403
  //    sulla favicon. Misurato il 2026-08-07 sui cinque progetti del workspace:
  //    `open-carousel`/`match-compass`/`generale` erano coperti da ui_state o
  //    dal projectPath di un topic (204 «nessuna icona», legittimo), mentre
  //    `dashboard` e `dancerooms` non stavano in NESSUNA delle cinque sorgenti
  //    → 403. Non alimentabile chiamando le rotte protette: per entrare qui
  //    serve una cartella con un marcatore dentro il workspace, cioè un accesso
  //    al disco che questo confine non concede.
  try {
    for (const p of scanWorkspaceProjects(ctx.workspaceDir ?? defaultWorkspaceDir())) add(p);
  } catch { /* workspace assente/illeggibile */ }

  return out;
}

/**
 * `real` è dentro una delle dir note? Vale la dir stessa e qualunque cosa sotto.
 *
 * Il confronto è sul path REALE (già risolto dal chiamante) e col separatore
 * esplicito: senza, `/Users/me/proj-segreto` passerebbe per un discendente di
 * `/Users/me/proj`. È la stessa forma di `resolveSafePath` in `server/utils.ts`.
 */
export function isInsideKnownProject(real: string, allowed: Set<string>): boolean {
  for (const base of allowed) {
    if (real === base || real.startsWith(base + "/")) return true;
  }
  return false;
}
