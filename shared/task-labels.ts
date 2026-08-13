/**
 * Le etichette dei task — poche, chiuse, e con una CONSEGUENZA.
 *
 * Il motivo per cui esistono non è la tassonomia: è che l'11/08/2026 la coda di
 * review della board era una pila indistinta, e chi doveva chiudere ogni card lo
 * si decideva a mano, aprendo il diff. Questa è quella decisione, scritta una
 * volta sola.
 *
 * TRE CLASSI, non due. La prima versione ne aveva due (`visibile` per ciò che
 * tocca `client/src`, `invisibile` per tutto il resto) e sbagliava il caso più
 * importante. Rifatto il conto sulla coda vera:
 *
 *     VISIBILI    (client/src, non-test)          21   ← le guarda una persona
 *     DECISIONI   (piani, ricerche, documenti)     7   ← le decide una persona, sempre
 *     INVISIBILI  (server / shared / script / test) 2   ← le chiude il conduttore
 *
 * Con due classi, i sette piani finivano in «invisibile» e l'agente se li sarebbe
 * chiusi da solo: il piano dell'amicizia fra installazioni, la ricerca sulla
 * generative UI, la documentazione della procedura di firma del binario macOS,
 * la proposta openspec del browser inline. Sono esattamente le card su cui un
 * umano deve decidere. Un piano non è invisibile: è invisibile il suo EFFETTO,
 * non la sua importanza.
 *
 * E il numero onesto che ne esce: la scorciatoia vale **2 card su ~30**, non 10.
 * Il grosso della coda è roba visiva e resta a un umano. L'etichetta serve
 * comunque — 2 card al giorno diventano tante in un mese, e soprattutto il
 * FILTRO «solo le visibili in review» è la lista che gli serve davvero.
 *
 * L'altra famiglia (`bugfix` `feature` `chore` `misura`) non decide niente:
 * serve a filtrare e a leggere la board, quindi la scrive chi vuole. Aree e
 * componenti NON stanno qui apposta: un'etichetta che nessuno filtra è rumore.
 */

/**
 * CHI CHIUDE la card. Le deriva il server dal diff (`deriveCloser`), non le
 * dichiara chi lavora — `invisibile` scritta da un agente sarebbe la sua firma
 * sul proprio permesso di chiudersi le card (`isAgentWritableLabel`).
 */
export const CLOSER_LABELS = ['visibile', 'decisione', 'invisibile'] as const;

/** Che genere di lavoro è. Servono a filtrare, non a decidere. */
export const KIND_LABELS = ['bugfix', 'feature', 'chore', 'misura'] as const;

/** L'insieme CHIUSO. Un'etichetta fuori da qui non si scrive (il layer route la rifiuta). */
export const TASK_LABELS = [...CLOSER_LABELS, ...KIND_LABELS] as const;

export type CloserLabel = (typeof CLOSER_LABELS)[number];
export type KindLabel = (typeof KIND_LABELS)[number];
export type TaskLabel = (typeof TASK_LABELS)[number];

const LABEL_SET: ReadonlySet<string> = new Set<string>(TASK_LABELS);
const CLOSER_SET: ReadonlySet<string> = new Set<string>(CLOSER_LABELS);
const KIND_SET: ReadonlySet<string> = new Set<string>(KIND_LABELS);

export function isTaskLabel(value: unknown): value is TaskLabel {
  return typeof value === 'string' && LABEL_SET.has(value);
}

export function isCloserLabel(value: unknown): value is CloserLabel {
  return typeof value === 'string' && CLOSER_SET.has(value);
}

export function isKindLabel(value: unknown): value is KindLabel {
  return typeof value === 'string' && KIND_SET.has(value);
}

/**
 * Chi ha messo l'etichetta, e quindi chi può toglierla.
 *
 *  · `derived` — l'ha calcolata la macchina dal diff alla consegna. Un giro
 *    successivo la può riscrivere: è una misura, non un'opinione.
 *  · `human`   — l'ha corretta una persona. La derivazione NON la tocca più, o la
 *    correzione a mano durerebbe fino alla prossima consegna.
 *  · `agent`   — l'ha chiesta l'agente. Vale solo per ciò che un agente può
 *    scrivere (vedi `isAgentWritableLabel`): alzare la mano, mai abbassarla.
 */
export const LABEL_SOURCES = ['derived', 'human', 'agent'] as const;
export type LabelSource = (typeof LABEL_SOURCES)[number];

export interface TaskLabelRow {
  label: TaskLabel;
  source: LabelSource;
}

/**
 * Un file toccato dai commit PROPRI del task, con la sola cosa che il path da
 * solo non dice: se è NATO in quei commit.
 *
 * Serve a `deriveKind` e a nient'altro. `deriveCloser` guarda dove sta il file,
 * non da quanto tempo esiste: una superficie che si vede si guarda comunque,
 * nuova o vecchia.
 */
