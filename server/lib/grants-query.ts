/**
 * L'UNICA porta da cui si interroga `grants`.
 *
 * Perché una porta sola, ed è un requisito e non una convenzione (ORG-03): il
 * guasto che previene è silenzioso *nella direzione sicura*. Le otto stringhe
 * SQL sparse che questo modulo sostituisce avevano tutte `subject_type='device'`
 * scritto a mano; il giorno in cui il soggetto diventa una persona, quelle
 * rimaste indietro non sbagliano rumorosamente — leggono di MENO. Nessuno vede
 * un errore: si vede una cosa condivisa che non compare, e la si cerca altrove.
 *
 * Il soggetto è già plurale QUI, anche se oggi chi chiama passa sempre un solo
 * principale di tipo `device`. È deliberato: il passaggio a persone e
 * organizzazioni deve poter cambiare *chi* si passa senza toccare *dove* si
 * chiede. Con la forma singolare, ogni chiamante sarebbe un punto da riscrivere
 * — cioè uno da dimenticare.
 */
import type { Database } from "bun:sqlite";
import type { ResourceType } from "./grants";

/** Chi riceve. `device` oggi; `person` e `org` con la 084. */
export type SubjectKind = "device" | "person" | "org";

/** Un principale: un soggetto concreto contro cui confrontare le concessioni. */
export interface Principal {
  kind: SubjectKind;
  id: string;
}

/** Cosa consente una riga. `deny` esiste nello schema e qui, non ancora
 *  nell'interfaccia — allargare un CHECK in SQLite vuol dire ricreare la
 *  tabella, quindi il vocabolario si mette adesso o si paga due volte. */
export type GrantLevel = "read" | "deny";

/**
 * Una riga di concessione, come è scritta.
 *
 * NON c'è la PROVENIENZA, e l'assenza è deliberata. Le colonne `via_type` /
 * `via_id` restano dichiarate dalla 083: descrivono una riga DERIVATA da un
 * contenitore («condividi un progetto, e i suoi task nascono con
 * `via=('project', X)`»). Quel contenitore non esiste — `ResourceType` è
 * `task | topic`, non c'è un progetto da condividere — e sull'asse SOGGETTO la
 * 084 ha scelto la strada opposta: niente righe derivate, l'appartenenza a una
 * persona o a un'organizzazione si espande in LETTURA (`resolvePrincipals`).
 * Quindi nessuno le scriveva, e leggerle produceva sempre `null`: il pannello
 * di condivisione aveva un ramo «via …» che non poteva accendersi mai — una
 * riga di interfaccia che promette una risposta che il dato non ha.
 *
 * Le colonne non si droppano: sono schema già applicato, e una migration sul
 * DB vivo per togliere due colonne inerti costa un rischio senza comprare
 * niente. Il giorno che un contenitore condivisibile esisterà davvero, si
 * rimettono qui — insieme al suo scrittore, non prima.
 */
export interface GrantRow {
  subjectType: SubjectKind;
  subjectId: string;
  level: GrantLevel;
  grantedAt: number;
  /** DA DOVE arriva questo accesso, quando non è scritto sulla risorsa stessa.
   *  Oggi solo `project`: un task condiviso attraverso il suo progetto. Assente
   *  = la riga è sulla risorsa, ed è il caso normale.
   *
   *  Si CALCOLA in lettura, non si memorizza: le colonne `via_type`/`via_id`
   *  della 083 restano inerti perché con l'espansione in lettura non esiste
   *  nessuna riga derivata da etichettare (vedi 20260816230500). */
  viaType?: ResourceType;
  viaId?: string;
}

/** Forma minima del database che serve a questo modulo — così i test possono
 *  passare uno SQLite in memoria senza costruire l'AppContext intero. */
type Db = Pick<Database, "query">;

