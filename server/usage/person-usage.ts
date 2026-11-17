/**
 * CHI HA CONSUMATO la quota settimanale: per persona, e per richiesta.
 *
 * Il conto è lo stesso dello strumento a riga di comando da cui nasce (ore di
 * script a mano per dire quanto aveva speso una persona sola):
 *
 *  · ogni chiamata del modello ha un PESO in token: input + 5·output +
 *    1,25·cache scritta + 0,1·cache letta. Nel motore nativo
 *    `usage_prompt_tokens` COMPRENDE la cache letta e scritta, quindi l'input
 *    vero è il resto;
 *  · una chiamata appartiene all'autore dell'ultimo messaggio utente della sua
 *    sessione; un sottoagente eredita l'autore della madre al momento in cui è
 *    nato, risalendo finché serve; i sottoagenti Claude Code si leggono dal loro
 *    transcript; le righe di `usage_records` portano l'autore da sé;
 *  · i PUNTI vengono dallo storico della quota: ogni ora la % settimanale di
 *    tutti gli account sale di N (un calo è un reset: conta il valore nuovo), e
 *    quei punti si dividono fra le chiamate di quell'ora in proporzione al peso.
 *    100 punti = un account settimanale intero.
 *
 * È una stima: la quota si legge a campioni, e le chiamate che Topics non vede
 * restano nel totale senza un autore. Senza lo storico la risposta lo dice e dà
 * solo i token pesati.
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { findClaudeTranscript } from "../lib/claude-transcript-path";

export const HOUR_MS = 3_600_000;
const MAX_DEPTH = 8;

export interface TokenUsage { input: number; output: number; cacheWrite: number; cacheRead: number }

export function weighTokens(u: TokenUsage): number {
  return u.input + 5 * u.output + 1.25 * u.cacheWrite + 0.1 * u.cacheRead;
}

export interface HistoryLine { t: number; s?: Record<string, number> }

/** Punti per ora (chiave = ora intera da epoca): aumenti della % 7d di ogni account Claude. */
export function pointsPerHour(lines: HistoryLine[], sinceMs: number, untilMs: number): Map<number, number> {
  const out = new Map<number, number>();
  const prev = new Map<string, number>();
  for (const l of [...lines].sort((a, b) => a.t - b.t)) {
    for (const [k, v] of Object.entries(l.s ?? {})) {
      if (!k.startsWith("claude|") || !k.endsWith("|7d") || !Number.isFinite(v)) continue;
      const t = l.t * 1000;
      const p = prev.get(k);
      if (p !== undefined && t >= sinceMs && t <= untilMs) {
        const d = v >= p ? v - p : v;
        if (d > 0) {
          const h = Math.floor(t / HOUR_MS);
          out.set(h, (out.get(h) ?? 0) + d);
        }
      }
      prev.set(k, v);
    }
  }
  return out;
}

export interface Call {
  ts: number;
  weight: number;
  personId: string | null;
  /** La sessione radice (la chat che ha generato la chiamata). */
  chatKey: string;
  /** Il messaggio utente che l'ha chiesta, quando si sa. */
  requestId: string | null;
  requestText: string;
  source: "native" | "claude-code" | "record";
  points?: number;
}

/** Divide i punti di ogni ora fra le chiamate di quell'ora, in proporzione al peso. */
export function splitPoints(calls: Call[], points: Map<number, number>): Call[] {
  const w = new Map<number, number>();
  for (const c of calls) { const h = Math.floor(c.ts / HOUR_MS); w.set(h, (w.get(h) ?? 0) + c.weight); }
  for (const c of calls) {
    const h = Math.floor(c.ts / HOUR_MS);
    const tot = w.get(h) ?? 0;
    c.points = tot > 0 ? ((points.get(h) ?? 0) * c.weight) / tot : 0;
  }
  return calls;
}

interface AuthorMark { ts: number; personId: string | null; messageId: string; text: string }

/** Chi parlava in una sessione a un dato istante: ricerca binaria sulla linea dei messaggi utente. */
function lastBefore(line: AuthorMark[], ts: number): AuthorMark | null {
  let lo = 0, hi = line.length - 1, r: AuthorMark | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (line[mid]!.ts <= ts) { r = line[mid]!; lo = mid + 1; } else hi = mid - 1;
  }
  return r;
}

const TAG_RE = /<messaggio da="[^"]*"[^>]*>/g;