export interface TaskFile {
  path: string;
  /** `true` se un commit proprio del task lo ha aggiunto (`A` in `--name-status`). */
  added: boolean;
}

/**
 * Che cosa può scriversi da solo un agente: tutto tranne `invisibile`.
 *
 * Le etichette di genere sì, nessuna cambia chi chiude la card. `visibile` e
 * `decisione` pure: sono due modi di ALZARE LA MANO («guardala tu», «decidi
 * tu»), e passare il lavoro a un umano è sempre permesso. `invisibile` no: è
 * l'unica che toglie la revisione umana, e non è una cosa che si concede a chi
 * ha scritto il codice. Quella la scrive solo la derivazione, o una persona a mano.
 */
export function isAgentWritableLabel(label: string): boolean {
  return isTaskLabel(label) && label !== 'invisibile';
}

/**
 * Un file che un umano può VEDERE aprendo l'app: sorgente del client, escluso
 * ciò che gira solo nei test.
 *
 * `client/src/**` e non `client/**`: la config di Vite, `index.html` e i lock
 * non hanno una superficie — cambiarli non dà a nessuno niente da guardare.
 * I `*.test.*` / `*.spec.*` sotto `client/src` sono codice di prova: vivono
 * accanto al componente, ma nessuno li vede girare.
 */