/**
 * Le righe che riguardano QUESTI principali su QUESTA risorsa, la più forte per
 * prima.
 *
 * `deny` prevale su `read` e lo fa nell'ORDER BY, non in un `if` del chiamante:
 * una precedenza che vive nei chiamanti è una precedenza che il secondo
 * chiamante implementa al contrario.
 *
 * La query è un OR di uguaglianze per TIPO, con l'`IN` limitato agli id dello
 * stesso tipo. Non è un dettaglio di stile: `(subject_type, subject_id) IN (…)`
 * su tuple impedisce a SQLite di usare `idx_grants_resource`, e a quel punto la
 * domanda «può leggere?» diventa una scansione — dentro il ciclo dei broadcast,
 * per ogni socket e per ogni frame.
 */
export function grantRowsFor(
  db: Db,
  principals: readonly Principal[],
  resourceType: ResourceType,
  resourceId: string,
): GrantRow[] {
  if (principals.length === 0) return [];

  const perTipo = new Map<SubjectKind, string[]>();
  for (const p of principals) {
    if (!p?.id) continue;
    const lista = perTipo.get(p.kind) ?? [];
    lista.push(p.id);
    perTipo.set(p.kind, lista);
  }
  if (perTipo.size === 0) return [];

  const rami: string[] = [];
  const args: (string | number)[] = [resourceType, resourceId];
  for (const [kind, ids] of perTipo) {
    rami.push(`(subject_type = ? AND subject_id IN (${ids.map(() => "?").join(",")}))`);
    args.push(kind, ...ids);
  }

  const righe = db.query(
    `SELECT subject_type, subject_id, level, granted_at
       FROM grants
      WHERE resource_type = ? AND resource_id = ? AND (${rami.join(" OR ")})
      ORDER BY (level = 'deny') DESC, granted_at ASC`,
  ).all(...args) as Array<Record<string, unknown>>;

  return righe.map((r) => ({
    subjectType: String(r.subject_type) as SubjectKind,
    subjectId: String(r.subject_id),
    level: r.level === "deny" ? "deny" : "read",
    grantedAt: Number(r.granted_at ?? 0),
  }));
}

/**
 * IL CONTENITORE DI UNA RISORSA, quando ne ha uno.
 *
 * Oggi e' uno solo: un task appartiene a un progetto. Condividere il progetto
 * apre i suoi task senza scrivere una riga per ciascuno - la strada scelta
 * dalla migration 20260816230500, che spiega perche' NON sono righe derivate.
 *
 * Torna `null` quando non c'e' contenitore o quando lo schema e' piu' vecchio:
 * in entrambi i casi la domanda torna a essere quella di prima, invece di
 * cadere.
 */
function containerOf(
  db: Db,
  resourceType: ResourceType,
  resourceId: string,
): { tipo: ResourceType; id: string } | null {
  if (resourceType !== "task") return null;
  try {
    const r = db.query("SELECT project_id FROM tasks WHERE id = ?").get(resourceId) as
      | { project_id?: string | null }
      | undefined;
    const pid = r?.project_id;
    return pid ? { tipo: "project", id: pid } : null;
  } catch {
    return null;
  }
}

/**
 * Questi principali possono LEGGERE questa risorsa? Una riga `deny` vince.
 *
 * IL DENY DELLA RISORSA VINCE ANCHE SUL CONTENITORE, ed e' l'unica gerarchia
 * che conta: «questo progetto e' condiviso, TRANNE questo task» dev'essere
 * dicibile, o la condivisione di un progetto diventa una porta che non si puo'
 * piu' chiudere su un singolo pezzo. Per questo il contenitore si guarda solo
 * quando la risorsa non ha detto NIENTE - non quando ha detto no.
 */
export function hasGrant(
  db: Db,
  principals: readonly Principal[],
  resourceType: ResourceType,
  resourceId: string,
): boolean {
  const righe = grantRowsFor(db, principals, resourceType, resourceId);
  if (righe.length > 0) return righe[0].level !== "deny";

  const dentro = containerOf(db, resourceType, resourceId);
  if (!dentro) return false;
  const onContainer = grantRowsFor(db, principals, dentro.tipo, dentro.id);
  if (onContainer.length === 0) return false;
  return onContainer[0].level !== "deny";
}