/** Il testo della richiesta: dopo l'ultimo `<messaggio da=…>` se c'è, senza spazi doppi. */
export function requestTextOf(content: string): string {
  let last: RegExpExecArray | null = null, m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(content))) last = m;
  const body = last ? content.slice(last.index + last[0].length).split("</messaggio>")[0]! : content;
  // Il preambolo dei canali di gruppo è uguale per tutti: resta la richiesta.
  return body.replace(/^\s*Richiesta del gruppo «[^»]*», fatta da [^,]*, riassunta[^:]*:\s*/, "")
    .replace(/\s+/g, " ").trim().slice(0, 220);
}

export type TranscriptReader = (cwd: string, claudeSessionId: string) => Array<{ ts: number; usage: TokenUsage }>;

/** Le chiamate di un transcript Claude Code: una per `message.id` (le righe per blocco si ripetono). */
export const readTranscriptCalls: TranscriptReader = (cwd, sid) => {
  const file = findClaudeTranscript(cwd, sid);
  if (!file) return [];
  let txt: string;
  try { txt = readFileSync(file, "utf8"); } catch { return []; }
  const seen = new Set<string>();
  const out: Array<{ ts: number; usage: TokenUsage }> = [];
  for (const line of txt.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const u = o?.message?.usage;
    if (o?.type !== "assistant" || !u) continue;
    const id = o.message.id ?? o.uuid;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const ts = Date.parse(o.timestamp);
    if (!Number.isFinite(ts)) continue;
    out.push({ ts, usage: {
      input: u.input_tokens ?? 0, output: u.output_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0,
    } });
  }
  return out;
};

export interface CollectOptions {
  sinceMs: number;
  untilMs: number;
  readTranscript?: TranscriptReader;
}

