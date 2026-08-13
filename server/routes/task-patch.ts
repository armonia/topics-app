/**
 * server/routes/task-patch.ts — la lettura del body di `PATCH .../tasks/:id`.
 *
 * LA REGOLA: un campo che la rotta non sa applicare non si ignora. O si
 * applica, o si risponde 400 dicendo quale campo e perché. Il silenzio è la
 * peggiore delle tre, perché è indistinguibile dal successo: chi chiama crede
 * di aver fatto, e non ha modo di accorgersene se non rileggendo la riga.
 *
 * Misurato il 12/08/2026, archiviando una card a mano:
 *   PATCH /api/boards/:p/tasks/:id {"archived":true}  →  200 OK
 *   SELECT archived FROM tasks WHERE id = ...         →  0
 * Stesso guasto già visto su `previewImage` (accettato, scartato dal filtro,
 * card senza anteprima con un 200 in mano). L'archiviazione vera resta il
 * `DELETE` sulla stessa risorsa: qui si chiude il buco, non si sposta il gesto.
 *
 * Ogni chiave che le due rotte sanno applicare sta nelle tabelle qui sotto.
 * Una chiave fuori tabella, o dentro ma col tipo sbagliato, è un 400 che la
 * nomina. Il rifiuto è TOTALE: mezza patch applicata sarebbe di nuovo un esito
 * che nessuno ha chiesto.
 */
import { TASK_STATUSES } from "../../shared/board";
import type { UpdateTaskPatch } from "../services/tasks";

/**
 * I DOMINI CHIUSI, detti a parole, in un posto solo.
 *
 * Misurato il 13/08/2026: `PATCH {"priority": 9}` rispondeva
 *   500 {"error":"CHECK constraint failed: priority BETWEEN 0 AND 4"}
 * Due guasti in una riga. Il codice: un valore fuori dominio è colpa di chi
 * chiama, quindi 400 — un 500 dice «il server è rotto» e manda a cercare nel
 * posto sbagliato. E il messaggio: era il testo grezzo di SQLite che affiorava
 * fino al client, leggibile solo da chi sa che esiste un CHECK.
 *
 * Queste righe le leggono in DUE: il lettore alla porta, che ferma il valore
 * prima del DB, e `checkConstraintBody`, che traduce una violazione arrivata
 * comunque al DB (una scrittura da un'altra porta). Una regola sola, due usi:
 * se il dominio cambia, cambia qui e le due risposte restano d'accordo.
 */
const PRIORITY_MIN = 0;
const PRIORITY_MAX = 4;
const PRIORITY_RULE = `priority ammette un intero da ${PRIORITY_MIN} a ${PRIORITY_MAX}`;
const STATUS_RULE = `status ammette uno di: ${TASK_STATUSES.join(", ")}`;

/** Il valore da scrivere, o il motivo per cui questo campo non si sa applicare. */
export type FieldRead = { ok: true; value: unknown } | { ok: false; reason: string };

const ok = (value: unknown): FieldRead => ({ ok: true, value });
const no = (reason: string): FieldRead => ({ ok: false, reason });

/** Il tipo come lo direbbe un umano, per scriverlo nel messaggio di rifiuto. */
function kindOf(raw: unknown): string {
  if (raw === null) return "null";
  if (Array.isArray(raw)) return "array";
  return typeof raw;
}

const asString = (raw: unknown): FieldRead =>
  typeof raw === "string" ? ok(raw) : no(`atteso string, ricevuto ${kindOf(raw)}`);

/** Titolo: una stringa che non sia bianca. Un titolo vuoto cancellerebbe la card. */
const asTitle = (raw: unknown): FieldRead =>
  typeof raw !== "string" ? no(`atteso string, ricevuto ${kindOf(raw)}`)
    : raw.trim() ? ok(raw) : no("il titolo non può essere vuoto");

const asStringOrNull = (raw: unknown): FieldRead =>
  raw === null || typeof raw === "string" ? ok(raw) : no(`atteso string o null, ricevuto ${kindOf(raw)}`);

/** Riferimento a un altro task: id non vuoto, oppure `null`/`""` per staccarlo. */
const asRefOrNull = (raw: unknown): FieldRead =>
  raw === null ? ok(null)
    : typeof raw === "string" ? ok(raw ? raw : null)
      : no(`atteso id (string) o null, ricevuto ${kindOf(raw)}`);