/**
 * TUTTE le ragioni per cui questi principali vedono la risorsa, non solo la
 * prima. La ragione è il SOGGETTO su cui la riga è stata scritta — questo
 * dispositivo, la sua persona, una sua organizzazione — e un elenco che si
 * ferma alla prima non risponde alla domanda: toglierne una lascerebbe
 * l'accesso in piedi per un'altra, senza che niente lo dica.
 */
export function reasonsFor(
  db: Db,
  principals: readonly Principal[],
  resourceType: ResourceType,
  resourceId: string,
): GrantRow[] {
  const dirette = grantRowsFor(db, principals, resourceType, resourceId);
  if (dirette.length > 0) return dirette.filter((r) => r.level !== "deny");

  // Nessuna riga sulla risorsa: la ragione puo' essere il contenitore, e va
  // detta - un elenco di ragioni che non nomina il progetto lascerebbe chi
  // guarda a togliere un accesso che non e' li'.
  const dentro = containerOf(db, resourceType, resourceId);
  if (!dentro) return [];
  return grantRowsFor(db, principals, dentro.tipo, dentro.id)
    .filter((r) => r.level !== "deny")
    .map((r) => ({ ...r, viaType: dentro.tipo, viaId: dentro.id }));
}

/**
 * Cosa vedono questi principali, di un certo tipo di risorsa.
 *
 * Le righe `deny` sono sottratte qui e non ignorate: un elenco che le
 * dimenticasse mostrerebbe cose che poi il controllo puntuale nega, cioè la
 * forma peggiore — visibile e non apribile.
 */
export function grantedResourceIds(
  db: Db,
  principals: readonly Principal[],
  resourceType: ResourceType,
): string[] {
  if (principals.length === 0) return [];

  const perTipo = new Map<SubjectKind, string[]>();
  for (const p of principals) {
    if (!p?.id) continue;
    const lista = perTipo.get(p.kind) ?? [];
    lista.push(p.id);
    perTipo.set(p.kind, lista);
  }
  if (perTipo.size === 0) return [];

  const rami: string[] = [];
  const args: (string | number)[] = [resourceType];
  for (const [kind, ids] of perTipo) {
    rami.push(`(subject_type = ? AND subject_id IN (${ids.map(() => "?").join(",")}))`);
    args.push(kind, ...ids);
  }

  const righe = db.query(
    `SELECT resource_id, level FROM grants
      WHERE resource_type = ? AND (${rami.join(" OR ")})`,
  ).all(...args) as Array<{ resource_id: string; level: string }>;

  const negati = new Set(righe.filter((r) => r.level === "deny").map((r) => r.resource_id));
  const fuori = new Set<string>();
  for (const r of righe) {
    if (r.level !== "deny" && !negati.has(r.resource_id)) fuori.add(r.resource_id);
  }
  return [...fuori];
}

/** Tutto ciò che questi principali vedono, per tipo di risorsa. */
export function grantedByType(
  db: Db,
  principals: readonly Principal[],
): { task: string[]; topic: string[] } {
  return {
    task: grantedResourceIds(db, principals, "task"),
    topic: grantedResourceIds(db, principals, "topic"),
  };
}

/** Chi è stato messo su questa risorsa, così com'è stato scritto. L'espansione
 *  in persone e dispositivi arriva con la 084; qui c'è il dato, non la sua
 *  risalita. */
export function subjectsOf(
  db: Db,
  resourceType: ResourceType,
  resourceId: string,
): GrantRow[] {
  const righe = db.query(
    `SELECT subject_type, subject_id, level, granted_at
       FROM grants WHERE resource_type = ? AND resource_id = ?
      ORDER BY granted_at ASC`,
  ).all(resourceType, resourceId) as Array<Record<string, unknown>>;

  return righe.map((r) => ({
    subjectType: String(r.subject_type) as SubjectKind,
    subjectId: String(r.subject_id),
    level: r.level === "deny" ? "deny" : "read",
    grantedAt: Number(r.granted_at ?? 0),
  }));
}