/** Tutte le chiamate dell'intervallo, ciascuna con il suo autore. */
export function collectCalls(db: Database, o: CollectOptions): Call[] {
  const iso = (ms: number) => new Date(ms).toISOString();
  const readTranscript = o.readTranscript ?? readTranscriptCalls;

  // Linee degli autori per sessione: anche prima della finestra, una sessione lunga lavora per chi ha scritto ieri.
  const lines = new Map<string, AuthorMark[]>();
  // Le righe scritte dalla macchina (risultati dei sottoagenti, fine di un processo, spinta
  // dell'obiettivo) continuano il lavoro di chi l'ha chiesto: non cambiano l'autore.
  const users = db.query(`SELECT id, session_key sk, timestamp ts, author_person_id pid, substr(content, 1, 4000) txt,
      (blocks LIKE '%"kind":"dispatched-envelope"%' AND content NOT LIKE '%<messaggio da=%') machine
    FROM messages WHERE role = 'user' AND timestamp > ? AND timestamp <= ?
      AND (blocks IS NULL OR (blocks NOT LIKE '%"kind":"subagent-result"%' AND blocks NOT LIKE '%"kind":"process-exit"%'
        AND blocks NOT LIKE '%"kind":"goal-nudge"%'))
    ORDER BY timestamp`)
    .all(iso(o.sinceMs - 7 * 24 * HOUR_MS), iso(o.untilMs)) as Array<{ id: string; sk: string; ts: string; pid: string | null; txt: string; machine: number }>;
  for (const u of users) {
    const ts = Date.parse(u.ts);
    if (!Number.isFinite(ts)) continue;
    let l = lines.get(u.sk);
    if (!l) lines.set(u.sk, (l = []));
    // Un avviso della macchina senza mittente (lavoro finito, spinta della board) dentro una
    // conversazione già avviata da qualcuno continua il suo lavoro; in una chat nuova apre la linea.
    if (u.machine && l.length) continue;
    l.push({ ts, personId: u.pid, messageId: u.id, text: requestTextOf(u.txt ?? "") });
  }

  const subs = db.query(`SELECT parent_session_key psk, session_key sk, claude_session_id csid, cwd, runtime, created_at
    FROM subagents`).all() as Array<{ psk: string; sk: string | null; csid: string | null; cwd: string; runtime: string | null; created_at: string }>;
  const parent = new Map<string, { psk: string; ts: number }>();
  for (const s of subs) if (s.sk) parent.set(s.sk, { psk: s.psk, ts: Date.parse(s.created_at) });

  const rootOf = (sk: string) => {
    let k = sk;
    for (let i = 0; i < MAX_DEPTH && parent.has(k); i++) k = parent.get(k)!.psk;
    return k;
  };
  /** L'autore a quell'istante; un sottoagente senza messaggi propri lo eredita dalla madre alla nascita. */
  const authorAt = (sk: string, ts: number): AuthorMark | null => {
    let k: string | undefined = sk, t = ts;
    for (let i = 0; k && i < MAX_DEPTH; i++) {
      const p = parent.get(k);
      // Un sottoagente non ha un autore suo: i suoi prompt li scrive la madre (dal server, quindi
      // col proprietario come autore). Eredita chi parlava nella madre quando è nato.
      if (p) { k = p.psk; t = p.ts; continue; }
      const line = lines.get(k);
      return line ? lastBefore(line, t) : null;
    }
    return null;
  };
  const make = (ts: number, weight: number, sk: string, mark: AuthorMark | null, source: Call["source"], personId?: string | null): Call => ({
    ts, weight, personId: personId !== undefined ? personId : mark?.personId ?? null, chatKey: rootOf(sk),
    requestId: mark?.messageId ?? null, requestText: mark?.text ?? "", source,
  });

  const calls: Call[] = [];
  // Motore nativo: chat e sottoagenti nativi.
  const msgs = db.query(`SELECT m.session_key sk, m.timestamp ts, COALESCE(m.usage_prompt_tokens,0) p, COALESCE(m.usage_completion_tokens,0) o,
      COALESCE(m.cache_read_tokens,0) cr, COALESCE(m.cache_creation_tokens,0) cw
    FROM messages m
    WHERE m.role = 'assistant' AND m.timestamp > ? AND m.timestamp <= ?
      AND (m.usage_prompt_tokens > 0 OR m.usage_completion_tokens > 0)
      AND (EXISTS (SELECT 1 FROM topics t WHERE t.session_key = m.session_key AND t.provider = 'topics')
        OR EXISTS (SELECT 1 FROM subagents s WHERE s.session_key = m.session_key AND s.runtime = 'topics'))`)
    .all(iso(o.sinceMs), iso(o.untilMs)) as Array<{ sk: string; ts: string; p: number; o: number; cr: number; cw: number }>;
  for (const m of msgs) {
    const ts = Date.parse(m.ts);
    const weight = weighTokens({ input: Math.max(0, m.p - m.cr - m.cw), output: m.o, cacheWrite: m.cw, cacheRead: m.cr });
    calls.push(make(ts, weight, m.sk, authorAt(m.sk, ts), "native"));
  }

  // Sottoagenti Claude Code: le chiamate stanno nel loro transcript, l'autore è quello della madre alla nascita.
  for (const s of subs) {
    if (s.runtime === "topics" || !s.csid) continue;
    const born = Date.parse(s.created_at);
    if (!Number.isFinite(born) || born > o.untilMs || born < o.sinceMs - 7 * 24 * HOUR_MS) continue;
    const mark = authorAt(s.psk, born);
    for (const c of readTranscript(s.cwd, s.csid)) {
      if (c.ts <= o.sinceMs || c.ts > o.untilMs) continue;
      calls.push(make(c.ts, weighTokens(c.usage), s.psk, mark, "claude-code"));
    }
  }

  // Righe del registro: chiamate fuori dal motore (canali in sandbox, chiamate di servizio).
  const recs = db.query(`SELECT timestamp ts, session_key sk, author_person_id pid, purpose, COALESCE(input_tokens,0) i, COALESCE(output_tokens,0) o,
      COALESCE(cache_read_tokens,0) cr, COALESCE(cache_creation_tokens,0) cw
    FROM usage_records WHERE timestamp > ? AND timestamp <= ? AND measured = 1`)
    .all(o.sinceMs, o.untilMs) as Array<{ ts: number; sk: string; pid: string | null; purpose: string | null; i: number; o: number; cr: number; cw: number }>;
  for (const r of recs) {
    const weight = weighTokens({ input: r.i, output: r.o, cacheWrite: r.cw, cacheRead: r.cr });
    const mark = r.pid ? null : authorAt(r.sk, r.ts);
    const c = make(r.ts, weight, r.sk, mark, "record", r.pid ?? mark?.personId ?? null);
    if (!c.requestText && r.purpose) c.requestText = r.purpose;
    calls.push(c);
  }
  return calls;
}

export function readHistory(file: string): HistoryLine[] | null {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l) as HistoryLine]; } catch { return []; }
    });
  } catch { return null; }
}

/** La cartella dello storico della quota: `TOPICS_USAGE_HISTORY_DIR`, altrimenti `~/.topics/usage-history`. */
export function usageHistoryFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.TOPICS_USAGE_HISTORY_DIR || join(homedir(), ".topics", "usage-history"), "history.jsonl");
}

export interface PersonRow { personId: string | null; name: string; weighted: number; accountPct: number | null; sharePct: number }

