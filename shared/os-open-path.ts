/**
 * Un path consegnato dall'OS diventa una tab: la regola, pura.
 *
 * Il sistema operativo sa una cosa sola quando qualcuno fa "Apri con Topics" o
 * trascina una cartella sull'icona: un path. Topics non apre path, apre TAB. In
 * mezzo serve una decisione, ed è quella che sta qui:
 *
 *   · una CARTELLA è un progetto. Si apre come lo apre la sidebar.
 *   · un FILE non è mai solo un file: senza il progetto attorno l'editor non ha
 *     albero, git, terminale. Quindi si apre il progetto che lo CONTIENE e si
 *     mette a fuoco il file dentro.
 *
 * Perché pura, e perché in `shared`. La decisione ha tre chiamanti potenziali
 * (il guscio Rust che riceve il path, il server che sonda il filesystem, il
 * client che apre la tab) e una sola verità. Il filesystem sta FUORI: chi
 * chiama porta i fatti già raccolti (è una cartella? quali antenati hanno un
 * marcatore di progetto? quali progetti conosce l'app?) e qui si decide. Così
 * la regola si prova senza montare un albero di finte cartelle a ogni caso.
 *
 * Il risultato è un `TabTarget`, cioè il tipo che il permalink `/tab/...` già
 * usa: aprire un file dal Finder e aprire lo stesso file da un link incollato
 * in chat finiscono nella STESSA funzione del client (`openTabInApp`), che sa
 * già aspettare il mount della finestra di progetto. Una seconda strada avrebbe
 * dovuto reimparare quell'attesa, e l'avrebbe imparata peggio.
 */
import type { TabTarget } from './tab-link';

/**
 * Le estensioni che il bundle dichiara all'OS come "Topics sa aprirlo".
 *
 * È la stessa lista che sta in `desktop-tauri/src-tauri/tauri.conf.json` sotto
 * `bundle.fileAssociations`, e un test la confronta riga per riga: le due
 * copie non possono divergere in silenzio, che è esattamente il modo in cui
 * un'associazione sparisce da una piattaforma sola senza che nessuno se ne
 * accorga fino alla release.
 *
 * Il criterio della lista: i file che si aprono LAVORANDO su un progetto. Non
 * i formati di cui esiste un'app migliore (immagini, pdf, video, archivi):
 * rubare a Anteprima il doppio click su un .png non è un servizio.
 */
export const DEV_FILE_EXTENSIONS: readonly string[] = [
  'md', 'markdown', 'mdx', 'txt',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'jsonc',
  'rs', 'py', 'go', 'rb', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'lua', 'sql',
  'yaml', 'yml', 'toml', 'ini', 'env', 'conf',
  'css', 'scss', 'less', 'html', 'htm', 'svg', 'vue', 'svelte',
  'sh', 'bash', 'zsh', 'fish',
];

/** I marcatori che dicono "qui comincia un repository". Vincono sugli altri. */
export const VCS_MARKERS: readonly string[] = ['.git', '.hg', '.svn'];

/**
 * I marcatori che dicono "qui comincia un progetto" senza essere un repo: il
 * manifesto di un gestore di pacchetti. Servono per le cartelle che non sono
 * (ancora) sotto versione, e come ripiego dentro un monorepo senza `.git`.
 */
export const MANIFEST_MARKERS: readonly string[] = [
  'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'deno.json', 'deno.jsonc',
  'requirements.txt', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'CMakeLists.txt',
];

/** I fatti che il filesystem deve dire prima che qui si possa decidere. */
export interface OsPathFacts {
  /** Il path è una cartella? (falso = file esistente) */
  isDirectory: boolean;
  /** I progetti che l'app conosce già, path assoluti. Hanno la precedenza. */
  knownProjects?: readonly string[];
  /** Gli antenati del file che contengono un marcatore VCS, in qualunque ordine. */
  vcsRoots?: readonly string[];
  /** Gli antenati del file che contengono un manifesto, in qualunque ordine. */
  manifestRoots?: readonly string[];
}

/**
 * Il path pulito, o null se non è un path.
 *
 * Tre pulizie, tutte nate da come l'OS consegna davvero il path: il Finder di
 * macOS lo passa come `file://` percent-encoded, la riga di comando lo passa
 * con gli spazi già risolti ma a volte con la barra finale, e Windows usa la
 * barra rovescia. Le virgolette attorno arrivano da chi lancia da una shell.
 */
