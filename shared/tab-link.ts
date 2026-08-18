// La grammatica UNICA dei permalink alle tab: `/tab/<kind>/<chiave…>`.
//
// Perché esiste, e perché sta in `shared/`: il link a una tab ha TRE
// consumatori che devono leggerlo allo stesso modo — il client (che lo produce
// col «Copia link» e lo risolve al boot), il server (`GET /api/tabs/resolve`) e
// l'agente (tool `resolve_tab`, MCP + control-tools). Una grammatica scritta
// due volte è una grammatica che diverge: qui è pura (né React né Bun), quindi
// la importano tutti e tre e il test è uno solo. Stesso pattern di
// `shared/project-keys.ts` e `shared/shortcuts.ts`.
//
// ── Le forme ─────────────────────────────────────────────────────────────────
//   /tab/chat/<topicId>              la CHAT (il soggetto è il topic, non la pane)
//   /tab/terminal/<sessionId>        la sessione di terminale
//   /tab/browser/<contextId>         una pane browser  [?in=<proj> | ?task=<id>]
//   /tab/project/<projectPath>       la finestra di progetto (o un task-workspace)
//   /tab/file/<projectPath>/<file>   un file aperto DENTRO una finestra di progetto
//   /tab/diff/<projectPath>/<file>   idem, ma la vista diff
//   /tab/panel/<board|agents|dashboard|activity|cron>   le utility singleton
//   /tab/task/<taskId>               alias in LETTURA di `/task/<id>` (vedi sotto)
//
// Alias accettati in lettura (già in circolazione, non li produciamo più noi):
//   /task/<taskId>   → { kind: 'task' }   — l'UNICA forma riflessa nella history
//                      dal drawer della board (openTaskLink.reflectTaskOpen). Il
//                      produttore continua a emettere QUELLA: due scrittori di
//                      history si peserebbero addosso.
//   /topic/<topicId> → { kind: 'chat' }   — la push di fine turno.
//
// ── `task` è la SCHEDA, `chat` è la SESSIONE: non sono la stessa tab ─────────
// Di un task dispatchato esistono DUE destinazioni, con due chiavi diverse e due
// vite diverse, e la grammatica le tiene già separate — è il nome umano che le
// confondeva («apri il task» diceva sia l'una sia l'altra).
//   • `/tab/task/<taskId>`  = la SCHEDA: descrizione, checklist, consegna,
//     thread. È dove si DECIDE, ed esiste sempre, anche a agente morto.
//   • `/tab/chat/<topicId>` = la SESSIONE: la chat viva dell'agente
//     (`tasks.assigned_topic_id`). È dove si LAVORA, e può non esserci più.
// Chi aggiunge una superficie che porta all'una o all'altra la nomini di
// conseguenza: mai «apri il task», che non dice quale delle due. Il predicato
// che decide se la seconda esiste ancora è `client/src/lib/taskSession.ts`.
//
// ── Perché la chat porta il TOPIC e non l'id della pane ──────────────────────
// La stessa chat ha DUE id di pane a seconda di dove sta: `<topicId>` nudo a
// livello App, `chat:<topicId>` dentro una finestra di progetto. Un link che
// portasse l'id della PANE aprirebbe una seconda tab della stessa chat sulla
// superficie sbagliata. Portando il topic, la scelta della superficie resta a
// `openPanel`, che la fa già (e disarchivia da solo).
//
// ── L'ENCODING è il cuore della robustezza ──────────────────────────────────
// Un segmento è o un TOKEN SICURO (`^[A-Za-z0-9_-]+$`: uuid, contextId,
// sessionId, nomi di panel) o `~` + base64url senza padding per qualunque altra
// stringa (path di progetto, path di file). Non è estetica:
//   • `server/spa-fallback.ts` 404a ogni path il cui ULTIMO SEGMENTO contenga un
//     punto, e `encodeURIComponent` NON encoda il punto → `/Users/x/my.app`
//     sarebbe morto in silenzio (il rosso poi accusa il client). Base64url non
//     produce mai un punto.
//   • uno '/' dentro la chiave romperebbe il match a segmento singolo.
// Il padding '=' va STRIPPATO davvero: altrimenti finisce nel path.

export type TabKind =
  | 'chat'
  | 'terminal'
  | 'browser'
  | 'project'
  | 'file'
  | 'diff'
  | 'panel'
  | 'task';