const asNumber = (raw: unknown): FieldRead =>
  typeof raw === "number" && Number.isFinite(raw) ? ok(raw) : no(`atteso number, ricevuto ${kindOf(raw)}`);

const asBoolean = (raw: unknown): FieldRead =>
  typeof raw === "boolean" ? ok(raw) : no(`atteso boolean, ricevuto ${kindOf(raw)}`);

/** Priorità: intero dentro il dominio. Fuori dominio è un 400 che dice il range. */
const asPriority = (raw: unknown): FieldRead => {
  const read = asNumber(raw);
  if (!read.ok) return read;
  const n = read.value as number;
  if (!Number.isInteger(n)) return no(`${PRIORITY_RULE}, ricevuto ${n}`);
  return n >= PRIORITY_MIN && n <= PRIORITY_MAX ? ok(n) : no(`${PRIORITY_RULE}, ricevuto ${n}`);
};

/** Stato: uno dei cinque della board. */
const asStatus = (raw: unknown): FieldRead => {
  const read = asString(raw);
  if (!read.ok) return read;
  const s = read.value as string;
  return (TASK_STATUSES as readonly string[]).includes(s) ? ok(s) : no(`${STATUS_RULE}, ricevuto "${s}"`);
};

interface FieldSpec {
  /** Dove finisce nel patch del service. */
  to: keyof UpdateTaskPatch;
  read: (raw: unknown) => FieldRead;
}

/**
 * I due nomi di uno stesso campo convivono nei prompt e nei client (il
 * protocollo insegna camelCase, gli schemi MCP usano snake_case). Accettarne
 * uno solo riaprirebbe il buco dal lato del nome, che è esattamente come
 * `previewImage` si era già perso una volta.
 */
const HUMAN_FIELDS: Record<string, FieldSpec> = {
  status: { to: "status", read: asStatus },
  priority: { to: "priority", read: asPriority },
  assignee: { to: "assignedTo", read: asStringOrNull },
  text: { to: "text", read: asTitle },
  description: { to: "description", read: asStringOrNull },
  kanbanOrder: { to: "kanbanOrder", read: asNumber },
  dueDate: { to: "dueDate", read: asStringOrNull },
  outputUrl: { to: "outputUrl", read: asStringOrNull },
  output_url: { to: "outputUrl", read: asStringOrNull },
  model: { to: "model", read: asStringOrNull },
  blockedByTaskId: { to: "blockedByTaskId", read: asRefOrNull },
  reuseBlockerContext: { to: "reuseBlockerContext", read: asBoolean },
  planFirst: { to: "planFirst", read: asBoolean },
  parentTaskId: { to: "parentTaskId", read: asRefOrNull },
  parent_task_id: { to: "parentTaskId", read: asRefOrNull },
};

/**
 * La superficie AGENTE è più stretta di proposito: ordine in colonna, modello,
 * dipendenze, piano e annidamento sono leve dell'umano sulla board. Prima
 * erano scartate in silenzio, che le faceva sembrare disponibili; ora dicono
 * di non esserlo.
 */
const AGENT_FIELDS: Record<string, FieldSpec> = {
  status: { to: "status", read: asStatus },
  priority: { to: "priority", read: asPriority },
  assignee: { to: "assignedTo", read: asStringOrNull },
  text: { to: "text", read: asTitle },
  description: { to: "description", read: asStringOrNull },
  outputUrl: { to: "outputUrl", read: asStringOrNull },
  output_url: { to: "outputUrl", read: asStringOrNull },
};

const PREVIEW_KEYS = ["previewImage", "preview_image"];

export type PatchScope = "human" | "agent";

export interface PatchFieldError { field: string; reason: string }

export type ParsedTaskPatch =
  | { ok: true; patch: UpdateTaskPatch }
  | { ok: false; errors: PatchFieldError[] };

/**
 * Campi che ESISTONO sul task ma che questa rotta non cambia: il rifiuto dice
 * dove si fa davvero quel gesto, invece di un generico "chiave sconosciuta".
 */