export interface PeopleUsage {
  days: number;
  since: string;
  until: string;
  /** false = storico della quota assente: ci sono solo i token pesati. */
  quotaHistory: boolean;
  /** Punti spesi da tutti gli account nell'intervallo (100 = un account settimanale). */
  totalPoints: number | null;
  /** Punti assegnati a una chiamata vista da Topics (il resto non ha chiamate nell'ora). */
  attributedPoints: number | null;
  people: PersonRow[];
}

export interface Computed { calls: Call[]; meta: Omit<PeopleUsage, "people"> }

export function computeCalls(db: Database, o: { days: number; now?: number; historyFile?: string; readTranscript?: TranscriptReader }): Computed {
  const untilMs = o.now ?? Date.now();
  const sinceMs = untilMs - o.days * 24 * HOUR_MS;
  const calls = collectCalls(db, { sinceMs, untilMs, readTranscript: o.readTranscript });
  const history = readHistory(o.historyFile ?? usageHistoryFile());
  let totalPoints: number | null = null, attributedPoints: number | null = null;
  if (history) {
    const pts = pointsPerHour(history, sinceMs, untilMs);
    splitPoints(calls, pts);
    totalPoints = [...pts.values()].reduce((s, x) => s + x, 0);
    attributedPoints = calls.reduce((s, c) => s + (c.points ?? 0), 0);
  }
  return { calls, meta: { days: o.days, since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString(), quotaHistory: !!history, totalPoints, attributedPoints } };
}

function namesOf(db: Database): Map<string, string> {
  const rows = db.query("SELECT id, display_name FROM people").all() as Array<{ id: string; display_name: string }>;
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

export const NO_AUTHOR = "senza autore";

export function peopleUsage(c: Computed, db: Database): PeopleUsage {
  const names = namesOf(db);
  const g = new Map<string | null, { w: number; p: number }>();
  for (const call of c.calls) {
    const e = g.get(call.personId) ?? { w: 0, p: 0 };
    e.w += call.weight; e.p += call.points ?? 0;
    g.set(call.personId, e);
  }
  const totW = c.calls.reduce((s, x) => s + x.weight, 0);
  const totP = c.meta.attributedPoints ?? 0;
  const people: PersonRow[] = [...g].map(([personId, e]) => ({
    personId,
    name: personId ? names.get(personId) ?? personId : NO_AUTHOR,
    weighted: Math.round(e.w),
    accountPct: c.meta.quotaHistory ? round1(e.p) : null,
    sharePct: round1(c.meta.quotaHistory && totP > 0 ? (100 * e.p) / totP : totW > 0 ? (100 * e.w) / totW : 0),
  })).sort((a, b) => b.sharePct - a.sharePct || b.weighted - a.weighted);
  return { ...c.meta, people };
}

export interface RequestRow { chatKey: string; chatName: string; requestId: string | null; request: string; at: string; calls: number; weighted: number; accountPct: number | null }

/** Il dettaglio di una persona: una riga per richiesta (messaggio che ha avviato il lavoro). */
export function personDetail(c: Computed, db: Database, personId: string | null): Omit<PeopleUsage, "people"> & { personId: string | null; name: string; requests: RequestRow[] } {
  const names = namesOf(db);
  const chats = new Map((db.query("SELECT session_key, name FROM topics").all() as Array<{ session_key: string; name: string }>).map((t) => [t.session_key, t.name]));
  const g = new Map<string, RequestRow & { first: number }>();
  for (const call of c.calls) {
    if (call.personId !== personId) continue;
    const key = `${call.chatKey}\u0000${call.requestId ?? call.requestText}`;
    let r = g.get(key);
    if (!r) {
      r = { chatKey: call.chatKey, chatName: chats.get(call.chatKey) ?? call.chatKey, requestId: call.requestId, request: call.requestText, at: "", calls: 0, weighted: 0, accountPct: c.meta.quotaHistory ? 0 : null, first: call.ts };
      g.set(key, r);
    }
    r.calls++; r.weighted += call.weight; r.first = Math.min(r.first, call.ts);
    if (r.accountPct !== null) r.accountPct += call.points ?? 0;
  }
  const requests = [...g.values()].map(({ first, ...r }) => ({ ...r, at: new Date(first).toISOString(), weighted: Math.round(r.weighted), accountPct: r.accountPct === null ? null : round1(r.accountPct) }))
    .sort((a, b) => (b.accountPct ?? 0) - (a.accountPct ?? 0) || b.weighted - a.weighted);
  return { ...c.meta, personId, name: personId ? names.get(personId) ?? personId : NO_AUTHOR, requests };
}

function round1(x: number): number { return Math.round(x * 10) / 10; }
