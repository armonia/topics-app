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

export interface GrantRow {
  subjectType: SubjectKind;
  subjectId: string;
  level: GrantLevel;
  viaType: string | null;
  viaId: string | null;
  grantedAt: number;
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
    `SELECT subject_type, subject_id, level, via_type, via_id, granted_at
       FROM grants
      WHERE resource_type = ? AND resource_id = ? AND (${rami.join(" OR ")})
      ORDER BY (level = 'deny') DESC, granted_at ASC`,
  ).all(...args) as Array<Record<string, unknown>>;

  return righe.map((r) => ({
    subjectType: String(r.subject_type) as SubjectKind,
    subjectId: String(r.subject_id),
    level: r.level === "deny" ? "deny" : "read",
    viaType: r.via_type === null || r.via_type === undefined ? null : String(r.via_type),
    viaId: r.via_id === null || r.via_id === undefined ? null : String(r.via_id),
    grantedAt: Number(r.granted_at ?? 0),
  }));
}

/** Questi principali possono LEGGERE questa risorsa? Una riga `deny` vince. */
export function hasGrant(
  db: Db,
  principals: readonly Principal[],
  resourceType: ResourceType,
  resourceId: string,
): boolean {
  const righe = grantRowsFor(db, principals, resourceType, resourceId);
  if (righe.length === 0) return false;
  return righe[0].level !== "deny";
}

/**
 * TUTTE le ragioni per cui questi principali vedono la risorsa, non solo la
 * prima. Serve a rispondere «perché costui la vede?» — la domanda per cui
 * `via_type`/`via_id` esistono — e un elenco che si ferma alla prima risposta
 * non la risponde: toglierne una lascerebbe l'accesso in piedi per un'altra,
 * senza che niente lo dica.
 */
export function reasonsFor(
  db: Db,
  principals: readonly Principal[],
  resourceType: ResourceType,
  resourceId: string,
): GrantRow[] {
  return grantRowsFor(db, principals, resourceType, resourceId).filter((r) => r.level !== "deny");
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
    `SELECT subject_type, subject_id, level, via_type, via_id, granted_at
       FROM grants WHERE resource_type = ? AND resource_id = ?
      ORDER BY granted_at ASC`,
  ).all(resourceType, resourceId) as Array<Record<string, unknown>>;

  return righe.map((r) => ({
    subjectType: String(r.subject_type) as SubjectKind,
    subjectId: String(r.subject_id),
    level: r.level === "deny" ? "deny" : "read",
    viaType: r.via_type === null || r.via_type === undefined ? null : String(r.via_type),
    viaId: r.via_id === null || r.via_id === undefined ? null : String(r.via_id),
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
  opts: { level?: GrantLevel; viaType?: string | null; viaId?: string | null; grantedAt: number },
): void {
  db.query(
    `INSERT OR IGNORE INTO grants
       (id, subject_type, subject_id, resource_type, resource_id, level, via_type, via_id, granted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(), subject.kind, subject.id, resourceType, resourceId,
    opts.level ?? "read", opts.viaType ?? null, opts.viaId ?? null, opts.grantedAt,
  );
}

/** Toglie una concessione esplicita. Non tocca quelle derivate da un
 *  contenitore: togliere a mano ciò che un contenitore ha dato lascerebbe il
 *  contenitore a riscriverlo. */
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