/** I panel singleton indirizzabili: esattamente quelli che
 *  `handleOpenAsPage` (usePanelLifecycle) sa aprire, o il link sarebbe un
 *  evento che non apre niente. `agents`, `activity` e `journal` sono usciti
 *  insieme alle loro pane. */
export const TAB_PANELS = ['board', 'dashboard', 'cron', 'profile'] as const;
export type TabPanel = (typeof TAB_PANELS)[number];

export interface TabTarget {
  kind: TabKind;
  /**
   * La chiave primaria del soggetto: topicId | sessionId | contextId |
   * projectPath | filePath | nome del panel | taskId.
   */
  key: string;
  /**
   * Il progetto che OSPITA la tab. Obbligatorio per `file`/`diff` (le pane
   * interne a un progetto non stanno nel pane-store: si raggiungono aprendo
   * prima la finestra di progetto), opzionale su `browser` come hint di
   * proprietà.
   */
  projectPath?: string;
  /**
   * Il task che possiede la tab, per le pane browser montate dal drawer di un
   * task (`taskBrowserLayout`). Hint di proprietà, come `projectPath`.
   */
  taskId?: string;
}

export const TAB_PATH_PREFIX = '/tab/';

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;
const TASK_ALIAS_RE = /^\/task\/([^/]+)\/?$/;
const TOPIC_ALIAS_RE = /^\/topic\/([^/]+)\/?$/;

// ── base64url (senza padding), uguale su browser e su Bun ────────────────────
// `btoa`/`atob` esistono in entrambi, ma lavorano su binary string: passiamo per
// TextEncoder/TextDecoder così un path con accenti o emoji sopravvive.

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Un segmento di path che non contiene MAI '.' né '/'. */
export function encodeTabSegment(value: string): string {
  if (SAFE_SEGMENT.test(value)) return value;
  return `~${toBase64Url(value)}`;
}

/** L'inverso. Tollera un segmento ancora percent-encoded (una URL passata a
 *  mano) e restituisce `null` su base64 corrotto, mai un'eccezione. */