const REDIRECTED: Record<string, string> = {
  archived: "la PATCH non archivia. Per archiviare usa DELETE sulla stessa risorsa",
  archivedAt: "la PATCH non archivia. Per archiviare usa DELETE sulla stessa risorsa",
  id: "l'id di un task non si cambia",
  projectId: "il progetto di un task non si cambia da qui",
  project_id: "il progetto di un task non si cambia da qui",
  createdAt: "campo di sola lettura",
  updatedAt: "campo di sola lettura",
  completedAt: "campo di sola lettura",
  dispatchState: "lo stato di dispatch lo scrive il dispatcher",
  deliveryBranch: "il ramo di consegna lo scrive il sistema al passaggio in review",
  landingState: "l'esito del land lo scrive il sistema",
};

/**
 * Legge il body di una PATCH sul task. `readPreview` arriva dalla rotta perché
 * l'anteprima ha due cancelli che vivono lì (allowlist dei path e tipo
 * mostrabile): qui interessa solo che un path rifiutato diventi un errore
 * NOMINATO invece di sparire.
 */
export function parseTaskPatch(
  body: unknown,
  scope: PatchScope,
  readPreview: (raw: unknown) => FieldRead,
): ParsedTaskPatch {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: [{ field: "body", reason: `atteso un oggetto JSON, ricevuto ${kindOf(body)}` }] };
  }
  const known = scope === "human" ? HUMAN_FIELDS : AGENT_FIELDS;
  const errors: PatchFieldError[] = [];
  const patch: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(body as Record<string, unknown>)) {
    if (raw === undefined) continue; // non arriva da JSON, ma un chiamante in-process sì
    if (PREVIEW_KEYS.includes(key)) {
      const read = readPreview(raw);
      if (read.ok) patch.previewImage = read.value;
      else errors.push({ field: key, reason: read.reason });
      continue;
    }
    const spec = known[key];
    if (!spec) {
      const redirect = REDIRECTED[key];
      if (redirect) errors.push({ field: key, reason: redirect });
      else if (HUMAN_FIELDS[key]) errors.push({ field: key, reason: "campo della board, non applicabile da questa rotta" });
      else errors.push({ field: key, reason: "campo sconosciuto" });
      continue;
    }
    const read = spec.read(raw);
    if (read.ok) patch[spec.to] = read.value;
    else errors.push({ field: key, reason: read.reason });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, patch: patch as UpdateTaskPatch };
}

/** Corpo della risposta 400: il messaggio nomina OGNI campo e il suo perché. */
export function unapplicableFieldsBody(errors: PatchFieldError[]): {
  error: string; code: string; fields: string[];
} {
  return {
    error: errors.map((e) => `${e.field}: ${e.reason}`).join("; "),
    code: "unapplicable_field",
    fields: errors.map((e) => e.field),
  };
}

/**
 * La SECONDA rete, per una violazione che il lettore alla porta non ha visto:
 * una scrittura che entra da un'altra rotta, o un dominio che qualcuno stringe
 * nella migration senza toccare questo file.
 *
 * Vale la stessa lettura: il valore lo ha scelto chi chiama, quindi 400. E il
 * testo di SQLite non esce di qui: contiene l'espressione del vincolo, cioè
 * una riga di schema che il client non ha e non può interpretare. Al suo posto
 * va la regola detta a parole.
 */
const CHECK_RULES: { field: string; expr: RegExp; rule: string }[] = [
  { field: "priority", expr: /\bpriority\b/, rule: PRIORITY_RULE },
  { field: "status", expr: /\bstatus\b\s+IN\b[^)]*'todo'/i, rule: STATUS_RULE },
];

/** Il messaggio di SQLite per un CHECK: `CHECK constraint failed: <espressione>`. */
const CHECK_FAILED_RE = /CHECK constraint failed:\s*(.*)/i;

/**
 * Traduce una violazione di CHECK nel corpo di un 400, o `null` se l'errore è
 * un altro (e allora resta un 500: quello sì che è il server rotto).
 */
export function checkConstraintBody(e: unknown): { error: string; code: string; fields: string[] } | null {
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const code = (e as { code?: unknown } | null)?.code;
  const matched = CHECK_FAILED_RE.exec(message);
  if (!matched && code !== "SQLITE_CONSTRAINT_CHECK") return null;
  const expr = matched?.[1] ?? "";
  const known = CHECK_RULES.find((r) => r.expr.test(expr));
  return {
    // Senza una regola nota resta comunque un valore fuori da un insieme
    // chiuso: si dice quello, non l'SQL che lo ha rifiutato.
    error: known ? known.rule : "valore fuori dal dominio ammesso per questo campo",
    code: "invalid_input",
    fields: known ? [known.field] : [],
  };
}