export function isUserVisibleFile(path: string): boolean {
  const p = path.replace(/^\.\//, '');
  if (!p.startsWith('client/src/')) return false;
  return !/\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
}

/**
 * Un file che è un DOCUMENTO: un `.md` ovunque, o qualunque cosa sotto
 * `openspec/` e `docs/`.
 *
 * `openspec/**` per intero e non i soli `.md`: una proposta porta con sé i suoi
 * allegati (il `mockup.html` della proposta del browser inline), e un allegato
 * non trasforma un piano in codice.
 */
export function isDocumentFile(path: string): boolean {
  const p = path.replace(/^\.\//, '');
  return p.endsWith('.md') || p.startsWith('openspec/') || p.startsWith('docs/');
}

/**
 * La regola, ed è misurabile. Dai file dei commit PROPRI del task a CHI LO CHIUDE:
 *
 *  1. tocca `client/src/**` fuori dai test  ⇒ `visibile`   — la guarda un umano;
 *  2. nessun file, o SOLO documenti          ⇒ `decisione`  — la decide un umano;
 *  3. tutto il resto (server, shared, script, test) ⇒ `invisibile` — la chiude
 *     il conduttore, se la barra è verde per intero.
 *
 * L'ORDINE è la regola: basta UN file di `client/src` perché la card sia
 * visibile, anche se il diff è per il 90% server. Una superficie che si vede è
 * una superficie che si guarda, e il peso non c'entra.
 *
 * `decisione` è la classe che la prima versione non aveva, ed è quella che
 * conta: una card senza codice — un piano, una ricerca, un acquisto — non è
 * invisibile, è la più umana di tutte. Trattarla come invisibile per assenza di
 * file toccati sarebbe il modo più veloce per far chiudere alla macchina proprio
 * le card che solo un umano può giudicare. L'assenza di diff non è una prova di
 * irrilevanza: è assenza di prova.
 *
 * `files` sono i file dei commit PROPRI del task (`server/services/own-commits.ts`),
 * non tutto ciò che sta fra `main` e la punta del ramo: un ramo nato dall'HEAD di
 * un checkout condiviso eredita il lavoro di chi ci stava sopra, e su quei file
 * ereditati la regola risponderebbe alla domanda sbagliata.
 */
export function deriveCloser(files: readonly string[]): CloserLabel {
  if (files.some(isUserVisibleFile)) return 'visibile';
  if (!files.length || files.every(isDocumentFile)) return 'decisione';
  return 'invisibile';
}

/**
 * Un file di PROVA: `*.test.*` / `*.spec.*` ovunque, o qualunque cosa sotto
 * `tests/`. Le fixture (`tests/fixtures/*.json`) sono prova quanto lo spec che
 * le legge: da sole non cambiano niente di ciò che gira.
 */
export function isTestFile(path: string): boolean {
  const p = path.replace(/^\.\//, '');
  return p.startsWith('tests/') || /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
}

/**
 * Un file di IMPALCATURA: come si compila, come si installa, come si rilascia.
 * Elencati per nome e non per cartella, perché stanno sparsi — `package.json` e
 * `bun.lock` alla radice, `Cargo.toml` sotto quattro crate diverse, i workflow
 * dentro `.github/`.
 *
 * `\.config\.` e non `config`: `client/src/lib/config.ts` è codice di prodotto,
 * `client/vite.config.ts` no. Il punto prima di `config` è tutta la differenza.
 */
export function isBuildFile(path: string): boolean {
  const p = path.replace(/^\.\//, '');
  if (p.startsWith('.github/')) return true;
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (/^tsconfig(\..+)?\.json$/.test(base)) return true;
  if (/\.config\.[cm]?[jt]s$/.test(base)) return true;
  if (/^(package(-lock)?\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml)$/.test(base)) return true;
  if (/^(Cargo\.(toml|lock)|bunfig\.toml|knip\.jsonc|Dockerfile|tauri\.conf\.json)$/.test(base)) return true;
  return /^\.(gitignore|gitattributes|env\.example)$/.test(base);
}

/**
 * CHE GENERE di lavoro è la card, dai file dei suoi commit propri. Serve al
 * filtro della board, non decide niente: `whoCloses` non lo guarda.
 *
 * Esiste perché il 12/08/2026 `KIND_LABELS` era nel vocabolario e il filtro era
 * disegnato sulla board, ma `task_labels` aveva 50 righe e ZERO di genere. Il
 * filtro girava a vuoto: la funzione c'era, il dato non lo scriveva nessuno.
 * Chiederlo all'agente sarebbe stata la stessa scommessa che aveva già perso —
 * quindi si deriva, come `visibile`.
 *
 * L'ordine è la regola, e ruota attorno a una distinzione sola: quali file sono
 * il LAVORO e quali lo accompagnano.
 *
 *  1. niente file di prodotto, ma dei test  ⇒ `misura` — una card che tocca solo
 *     i test ha misurato qualcosa, non l'ha cambiato;
 *  2. niente file di prodotto, ma impalcatura ⇒ `chore`;
 *  3. fra i file di prodotto ce n'è uno NUOVO ⇒ `feature` — e ne basta uno;
 *  4. solo modifiche a codice che esisteva già ⇒ `bugfix`.
 *
 * Test e config non spostano il genere quando c'è del prodotto sotto: un fix di
 * server che si porta dietro il suo test e un bump di lockfile resta un fix,
 * altrimenti ogni card sarebbe `chore` per via di `bun.lock`.
 *
 * `null` per ciò che il vocabolario non sa nominare: nessun file, o soli
 * documenti. Quelle sono le card `decisione` — un piano, una ricerca — e
 * `chore` sarebbe una bugia che poi il filtro propaga. Un'etichetta assente si
 * legge come «non lo so»; un'etichetta sbagliata no.
 *
 * ONESTÀ SUL LIMITE: la coppia `feature`/`bugfix` guarda se un file è nato in
 * questi commit, il che è una misura, non una diagnosi. Una funzionalità scritta
 * per intero dentro file che esistevano già esce `bugfix`. Per questo il genere
 * si scrive `derived` e non `human`: è un default che si filtra, e la correzione
 * a mano vince e non viene più sovrascritta.
 */
export function deriveKind(files: readonly TaskFile[]): KindLabel | null {
  if (!files.length) return null;
  const product = files.filter(
    (f) => !isTestFile(f.path) && !isBuildFile(f.path) && !isDocumentFile(f.path),
  );
  if (!product.length) {
    if (files.some((f) => isTestFile(f.path))) return 'misura';
    if (files.some((f) => isBuildFile(f.path))) return 'chore';
    return null; // soli documenti: la card è una `decisione`, e non ha un genere
  }
  return product.some((f) => f.added) ? 'feature' : 'bugfix';
}

/**
 * Chi chiude la card, in una funzione — la conseguenza operativa che le
 * etichette esistono per produrre (`docs/board-protocol.md` §8).
 *
 * `conductor` SOLO quando entrambe le cose sono vere: l'etichetta dice
 * `invisibile` E la barra è verde per intero. `checksState` diverso da `'pass'`
 * — compreso `null`, cioè «i comandi non sono mai girati» — non è un verde e non
 * autorizza nessuno. `visibile` e `decisione` restano all'umano comunque: è il
 * default di questa funzione, ed è il default sicuro.
 */
export function whoCloses(
  labels: readonly string[],
  checksState: 'running' | 'pass' | 'fail' | null,
): 'human' | 'conductor' {
  return labels.includes('invisibile') && checksState === 'pass' ? 'conductor' : 'human';
}

/**
 * Normalizza una lista di etichette scritte da fuori: scarta ciò che non è nel
 * vocabolario, deduplica, e tiene UNA sola etichetta di chiusura (l'ultima
 * vince) — `visibile` e `invisibile` insieme non sono una card, sono una
 * domanda senza risposta.
 */
export function normalizeLabels(raw: readonly unknown[]): TaskLabel[] {
  const out: TaskLabel[] = [];
  for (const item of raw) {
    if (!isTaskLabel(item)) continue;
    if (isCloserLabel(item)) {
      for (let i = out.length - 1; i >= 0; i--) {
        if (isCloserLabel(out[i]!)) out.splice(i, 1);
      }
    } else if (out.includes(item)) continue;
    out.push(item);
  }
  return out;
}