export function normalizeOsOpenPath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  if (p.length >= 2 && ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'")))) {
    p = p.slice(1, -1);
  }
  if (/^file:\/\//i.test(p)) {
    // `file:///Users/x` → `/Users/x`; `file:///C:/x` → `C:/x`.
    let rest = p.slice('file://'.length);
    const slash = rest.indexOf('/');
    // Un host nell'authority (`file://server/share`) non è un path locale.
    if (slash > 0) return null;
    if (slash === 0) rest = rest.slice(1);
    try { rest = decodeURIComponent(rest); } catch { /* percent-encoding rotto: si tiene il grezzo */ }
    p = /^[A-Za-z]:/.test(rest) ? rest : `/${rest}`;
  }
  if (!p) return null;
  // Nessun path assoluto = niente da aprire: un path relativo dipende da una
  // cwd che qui non esiste, e indovinarla aprirebbe la cartella sbagliata.
  const absolute = p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
  if (!absolute) return null;
  return stripTrailingSeparator(p);
}

/** Via la barra finale, tranne quando la barra È il path (la radice). */
function stripTrailingSeparator(p: string): string {
  let out = p;
  while (out.length > 1 && (out.endsWith('/') || out.endsWith('\\'))) {
    const head = out.slice(0, -1);
    // `C:/` resta `C:/`: `C:` da solo non è una cartella, è un'unità.
    if (/^[A-Za-z]:$/.test(head)) break;
    out = head;
  }
  return out;
}

/** La cartella che contiene il path, o null se il path è già una radice. */
export function parentDir(p: string): string | null {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (cut < 0) return null;
  if (cut === 0) return p.length > 1 ? '/' : null;
  const head = p.slice(0, cut);
  if (/^[A-Za-z]:$/.test(head)) return `${head}/`;
  return head || null;
}

/**
 * Gli antenati del path, dal più vicino al più lontano, radice inclusa.
 *
 * È la lista su cui chi chiama va a cercare i marcatori: un `existsSync` per
 * cartella, fermandosi appena la risposta è certa. Qui non si tocca il disco.
 */
export function ancestorDirs(p: string): string[] {
  const out: string[] = [];
  let cur: string | null = parentDir(p);
  while (cur) {
    out.push(cur);
    const next: string | null = parentDir(cur);
    if (!next || next === cur) break;
    cur = next;
  }
  return out;
}

/** `child` sta dentro `root` (o è `root`)? Confronto a confine di segmento. */
export function pathContains(root: string, child: string): boolean {
  if (!root || !child) return false;
  const r = stripTrailingSeparator(root);
  if (child === r) return true;
  const sep = r.endsWith('/') || r.endsWith('\\') ? '' : '/';
  return child.startsWith(`${r}${sep}`) || child.startsWith(`${r}\\`);
}

/** Profondità di un path, per scegliere il candidato più vicino al file. */
function depth(p: string): number {
  return p.split(/[/\\]+/).filter(Boolean).length;
}

/** Il più profondo tra i candidati che contengono il file, o null. */
function deepestContaining(candidates: readonly string[] | undefined, filePath: string): string | null {
  let best: string | null = null;
  for (const raw of candidates ?? []) {
    const c = normalizeOsOpenPath(raw);
    if (!c || !pathContains(c, filePath)) continue;
    if (!best || depth(c) > depth(best)) best = c;
  }
  return best;
}

/**
 * Il progetto a cui appartiene un file, nell'ordine in cui le risposte contano.
 *
 * 1. un progetto GIÀ APERTO nell'app che lo contiene: aprire un file del
 *    progetto su cui stai lavorando non deve creare un secondo progetto sulla
 *    sottocartella, o la sidebar si riempie di doppioni della stessa cosa;
 * 2. il repository più vicino: dentro un monorepo la radice giusta è quella
 *    con il `.git`, non la cartella del pacchetto;
 * 3. il manifesto più vicino, per quello che sotto versione non c'è;
 * 4. la cartella che contiene il file. Un file sciolto è un progetto di una
 *    cartella: brutto, ma apribile. Rifiutarsi sarebbe peggio.
 */
export function projectRootForFile(filePath: string, facts: OsPathFacts): string {
  return (
    deepestContaining(facts.knownProjects, filePath)
    ?? deepestContaining(facts.vcsRoots, filePath)
    ?? deepestContaining(facts.manifestRoots, filePath)
    ?? parentDir(filePath)
    ?? filePath
  );
}

/**
 * La regola completa: path + fatti → la tab da aprire, o null.
 *
 * Null vuol dire "non so cosa aprire" (path vuoto, relativo, malformato) e chi
 * chiama non deve fare niente: aprire una finestra sbagliata è peggio che non
 * aprire niente, perché la finestra sbagliata poi la si chiude a mano.
 */
export function osOpenTarget(rawPath: string, facts: OsPathFacts): TabTarget | null {
  const path = normalizeOsOpenPath(rawPath);
  if (!path) return null;
  if (facts.isDirectory) return { kind: 'project', key: path };
  return { kind: 'file', key: path, projectPath: projectRootForFile(path, facts) };
}