/**
 * Questi principali hanno una concessione sul task di cui QUESTO file è
 * l'anteprima?
 *
 * Il confronto è un `LIKE` sul suffisso del percorso, e i metacaratteri vanno
 * neutralizzati: un `%` in un nome di file trasformerebbe il confronto in «una
 * qualunque anteprima», cioè in un passe-partout. `ESCAPE` va dichiarato, o il
 * backslash non è un escape ma un carattere.
 */
export function holdsGrantOnTaskPreview(
  db: Db,
  principals: readonly Principal[],
  suffissoPercorso: string,
): boolean {
  if (principals.length === 0 || !suffissoPercorso) return false;

  const perTipo = new Map<SubjectKind, string[]>();
  for (const p of principals) {
    if (!p?.id) continue;
    const lista = perTipo.get(p.kind) ?? [];
    lista.push(p.id);
    perTipo.set(p.kind, lista);
  }
  if (perTipo.size === 0) return false;

  const rami: string[] = [];
  const args: (string | number)[] = [];
  for (const [kind, ids] of perTipo) {
    rami.push(`(g.subject_type = ? AND g.subject_id IN (${ids.map(() => "?").join(",")}))`);
    args.push(kind, ...ids);
  }
  args.push(`%${escapeLike(suffissoPercorso)}`);

  return !!db.query(
    `SELECT 1 FROM grants g JOIN tasks t ON t.id = g.resource_id
      WHERE (${rami.join(" OR ")})
        AND g.resource_type = 'task' AND g.level != 'deny'
        AND t.preview_image LIKE ? ESCAPE '\\'`,
  ).get(...args);
}

/** `%`, `_` e `\` perdono il loro potere. Senza, un nome di file che ne contiene
 *  uno allarga il confronto invece di restringerlo. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Scrive una concessione. Idempotente: la UNIQUE dello schema è la verità, qui
 *  si evita solo di far fallire un secondo clic. */
export function putGrant(
  db: Db,
  subject: Principal,
  resourceType: ResourceType,
  resourceId: string,
  opts: { level?: GrantLevel; grantedAt: number },
): void {
  db.query(
    `INSERT OR IGNORE INTO grants
       (id, subject_type, subject_id, resource_type, resource_id, level, granted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(), subject.kind, subject.id, resourceType, resourceId,
    opts.level ?? "read", opts.grantedAt,
  );
}

/** Toglie una concessione. Ogni riga di `grants` è esplicita — non esiste una
 *  riga derivata da un contenitore (vedi `GrantRow`) — quindi qui non c'è
 *  niente da distinguere: si toglie ciò che qualcuno ha dato. */
export function dropGrant(
  db: Db,
  subject: Principal,
  resourceType: ResourceType,
  resourceId: string,
): void {
  db.query(
    "DELETE FROM grants WHERE subject_type = ? AND subject_id = ? AND resource_type = ? AND resource_id = ?",
  ).run(subject.kind, subject.id, resourceType, resourceId);
}

/**
 * Il SOLO principale-ferro di un dispositivo — scorciatoia per non scrivere
 * `{kind:'device', id}` a mano.
 *
 * NON è la risposta a «cosa può vedere questo dispositivo?»: quella è
 * `resolvePrincipals(db, deviceId).list`, che aggiunge la persona e le sue
 * organizzazioni vive. Usare questo al suo posto produce un sottoinsieme
 * silenzioso — è già successo, in `/api/auth/shared` e nell'elenco delle schede
 * di un ospite: il cancello concedeva una risorsa condivisa con la PERSONA e i
 * due elenchi non la mostravano, cioè «te l'ho condivisa» / «io non vedo
 * niente». Da qui in poi resta un aiuto per i test, dove il soggetto è scelto a
 * mano ed è esattamente il dispositivo.
 */
export function deviceP(deviceId: string): Principal[] {
  return [{ kind: "device", id: deviceId }];
}
