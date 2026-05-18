/**
 * MasterBoardStrip — floating control surface above the Master Topic's
 * input. One unified view of every active session, annotated with the
 * Master AI's per-session proposal (ARCHIVIA / APRI / ATTENDI / SEEDA).
 *
 * Single primary CTA on top — the one action the user should take right
 * now. Below: list OR kanban view of all sessions, each row clickable
 * (jumps to chat) with archive shortcut. WS events keep the view live.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Sparkles, Crown, RefreshCw, ArrowRight, Archive,
  LayoutList, Columns3, ChevronDown, ChevronUp, Loader2, Circle, MessageSquareDot,
} from "lucide-react";
import { masterApi, topicsApi, type MasterSession, type MasterSessionState } from "../../lib/api";
import type { WSMessage } from "../../types";

const STATE_LABEL: Record<MasterSessionState, string> = {
  empty: "vuoto",
  streaming: "streaming",
  update: "aggiornamento",
  waiting: "in attesa",
  idle: "caught-up",
};
const STATE_DOT: Record<MasterSessionState, string> = {
  empty: "bg-app-text-muted/40",
  streaming: "bg-yellow-300 animate-pulse",
  update: "bg-emerald-300",
  waiting: "bg-blue-300",
  idle: "bg-app-text-muted/50",
};
/** Per-state icon for the list-row marker. Streaming gets a real spinner so
 *  "AI is replying" is unmistakable; update gets a glyph that reads as "new
 *  message"; other states fall back to a small filled dot for visual rhythm. */
function StateMarker({ state, size = 12 }: { state: MasterSessionState; size?: number }) {
  if (state === "streaming") {
    return <Loader2 size={size} className="text-yellow-300 animate-spin flex-shrink-0" aria-label="streaming" />;
  }
  if (state === "update") {
    return <MessageSquareDot size={size} className="text-emerald-300 flex-shrink-0" aria-label="nuovo messaggio" />;
  }
  if (state === "waiting") {
    return <Circle size={size - 4} className="text-blue-300 fill-blue-300 flex-shrink-0" aria-label="in attesa" />;
  }
  if (state === "empty") {
    return <Circle size={size - 4} className="text-app-text-muted/40 flex-shrink-0" aria-label="vuoto" />;
  }
  return <Circle size={size - 4} className="text-app-text-muted/40 fill-app-text-muted/40 flex-shrink-0" aria-label="caught-up" />;
}
const STATE_PRIORITY: Record<MasterSessionState, number> = {
  update: 0,
  streaming: 1,
  waiting: 2,
  empty: 3,
  idle: 4,
};

/** Max session rows visible in list view before scroll. */
const LIST_VISIBLE = 10;
const VIEW_STORAGE_KEY = "topics:master-strip:view";
const COLLAPSED_STORAGE_KEY = "topics:master-strip:collapsed";