export function decodeTabSegment(segment: string): string | null {
  if (!segment) return null;
  if (segment.startsWith('~')) {
    try {
      return fromBase64Url(segment.slice(1));
    } catch {
      return null;
    }
  }
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isTabPanel(value: string): value is TabPanel {
  return (TAB_PANELS as readonly string[]).includes(value);
}

// ── Costruzione ──────────────────────────────────────────────────────────────

/** Il path (senza origine) del permalink, query inclusa. `null` se il target è
 *  incoerente — p.es. un `file` senza `projectPath`, che non sarebbe risolvibile. */
export function buildTabPath(target: TabTarget): string | null {
  if (!target || !target.key) return null;
  const key = encodeTabSegment(target.key);

  switch (target.kind) {
    case 'chat':
    case 'terminal':
    case 'project':
    case 'task':
      return `${TAB_PATH_PREFIX}${target.kind}/${key}`;
    case 'panel':
      return isTabPanel(target.key) ? `${TAB_PATH_PREFIX}panel/${target.key}` : null;
    case 'browser': {
      const qs = new URLSearchParams();
      if (target.projectPath) qs.set('in', encodeTabSegment(target.projectPath));
      if (target.taskId) qs.set('task', target.taskId);
      const search = qs.toString();
      return `${TAB_PATH_PREFIX}browser/${key}${search ? `?${search}` : ''}`;
    }
    case 'file':
    case 'diff': {
      if (!target.projectPath) return null;
      return `${TAB_PATH_PREFIX}${target.kind}/${encodeTabSegment(target.projectPath)}/${key}`;
    }
    default:
      return null;
  }
}

/**
 * Il permalink assoluto. `base` è l'origine su cui il link è APRIBILE davvero —
 * chi chiama passa `serverHttpBase() || window.location.origin` (sul guscio
 * Tauri la UI vive su `tauri://localhost`, un'origine che non si può aprire).
 * Stessa scelta, e stesso limite same-machine, di `buildTaskLink`.
 */
export function buildTabLink(target: TabTarget, base: string): string | null {
  const path = buildTabPath(target);
  if (!path) return null;
  try {
    const u = new URL(base);
    const [pathname, search] = path.split('?');
    u.pathname = pathname!;
    u.search = search ? `?${search}` : '';
    u.hash = '';
    return u.toString();
  } catch {
    return path;
  }
}

// ── Lettura ──────────────────────────────────────────────────────────────────

/**
 * Il target codificato in un pathname (+ query), o `null` se non è un
 * permalink. Accetta anche gli alias storici `/task/<id>` e `/topic/<id>`.
 */
export function parseTabPath(pathname: string, search = ''): TabTarget | null {
  if (typeof pathname !== 'string') return null;

  const taskAlias = TASK_ALIAS_RE.exec(pathname);
  if (taskAlias?.[1]) {
    const key = decodeTabSegment(taskAlias[1]);
    return key ? { kind: 'task', key } : null;
  }
  const topicAlias = TOPIC_ALIAS_RE.exec(pathname);
  if (topicAlias?.[1]) {
    const key = decodeTabSegment(topicAlias[1]);
    return key ? { kind: 'chat', key } : null;
  }

  if (!pathname.startsWith(TAB_PATH_PREFIX)) return null;
  const parts = pathname.slice(TAB_PATH_PREFIX.length).replace(/\/$/, '').split('/');
  const kind = parts[0] as TabKind | undefined;
  if (!kind) return null;

  switch (kind) {
    case 'chat':
    case 'terminal':
    case 'project':
    case 'task': {
      if (parts.length !== 2) return null;
      const key = decodeTabSegment(parts[1]!);
      return key ? { kind, key } : null;
    }
    case 'panel': {
      if (parts.length !== 2) return null;
      const key = decodeTabSegment(parts[1]!);
      return key && isTabPanel(key) ? { kind, key } : null;
    }
    case 'browser': {
      if (parts.length !== 2) return null;
      const key = decodeTabSegment(parts[1]!);
      if (!key) return null;
      const target: TabTarget = { kind, key };
      try {
        const qs = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
        const owner = qs.get('in');
        if (owner) {
          const projectPath = decodeTabSegment(owner);
          if (projectPath) target.projectPath = projectPath;
        }
        const taskId = qs.get('task');
        if (taskId) target.taskId = taskId;
      } catch {
        /* query malformata: il contextId da solo è comunque risolvibile */
      }
      return target;
    }
    case 'file':
    case 'diff': {
      if (parts.length !== 3) return null;
      const projectPath = decodeTabSegment(parts[1]!);
      const key = decodeTabSegment(parts[2]!);
      return projectPath && key ? { kind, key, projectPath } : null;
    }
    default:
      return null;
  }
}

/** Il target codificato in una URL intera (assoluta o relativa), o `null`. Non
 *  fa alcun controllo di origine: quello è compito di chi chiama (il client
 *  intercetta solo i link self-origin; il server accetta anche il path nudo). */
export function parseTabRef(ref: string): TabTarget | null {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const raw = ref.trim();
  try {
    // La base fittizia serve solo a far digerire un path relativo.
    const u = new URL(raw, 'http://tab.local');
    return parseTabPath(u.pathname, u.search);
  } catch {
    return null;
  }
}

/** Etichetta breve e leggibile del target — per i tooltip e per le risposte del
 *  resolver. NON è il titolo della tab (quello è autorevole solo alla fonte:
 *  `topics.name`, `tasks.text`, il roster dei terminali). */
export function describeTabTarget(target: TabTarget): string {
  switch (target.kind) {
    // La SESSIONE di lavoro, quando quel topic è l'agente di un task.
    case 'chat': return `chat ${target.key}`;
    case 'terminal': return `terminale ${target.key}`;
    case 'browser': return `browser ${target.key}`;
    case 'project': return `progetto ${target.key}`;
    case 'file': return `file ${target.key} (in ${target.projectPath})`;
    case 'diff': return `diff ${target.key} (in ${target.projectPath})`;
    case 'panel': return `pannello ${target.key}`;
    // «task» da solo era ambiguo esattamente quanto il bottone che apriva:
    // questo kind è la SCHEDA (il drawer), mai la sessione dell'agente — quella
    // è `chat`, e ha un id diverso. Vedi la nota in testa al file.
    case 'task': return `scheda del task ${target.key}`;
    default: return String(target.kind);
  }
}