function renderInlineMd(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(regex)) {
    const i = m.index ?? 0;
    if (i > last) parts.push(text.slice(last, i));
    const tok = m[0];
    if (tok.startsWith("**")) {
      parts.push(<strong key={key++} className="font-semibold text-app-text">{tok.slice(2, -2)}</strong>);
    } else {
      parts.push(<code key={key++} className="px-1 py-0.5 rounded bg-purple-500/15 text-purple-100 text-[11px] font-mono">{tok.slice(1, -1)}</code>);
    }
    last = i + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function parseNextBlock(md: string | undefined): string | null {
  if (!md) return null;
  const re = /^#{2,3}\s*Next(?:\s+action)?\s*$/im;
  const match = md.match(re);
  if (!match || match.index === undefined) return null;
  const rest = md.slice(match.index + match[0].length);
  const stop = rest.match(/^#{2,3}\s+\S/m);
  const body = (stop ? rest.slice(0, stop.index) : rest).trim();
  return body || null;
}

type ActionVerb = "archivia" | "apri";
type ParsedAction = { verb: ActionVerb; session: MasterSession; reason: string };

const VERB_RE = /\b(ARCHIVIA|APRI)\b/i;
const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const BOLD_RE = /\*\*([^*\n]+)\*\*/;
const BULLET_RE = /^[-*]\s+/;
// Section headers we still need to RECOGNIZE (to reset currentSection) even
// though we don't render them anymore. Without this, an `**ATTENDI**:` header
// after `**ARCHIVIA**:` would silently leave currentSection=archivia and
// every bullet below would inherit the wrong verb.
const ANY_SECTION_VERB_RE = /\b(ARCHIVIA|APRI|ATTENDI|SEEDA|EMPTY|WAIT|PROSEGUE|MONITORA|IGNORA)\b/i;

function parseActions(block: string | null, sessions: MasterSession[]): ParsedAction[] {
  if (!block || sessions.length === 0) return [];
  const byId = new Map(sessions.map((s) => [s.topicId, s]));
  const byName = new Map(sessions.map((s) => [s.name.toLowerCase(), s]));
  const out: ParsedAction[] = [];
  const seen = new Set<string>();
  let currentSection: ActionVerb | null = null;

  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (!BULLET_RE.test(line)) {
      const stripped = line.replace(/^\*+|\*+$/g, "").replace(/\*\*/g, "").trim();
      // Section header for a verb we actually render → set currentSection.
      const m = stripped.match(VERB_RE);
      if (m && stripped.length < 200) {
        currentSection = m[1].toLowerCase() as ActionVerb;
        continue;
      }
      // Section header for a verb we DON'T render (ATTENDI, etc.) → reset
      // currentSection so the bullets below don't inherit the previous one.
      const am = stripped.match(ANY_SECTION_VERB_RE);
      if (am && stripped.length < 200) {
        currentSection = null;
        continue;
      }
    }
    if (!BULLET_RE.test(line)) continue;
    const body = line.replace(BULLET_RE, "");

    let verb: ActionVerb | null = null;
    const bv = body.match(VERB_RE);
    if (bv) verb = bv[1].toLowerCase() as ActionVerb;
    else if (currentSection) verb = currentSection;
    else continue;

    let session: MasterSession | null = null;
    const uu = body.match(UUID_RE);
    if (uu && byId.has(uu[1].toLowerCase())) session = byId.get(uu[1].toLowerCase()) ?? null;
    if (!session) {
      const bn = body.match(BOLD_RE);
      if (bn) session = byName.get(bn[1].trim().toLowerCase()) ?? null;
    }
    if (!session) {
      for (const s of sessions) {
        if (s.name.length < 3) continue;
        if (body.toLowerCase().includes(s.name.toLowerCase())) { session = s; break; }
      }
    }
    if (!session) continue;
    if (seen.has(session.topicId + ":" + verb)) continue;
    seen.add(session.topicId + ":" + verb);

    out.push({
      verb,
      session,
      reason: body
        .replace(VERB_RE, "")
        .replace(/`?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`?/gi, "")
        .replace(BOLD_RE, "")
        .replace(/^[\s:—\-–`]+/, "")
        // Drop leading "(projectName) — " or "(projectName): " — the project
        // is shown as a chip beside the verb, repeating it inline is noise.
        .replace(/^\(([^)]+)\)\s*[—–\-:]\s*/u, "")
        .replace(/\s+—\s+/g, " — ")
        .replace(/`{2,}/g, "")
        // Sentence-case the first letter so reasons read uniformly.
        .replace(/^([a-zà-ú])/u, (c) => c.toUpperCase())
        .slice(0, 240)
        .trim(),
    });
  }
  return out;
}

function projectLabel(projectPath: string | null | undefined): string | null {
  if (!projectPath) return null;
  const clean = projectPath.replace(/\/+$/, "");
  const base = clean.split("/").pop() || clean;
  return base || null;
}

function ProjectChip({ projectPath, color }: { projectPath: string | null; color?: string }) {
  const label = projectLabel(projectPath);
  if (!label) return null;
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded-md font-medium tracking-tight border border-app-border/40 bg-app-bg/40 text-app-text-muted flex items-center gap-1 flex-shrink-0 max-w-[120px]"
      title={projectPath ?? undefined}
    >
      <span
        className="w-1.5 h-1.5 rounded-sm flex-shrink-0"
        style={{ backgroundColor: color || "var(--app-text-muted)" }}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function buildSnapshotMd(sessions: MasterSession[]): string {
  if (sessions.length === 0) return "# Active sessions (live state)\n\n_No active sessions._";
  const lines: string[] = [];
  lines.push("# Active sessions (live state)");
  lines.push("");
  lines.push(`**${sessions.length} active topic(s)** — iterate, do not skip any:`);
  lines.push("");
  for (const s of sessions) {
    const tag = s.role === "teammate" ? " 🤝" : "";
    const proj = s.projectPath ? ` · ${s.projectPath.split("/").pop()}` : "";
    lines.push(`## ${s.name}${tag}${proj}`);
    lines.push(`- id: \`${s.topicId}\``);
    lines.push(`- status: **${s.state}**  (${s.msgCount} msg, last ${fmtAgo(s.lastAt)}${s.unread > 0 ? `, ${s.unread} unread` : ""})`);
    if (s.lastPreview) lines.push(`- last (${s.lastRole ?? "?"}): ${s.lastPreview}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * A "row" combines a session with the optional AI verb for it. The list
 * and kanban both render this shape so the two views stay in sync.
 */
interface MergedRow {
  session: MasterSession;
  action: ParsedAction | null;
  /** Sort key — AI-proposed archives float to the top, then state priority. */
  rank: number;
}

function mergeSessions(sessions: MasterSession[], actions: ParsedAction[]): MergedRow[] {
  const byId = new Map(actions.map((a) => [a.session.topicId, a]));
  const rows: MergedRow[] = sessions.map((s) => {
    const a = byId.get(s.topicId) ?? null;
    // Rank: AI verbs come first (archivia > apri), then state priority.
    let actionRank = 9;
    if (a?.verb === "archivia") actionRank = 0;
    else if (a?.verb === "apri") actionRank = 1;
    const stateRank = STATE_PRIORITY[s.state] ?? 9;
    return { session: s, action: a, rank: actionRank * 10 + stateRank };
  });
  rows.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return (b.session.updatedAt || "").localeCompare(a.session.updatedAt || "");
  });
  return rows;
}

export interface MasterBoardStripProps {
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  onJumpToTopic?: (topicId: string) => void;
  onAskMaster?: (prompt: string) => void;
  lastAssistantMessage?: string;
}

export function MasterBoardStrip({ onMessage, onJumpToTopic, onAskMaster, lastAssistantMessage }: MasterBoardStripProps) {
  const [sessions, setSessions] = useState<MasterSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [bulkArchiving, setBulkArchiving] = useState(false);
  const [view, setView] = useState<"list" | "kanban">(() => {
    try { return (localStorage.getItem(VIEW_STORAGE_KEY) as "list" | "kanban") || "list"; } catch { return "list"; }
  });
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1"; } catch { return false; }
  });
  const [expandList, setExpandList] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0"); } catch {}
  }, [collapsed]);
  // Track topic IDs that just changed state — triggers a brief pulse.
  const [pulsing, setPulsing] = useState<Set<string>>(new Set());

  useEffect(() => {
    try { localStorage.setItem(VIEW_STORAGE_KEY, view); } catch {}
  }, [view]);

  const refresh = useCallback(async () => {
    try {
      const r = await masterApi.getSessions();
      setSessions((prev) => {
        // Detect rows whose state changed → pulse them briefly.
        const changed = new Set<string>();
        for (const s of r.sessions) {
          const old = prev.find((p) => p.topicId === s.topicId);
          if (old && old.state !== s.state) changed.add(s.topicId);
        }
        if (changed.size > 0) {
          setPulsing((cur) => new Set([...cur, ...changed]));
          window.setTimeout(() => {
            setPulsing((cur) => {
              const next = new Set(cur);
              for (const id of changed) next.delete(id);
              return next;
            });
          }, 2500);
        }
        return r.sessions;
      });
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Refresh on any WS event that could change a session's state. The
  // debounce coalesces bursts (e.g. streaming chunks) into one refetch.
  useEffect(() => {
    if (!onMessage) return;
    let pending: number | null = null;
    const debounced = () => {
      if (pending) return;
      pending = window.setTimeout(() => { pending = null; refresh(); }, 250);
    };
    return onMessage((msg) => {
      switch (msg.type) {
        case "message:new":
        case "message:media":
        case "stream:end":
        case "stream:start":
        case "stream:content_chunk":
        case "unread:updated":
        case "topic:created":
        case "topic:updated":
        case "topic:archived":
          debounced();
          break;
      }
    });
  }, [onMessage, refresh]);

  const handleArchive = useCallback(async (topicId: string) => {
    setArchivingId(topicId);
    try {
      await topicsApi.archive(topicId, true);
      setSessions((prev) => prev.filter((s) => s.topicId !== topicId));
    } catch (err) {
      console.error("[MasterBoardStrip] archive failed", err);
    } finally {
      setArchivingId(null);
    }
  }, []);

  const parsedNext = useMemo(() => parseNextBlock(lastAssistantMessage), [lastAssistantMessage]);
  const parsedActions = useMemo(() => parseActions(parsedNext, sessions), [parsedNext, sessions]);
  const rows = useMemo(() => mergeSessions(sessions, parsedActions), [sessions, parsedActions]);

  const summary = useMemo(() => {
    const c: Record<MasterSessionState, number> = { update: 0, streaming: 0, waiting: 0, idle: 0, empty: 0 };
    for (const s of sessions) c[s.state] = (c[s.state] ?? 0) + 1;
    return c;
  }, [sessions]);

  const archives = useMemo(() => parsedActions.filter((a) => a.verb === "archivia"), [parsedActions]);
  const opens = useMemo(() => parsedActions.filter((a) => a.verb === "apri"), [parsedActions]);

  const handleBulkArchive = useCallback(async () => {
    if (archives.length === 0) return;
    setBulkArchiving(true);
    const ids = archives.map((a) => a.session.topicId);
    try {
      await Promise.all(ids.map((id) => topicsApi.archive(id, true).catch(() => {})));
      setSessions((prev) => prev.filter((s) => !ids.includes(s.topicId)));
    } finally { setBulkArchiving(false); }
  }, [archives]);

  /**
   * Primary CTA — the single most useful action right now. Priority:
   *   1. AI proposed multiple archives → "Archivia N proposte"
   *   2. AI proposed a single archive → "Archivia <name>"
   *   3. AI proposed APRI → "Apri <name>"
   *   4. No AI proposal + updates exist → "Apri <first update>"
   *   5. No AI proposal + idle sessions → "Valuta sessioni concluse"
   *   6. Otherwise → no CTA
   */
  const primary = useMemo<
    | { label: string; sublabel?: string; onClick: () => void; disabled?: boolean; busy?: boolean }
    | null
  >(() => {
    if (archives.length > 1) {
      return {
        label: `Archivia ${archives.length} proposte`,
        sublabel: archives.map((a) => a.session.name).slice(0, 3).join(", ") + (archives.length > 3 ? `, +${archives.length - 3}` : ""),
        onClick: handleBulkArchive,
        busy: bulkArchiving,
      };
    }
    if (archives.length === 1 && archives[0]) {
      const a = archives[0];
      return {
        label: `Archivia "${a.session.name}"`,
        sublabel: a.reason,
        onClick: () => handleArchive(a.session.topicId),
        busy: archivingId === a.session.topicId,
      };
    }
    if (opens.length > 0 && opens[0]) {
      const a = opens[0];
      return {
        label: `Apri "${a.session.name}"`,
        sublabel: a.reason,
        onClick: () => onJumpToTopic?.(a.session.topicId),
      };
    }
    if (parsedActions.length === 0 && summary.update > 0) {
      const first = rows.find((r) => r.session.state === "update");
      if (first) {
        return {
          label: `Apri "${first.session.name}"`,
          sublabel: `${summary.update} update in attesa di triage`,
          onClick: () => onJumpToTopic?.(first.session.topicId),
        };
      }
    }
    if (parsedActions.length === 0 && summary.idle > 0 && onAskMaster) {
      return {
        label: "Valuta sessioni concluse",
        sublabel: `Chiedi al Master di proporre archivi per le ${summary.idle} sessioni idle`,
        onClick: () => {
          const snapshot = buildSnapshotMd(sessions);
          onAskMaster(`${snapshot}\n\n---\n\nItera ogni sessione \`idle\` qui sopra. Per ciascuna leggi \`last (assistant)\` e decidi:\n- Se **conclusa** (final answer, nessuna domanda aperta, niente in sospeso) → proponila per **ARCHIVIA** nel blocco \`## Next\`.\n- Se l'utente deve fare qualcosa IN quella tab (rispondere, approvare, fornire dati, rigenerare credenziali, eseguire un comando, decidere) → **APRI** con la descrizione dell'azione concreta.\n- Altrimenti **NON elencarla**. Niente ATTENDI catch-all.`);
        },
      };
    }
    return null;
  }, [archives, opens, parsedActions.length, summary, rows, sessions, archivingId, bulkArchiving, handleArchive, handleBulkArchive, onJumpToTopic, onAskMaster]);

  const listRows = expandList ? rows : rows.slice(0, LIST_VISIBLE);

  return (
    <div
      data-testid="master-board-strip"
      onClick={(e) => e.stopPropagation()}
      className="flex flex-col gap-2 mx-3 mb-1.5 px-3 py-2.5 bg-app-bg-secondary/90 backdrop-blur-md border border-purple-500/25 rounded-lg shadow-lg shadow-purple-500/5 max-h-[45vh] overflow-y-auto"
    >
      {/* Header + view toggle. */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="master-collapse-toggle"
          onClick={() => setCollapsed((v) => !v)}
          className="p-0.5 rounded hover:bg-app-hover text-app-text-muted/80 hover:text-app-text transition-colors flex-shrink-0"
          title={collapsed ? "Espandi" : "Riduci"}
          aria-label={collapsed ? "Espandi" : "Riduci"}
        >
          {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        <Crown size={12} className="text-purple-400 flex-shrink-0" />
        <span className="text-[11px] font-medium text-purple-200/90 uppercase tracking-wide">
          Master · {sessions.length} sessioni
        </span>
        <div className="flex items-center gap-1.5 text-[10px] text-app-text-muted/80 ml-1">
          {summary.update > 0 && (
            <Pill dot={STATE_DOT.update} text={`${summary.update} update`} />
          )}
          {summary.streaming > 0 && (
            <Pill dot={STATE_DOT.streaming} text={`${summary.streaming} streaming`} />
          )}
          {summary.waiting > 0 && (
            <Pill dot={STATE_DOT.waiting} text={`${summary.waiting} in attesa`} />
          )}
          {summary.idle > 0 && (
            <Pill dot={STATE_DOT.idle} text={`${summary.idle} idle`} muted />
          )}
        </div>
        <div className="ml-auto flex items-center gap-0.5 bg-app-bg/40 border border-app-border/40 rounded p-0.5">
          <button
            type="button"
            onClick={() => setView("list")}
            data-active={view === "list"}
            className={`p-1 rounded text-[10px] transition-colors ${view === "list" ? "bg-purple-500/25 text-purple-100" : "text-app-text-muted hover:text-app-text"}`}
            title="Vista lista"
            aria-label="Vista lista"
          >
            <LayoutList size={11} />
          </button>
          <button
            type="button"
            onClick={() => setView("kanban")}
            data-active={view === "kanban"}
            className={`p-1 rounded text-[10px] transition-colors ${view === "kanban" ? "bg-purple-500/25 text-purple-100" : "text-app-text-muted hover:text-app-text"}`}
            title="Vista kanban"
            aria-label="Vista kanban"
          >
            <Columns3 size={11} />
          </button>
        </div>
        <button
          type="button"
          onClick={() => refresh()}
          className="p-1 rounded hover:bg-app-hover text-app-text-muted/70 hover:text-app-text transition-colors"
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw size={11} />
        </button>
      </div>

      {/* Primary CTA — the one big button. */}
      {primary && (
        <button
          type="button"
          data-testid="master-primary-cta"
          onClick={primary.onClick}
          disabled={primary.busy}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md bg-gradient-to-r from-purple-500/30 to-purple-500/20 hover:from-purple-500/45 hover:to-purple-500/30 border border-purple-400/45 text-purple-50 disabled:opacity-60 transition-all group"
        >
          <Sparkles size={16} className="text-purple-200 flex-shrink-0" />
          <div className="flex-1 min-w-0 text-left">
            <div className="text-[13px] font-semibold leading-tight truncate">
              {primary.busy ? "In corso…" : primary.label}
            </div>
            {primary.sublabel && (
              <div className="text-[10.5px] text-purple-200/80 leading-snug truncate mt-0.5">
                {renderInlineMd(primary.sublabel)}
              </div>
            )}
          </div>
          <ArrowRight size={14} className="text-purple-200 flex-shrink-0 group-hover:translate-x-0.5 transition-transform" />
        </button>
      )}

      {/* Unified rows — hidden when the strip is collapsed so the user
          can still see the header summary + the primary CTA without
          the full list eating screen real estate. */}
      {!collapsed && (loading ? (
        <div className="text-[11px] text-app-text-muted italic px-1 py-2">Caricamento sessioni…</div>
      ) : rows.length === 0 ? (
        <div className="text-[11px] text-app-text-muted italic px-1 py-2">
          Nessuna sessione attiva. Crea un topic per partire.
        </div>
      ) : view === "kanban" ? (
        <KanbanView
          rows={rows}
          onJump={(id) => onJumpToTopic?.(id)}
          onArchive={handleArchive}
          archivingId={archivingId}
          pulsing={pulsing}
        />
      ) : (
        <div className="flex flex-col gap-1">
          {listRows.map((row) => (
            <SessionRow
              key={row.session.topicId}
              row={row}
              onJump={() => onJumpToTopic?.(row.session.topicId)}
              onArchive={() => handleArchive(row.session.topicId)}
              archiving={archivingId === row.session.topicId || bulkArchiving}
              pulsing={pulsing.has(row.session.topicId)}
            />
          ))}
          {rows.length > LIST_VISIBLE && (
            <button
              type="button"
              onClick={() => setExpandList((v) => !v)}
              className="text-[10.5px] text-app-text-muted/80 hover:text-app-text px-1 py-1 self-start"
            >
              {expandList
                ? `Mostra solo le prime ${LIST_VISIBLE}`
                : `+${rows.length - LIST_VISIBLE} altre sessioni`}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Pill({ dot, text, muted }: { dot: string; text: string; muted?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 ${muted ? "opacity-70" : ""}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {text}
    </span>
  );
}

/* ── Row rendering ───────────────────────────────────────────────────── */

const VERB_BADGE: Record<ActionVerb, string> = {
  archivia: "bg-emerald-500/15 text-emerald-200 border-emerald-400/30",
  apri: "bg-blue-500/15 text-blue-200 border-blue-400/30",
};

interface SessionRowProps {
  row: MergedRow;
  onJump: () => void;
  onArchive: () => void;
  archiving: boolean;
  pulsing: boolean;
}
function SessionRow({ row, onJump, onArchive, archiving, pulsing }: SessionRowProps) {
  const { session: s, action } = row;
  const reason = action?.reason || s.lastPreview || "";
  // Fallback "implicit" badge when the AI hasn't proposed an action yet but
  // the session state still implies a clear next step for the user.
  //   update → there's a new assistant message the user hasn't read → LEGGI
  //   streaming → AI is mid-reply → IN CORSO (informational, no action needed)
  // Other states (waiting / idle / empty) get no badge.
  const implicitBadge = !action
    ? s.state === "update"
      ? { label: "LEGGI", cls: "bg-emerald-500/15 text-emerald-200 border-emerald-400/30" }
      : s.state === "streaming"
        ? { label: "IN CORSO", cls: "bg-yellow-500/15 text-yellow-100 border-yellow-400/30" }
        : null
    : null;
  const verbBadge = action ? (
    <span className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold tracking-wide flex-shrink-0 ${VERB_BADGE[action.verb]}`}>
      {action.verb.toUpperCase()}
    </span>
  ) : implicitBadge ? (
    <span className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold tracking-wide flex-shrink-0 ${implicitBadge.cls}`}>
      {implicitBadge.label}
    </span>
  ) : null;

  return (
    <div
      data-testid={`master-row-${s.topicId}`}
      data-state={s.state}
      data-verb={action?.verb ?? "none"}
      className={`relative flex items-center gap-2 rounded-md border border-app-border/40 bg-surface hover:bg-purple-500/10 px-2.5 py-1.5 transition-colors group ${pulsing ? "ring-1 ring-purple-400/60 animate-pulse" : ""}`}
    >
      <span title={STATE_LABEL[s.state]} className="flex items-center justify-center w-3.5 h-3.5">
        <StateMarker state={s.state} size={13} />
      </span>
      {verbBadge}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onJump(); }}
        className="flex-1 min-w-0 text-left cursor-pointer py-0.5"
        title={reason ? `${s.name}${projectLabel(s.projectPath) ? ` · ${projectLabel(s.projectPath)}` : ""}\n\n${reason}` : `Apri "${s.name}"`}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <ProjectChip projectPath={s.projectPath} color={s.color} />
          <span className={`truncate min-w-0 ${(action || implicitBadge) ? "text-[11px] text-app-text-muted/85" : "text-[12.5px] font-medium text-app-text"}`}>{s.name}</span>
          {s.role === "teammate" && <span className="text-[10px] flex-shrink-0" title="teammate">🤝</span>}
          {s.unread > 0 && (
            <span className="text-[10px] px-1 rounded bg-emerald-500/20 text-emerald-200 font-medium tabular-nums flex-shrink-0">
              {s.unread}
            </span>
          )}
          {!action && !implicitBadge && (
            <span className="text-[9.5px] uppercase tracking-wide text-app-text-muted/70 ml-0.5 flex-shrink-0">
              {STATE_LABEL[s.state]}
            </span>
          )}
          <span className="text-[10px] text-app-text-muted/60 tabular-nums ml-auto flex-shrink-0">
            {fmtAgo(s.lastAt)}
          </span>
        </div>
        {reason && (
          (action || implicitBadge) ? (
            <div className="text-[13px] text-app-text leading-snug line-clamp-2 mt-1">
              {reason}
            </div>
          ) : (
            <div className="text-[11.5px] text-app-text-muted/85 leading-snug line-clamp-1 mt-0.5">
              <span className="text-app-text-muted/60 mr-1">{s.lastRole === "assistant" ? "AI:" : "tu:"}</span>
              {reason}
            </div>
          )
        )}
      </button>
      {/* Quick actions — jump (always) + archive (always allowed, AI just hints). */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onJump(); }}
        className="p-1 rounded hover:bg-blue-500/20 text-app-text-muted/70 hover:text-blue-200 transition-colors flex-shrink-0 opacity-0 group-hover:opacity-100"
        title="Apri chat"
        aria-label="Apri chat"
      >
        <ArrowRight size={11} />
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onArchive(); }}
        disabled={archiving}
        className={`p-1 rounded transition-colors flex-shrink-0 disabled:opacity-40 ${
          action?.verb === "archivia"
            ? "text-emerald-300 hover:text-emerald-100 hover:bg-emerald-500/20"
            : "text-app-text-muted/60 hover:text-app-text hover:bg-app-bg/60 opacity-0 group-hover:opacity-100"
        }`}
        title="Archivia sessione"
        aria-label="Archivia"
      >
        <Archive size={11} />
      </button>
    </div>
  );
}

/* ── Kanban view ─────────────────────────────────────────────────────── */

interface KanbanViewProps {
  rows: MergedRow[];
  onJump: (id: string) => void;
  onArchive: (id: string) => void;
  archivingId: string | null;
  pulsing: Set<string>;
}
function KanbanView({ rows, onJump, onArchive, archivingId, pulsing }: KanbanViewProps) {
  // Empty sessions are noise — they don't get a column. They're still
  // reachable via list view (and trivially archivable from there).
  const cols: MasterSessionState[] = ["update", "waiting", "streaming", "idle"];
  const byState: Record<MasterSessionState, MergedRow[]> = {
    update: [], waiting: [], streaming: [], idle: [], empty: [],
  };
  for (const r of rows) {
    if (r.session.state === "empty") continue;
    byState[r.session.state].push(r);
  }

  const emptyCount = rows.filter((r) => r.session.state === "empty").length;

  return (
    <>
    <div className="flex gap-1.5 overflow-x-auto pb-1" data-testid="master-kanban">
      {cols.map((c) => {
        const list = byState[c];
        return (
          <div
            key={c}
            data-testid={`master-kanban-col-${c}`}
            className="flex flex-col min-w-[180px] max-w-[220px] flex-shrink-0 bg-app-bg/25 border border-app-border/30 rounded-md max-h-[30vh]"
          >
            <div className="flex items-center gap-1 px-1.5 pt-1.5 pb-1 flex-shrink-0 border-b border-app-border/20">
              <StateMarker state={c} size={12} />
              <span className="text-[10px] uppercase tracking-wide text-app-text-muted/90 font-medium">
                {STATE_LABEL[c]}
              </span>
              <span className="text-[10px] text-app-text-muted/70 tabular-nums ml-auto">
                {list.length}
              </span>
            </div>
            <div className="flex flex-col gap-1 p-1.5 overflow-y-auto min-h-0 flex-1">
              {list.length === 0 ? (
                <div className="text-[10px] text-app-text-muted/50 italic px-1 py-2 text-center">
                  —
                </div>
              ) : (
                list.map((r) => (
                  <KanbanCard
                    key={r.session.topicId}
                    row={r}
                    onJump={() => onJump(r.session.topicId)}
                    onArchive={() => onArchive(r.session.topicId)}
                    archiving={archivingId === r.session.topicId}
                    pulsing={pulsing.has(r.session.topicId)}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
    {emptyCount > 0 && (
      <div className="flex items-center gap-2 text-[10px] text-app-text-muted/70 px-0.5">
        <span>{emptyCount === 1 ? "1 sessione vuota ignorata" : `${emptyCount} sessioni vuote ignorate`} (0 messaggi)</span>
        <button
          type="button"
          onClick={async () => {
            const ids = rows.filter((r) => r.session.state === "empty").map((r) => r.session.topicId);
            await Promise.all(ids.map((id) => onArchive(id)));
          }}
          className="text-purple-300 hover:text-purple-100 underline-offset-2 hover:underline transition-colors"
        >
          archivia tutte
        </button>
      </div>
    )}
    </>
  );
}

function KanbanCard({ row, onJump, onArchive, archiving, pulsing }: { row: MergedRow; onJump: () => void; onArchive: () => void; archiving: boolean; pulsing: boolean }) {
  const { session: s, action } = row;
  const reason = action?.reason || s.lastPreview || "";
  return (
    <div
      data-testid={`master-kanban-card-${s.topicId}`}
      className={`relative rounded border border-app-border/40 bg-surface hover:bg-purple-500/10 px-1.5 py-1.5 transition-colors group ${pulsing ? "ring-1 ring-purple-400/60 animate-pulse" : ""}`}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onJump(); }}
        className="w-full text-left cursor-pointer"
        title={reason ? `${s.name}\n\n${reason}` : `Apri "${s.name}"`}
      >
        <div className="flex items-center gap-1 mb-1 min-w-0">
          {action && (
            <span className={`text-[8.5px] px-1 py-0.5 rounded border font-semibold tracking-wide flex-shrink-0 ${VERB_BADGE[action.verb]}`}>
              {action.verb.toUpperCase()}
            </span>
          )}
          <ProjectChip projectPath={s.projectPath} color={s.color} />
          <span className={`truncate flex-1 min-w-0 ${action ? "text-[10px] text-app-text-muted/80" : "text-[11px] font-medium text-app-text"}`}>{s.name}</span>
        </div>
        {action && reason && (
          <div className="text-[12px] text-app-text leading-snug line-clamp-3 mb-1">
            {reason}
          </div>
        )}
        <div className="text-[9.5px] text-app-text-muted/70 tabular-nums flex items-center gap-1">
          <span>{fmtAgo(s.lastAt)}</span>
          <span>·</span>
          <span>{s.msgCount}msg</span>
          {s.unread > 0 && (
            <span className="ml-auto px-1 rounded bg-emerald-500/20 text-emerald-200 font-medium">
              {s.unread}
            </span>
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onArchive(); }}
        disabled={archiving}
        className="absolute top-1 right-1 p-0.5 rounded hover:bg-app-bg/70 text-app-text-muted/60 hover:text-app-text transition-colors disabled:opacity-40 opacity-0 group-hover:opacity-100"
        title="Archivia"
        aria-label="Archivia"
      >
        <Archive size={9} />
      </button>
    </div>
  );
}
