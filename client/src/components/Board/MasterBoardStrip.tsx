/**
 * MasterBoardStrip — floating control surface above the Master Topic's
 * input. One unified view of every active session, annotated with the
 * Master AI's per-session proposal (COMPLETA / APRI / ATTENDI / SEEDA).
 *
 * Single primary CTA on top — the one action the user should take right
 * now. Below: list OR kanban view of all sessions, each row clickable
 * (jumps to chat) with archive shortcut. WS events keep the view live.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Sparkles, Crown, ArrowRight, Archive,
  LayoutList, Columns3, ChevronDown, ChevronUp, Loader2, Circle, MessageSquareDot,
  Minimize2, Rows3, Maximize2,
} from "lucide-react";
import { masterApi, topicsApi, type MasterSession, type MasterSessionState } from "../../lib/api";
import { basename } from "../../lib/path-utils";
import { getProjectLabel } from "../../lib/buildSidebarItems";
import type { WSMessage } from "../../types";
import { ClaudeIcon } from "../Shared/ClaudeIcon";

const STATE_LABEL: Record<MasterSessionState, string> = {
  empty: "vuoto",
  streaming: "streaming",
  update: "aggiornamento",
  waiting: "in attesa",
  idle: "caught-up",
};
/** Minimum sizes for Lucide icons. Below 12px stroke rendering gets fuzzy
 *  on standard displays; below 14px multi-element glyphs (MessageSquareDot,
 *  Loader2 spinner segments) collapse into unrecognisable specks. We clamp
 *  every caller through these constants so we don't have to chase rogue
 *  small sizes scattered across the file. */
const ICON_MIN = 14;
const ICON_DOT_MIN = 10; // simple filled circles can render smaller cleanly

/** Per-state icon for the list-row marker. Streaming gets a real spinner so
 *  "AI is replying" is unmistakable; update gets a glyph that reads as "new
 *  message"; other states fall back to a filled dot for visual rhythm. */
function StateMarker({ state, size = ICON_MIN }: { state: MasterSessionState; size?: number }) {
  // Glyph icons need a higher floor than dots.
  const glyphSize = Math.max(size, ICON_MIN);
  const dotSize = Math.max(size - 2, ICON_DOT_MIN);
  // Stroke width 2.25 keeps detail visible at small sizes.
  const stroke = 2.25;
  if (state === "streaming") {
    return <Loader2 size={glyphSize} strokeWidth={stroke} className="text-yellow-300 animate-spin flex-shrink-0" aria-label="streaming" />;
  }
  if (state === "update") {
    return <MessageSquareDot size={glyphSize} strokeWidth={stroke} className="text-emerald-300 flex-shrink-0" aria-label="nuovo messaggio" />;
  }
  if (state === "waiting") {
    return <Circle size={dotSize} strokeWidth={stroke} className="text-blue-300 fill-blue-300 flex-shrink-0" aria-label="in attesa" />;
  }
  if (state === "empty") {
    return <Circle size={dotSize} strokeWidth={stroke} className="text-app-text-muted/40 flex-shrink-0" aria-label="vuoto" />;
  }
  return <Circle size={dotSize} strokeWidth={stroke} className="text-app-text-muted/40 fill-app-text-muted/40 flex-shrink-0" aria-label="caught-up" />;
}
const STATE_PRIORITY: Record<MasterSessionState, number> = {
  update: 0,
  streaming: 1,
  waiting: 2,
  empty: 3,
  idle: 4,
};

const VIEW_STORAGE_KEY = "topics:master-strip:view";
const COLLAPSED_STORAGE_KEY = "topics:master-strip:collapsed";
const SIZE_STORAGE_KEY = "topics:master-strip:size";

type StripSize = "sm" | "md" | "lg";
/** Max body height per size. Body scrolls if it overflows; header stays put.
 *  - sm: minimal — shows ~3 sessions, chat stays primary
 *  - md: balanced — ~10 sessions, comfortable triage
 *  - lg: full — takes the whole chat area, useful for bulk review
 *
 *  The lg reservation accounts for: topbar (~3rem) + tab bar (~2rem) + a
 *  visual breathing margin (~2rem) + input bar below (~5rem). Anything
 *  smaller and the strip glued itself to the topbar; the reserved space
 *  here keeps the top of the panel away from the chrome. */
const SIZE_MAX_H: Record<StripSize, string> = {
  sm: "max-h-[16vh]",
  md: "max-h-[38vh]",
  lg: "max-h-[calc(100vh-13rem)]",
};
const SIZE_LABEL: Record<StripSize, string> = { sm: "Piccolo", md: "Medio", lg: "Tutta la chat" };
const SIZE_ORDER: StripSize[] = ["sm", "md", "lg"];

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

// Canonical action verb after the ARCHIVIA → COMPLETA rename. The two map
// to the same UI/semantic action ("this conversation is done, clear it from
// the workspace"); ARCHIVIA is kept as a synonym so old Master replies still
// in chat history continue to parse correctly. `verb` on a ParsedAction is
// always the canonical form ("completa" | "apri").
type ActionVerb = "completa" | "apri";
type ParsedAction = { verb: ActionVerb; session: MasterSession; reason: string };

// Canonical verbs the model emits. COMPLETA is primary; ARCHIVIA stays as a
// retro-compat alias so the parser doesn't drop old Master replies that
// used the previous verb. Both normalize to "completa" internally.
const VERB_RE = /\b(COMPLETA|ARCHIVIA|APRI)\b/i;
const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const BOLD_RE = /\*\*([^*\n]+)\*\*/;
const BULLET_RE = /^[-*]\s+/;
// Section headers we still need to RECOGNIZE (to reset currentSection) even
// though we don't render them anymore. Without this, an `**ATTENDI**:` header
// after `**COMPLETA**:` would silently leave currentSection=completa and
// every bullet below would inherit the wrong verb.
const ANY_SECTION_VERB_RE = /\b(COMPLETA|ARCHIVIA|APRI|ATTENDI|SEEDA|EMPTY|WAIT|PROSEGUE|MONITORA|IGNORA)\b/i;

/** Normalize a raw verb match (case-insensitive, possibly the old ARCHIVIA
 *  spelling) into the canonical lowercase form used everywhere else. */
function canonicalVerb(raw: string): ActionVerb {
  const lo = raw.toLowerCase();
  if (lo === "archivia") return "completa";
  return lo as ActionVerb;
}

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
        currentSection = canonicalVerb(m[1]);
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
    if (bv) verb = canonicalVerb(bv[1]);
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
  return getProjectLabel(projectPath) || null;
}

function ProjectChip({ projectPath, color }: { projectPath: string | null; color?: string }) {
  const label = projectLabel(projectPath);
  if (!label) return null;
  // Use the project color as a tinted border + text so the chip itself encodes
  // the project identity — no separate decorative dot. The semi-transparent
  // background keeps it readable on dark UI without screaming for attention.
  const tone = color || "var(--app-text-muted)";
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded-md font-medium tracking-tight flex items-center flex-shrink-0 max-w-[140px]"
      style={{
        color: tone,
        borderColor: tone,
        borderWidth: 1,
        backgroundColor: `color-mix(in srgb, ${tone} 10%, transparent)`,
      }}
      title={projectPath ?? undefined}
    >
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
    // The header tag is a 1-glyph hint; claude-code sessions are already
    // disambiguated by the `kind:` line below, so we don't double-mark them
    // here. (We can't embed a Claude SVG in a Markdown header.)
    const tag = s.role === "teammate" ? " 🤝" : "";
    const proj = s.projectPath ? ` · ${basename(s.projectPath)}` : "";
    lines.push(`## ${s.name}${tag}${proj}`);
    lines.push(`- id: \`${s.topicId}\``);
    if (s.sessionType === "claude-code-terminal") {
      lines.push(`- kind: **Claude Code terminal** (CLI session, no chat log)`);
      lines.push(`- status: **${s.state}** ${s.projectPath ? `(cwd: ${s.projectPath})` : ""}`);
    } else {
      lines.push(`- status: **${s.state}**  (${s.msgCount} msg, last ${fmtAgo(s.lastAt)}${s.unread > 0 ? `, ${s.unread} unread` : ""})`);
      if (s.lastPreview) lines.push(`- last (${s.lastRole ?? "?"}): ${s.lastPreview}`);
    }
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
  /** Sort key — AI-proposed completions float to the top, then state priority. */
  rank: number;
}

function mergeSessions(sessions: MasterSession[], actions: ParsedAction[]): MergedRow[] {
  const byId = new Map(actions.map((a) => [a.session.topicId, a]));
  const rows: MergedRow[] = sessions.map((s) => {
    const a = byId.get(s.topicId) ?? null;
    // Rank: AI verbs come first (completa > apri), then state priority.
    let actionRank = 9;
    if (a?.verb === "completa") actionRank = 0;
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
  /** True while the Master's OWN chat reply is streaming. Drives a banner
   *  inside the strip so the user, who may be looking at the kanban full-
   *  screen, still sees that the Master is producing the next `## Next`. */
  isMasterStreaming?: boolean;
}

export function MasterBoardStrip({ onMessage, onJumpToTopic, onAskMaster, lastAssistantMessage, isMasterStreaming }: MasterBoardStripProps) {
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
  const [size, setSize] = useState<StripSize>(() => {
    try {
      const v = localStorage.getItem(SIZE_STORAGE_KEY);
      if (v === "sm" || v === "md" || v === "lg") return v;
    } catch {}
    return "sm"; // Default: small. Strip shouldn't dominate the chat view.
  });
  useEffect(() => {
    try { localStorage.setItem(SIZE_STORAGE_KEY, size); } catch {}
  }, [size]);
  // React to external size writes (e.g. App.tsx normalising lg→md on the
  // sidebar Open-Master action so the chat is visible). Both the cross-tab
  // `storage` event and an explicit same-tab `CustomEvent` are honoured so
  // an already-mounted strip downsizes immediately, without waiting for a
  // remount/reload.
  useEffect(() => {
    const apply = (raw: string | null) => {
      if (raw === "sm" || raw === "md" || raw === "lg") {
        setSize((cur) => (cur === raw ? cur : raw));
      }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === SIZE_STORAGE_KEY) apply(e.newValue);
    };
    const onCustom = (e: Event) => {
      const ce = e as CustomEvent<{ size?: string }>;
      apply(ce.detail?.size ?? null);
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("master-strip:size-changed", onCustom as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("master-strip:size-changed", onCustom as EventListener);
    };
  }, []);

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

  // Local streaming detector — tracks whether ANY topic is currently in the
  // middle of an assistant turn. The host-provided `isMasterStreaming` is the
  // primary signal, but the host hook (isSessionStreaming) may not track the
  // Master's own session, so we keep this WS-driven flag as a fallback.
  const [wsStreaming, setWsStreaming] = useState(false);

  // Refresh on any WS event that could change a session's state. The
  // debounce coalesces bursts (e.g. streaming chunks) into one refetch.
  useEffect(() => {
    if (!onMessage) return;
    let pending: number | null = null;
    let lastChunk = 0;
    const debounced = () => {
      if (pending) return;
      pending = window.setTimeout(() => { pending = null; refresh(); }, 250);
    };
    // Auto-clear wsStreaming if no chunk arrives for 3s — protects against
    // a missed `stream:end` event leaving the banner stuck on.
    const checkStale = window.setInterval(() => {
      if (lastChunk && Date.now() - lastChunk > 3000) {
        setWsStreaming(false);
      }
    }, 1000);
    const off = onMessage((msg) => {
      switch (msg.type) {
        case "stream:start":
        case "stream:content_chunk":
          lastChunk = Date.now();
          setWsStreaming(true);
          debounced();
          break;
        case "stream:end":
          setWsStreaming(false);
          debounced();
          break;
        case "message:new":
        case "message:media":
        case "unread:updated":
        case "topic:created":
        case "topic:updated":
        case "topic:archived":
          debounced();
          break;
      }
    });
    return () => { off(); window.clearInterval(checkStale); };
  }, [onMessage, refresh]);

  // "Complete" a session — for chat topics this archives them (the storage
  // boolean is still `archived`, the user-facing wording changed); for the
  // Claude Code terminal pseudo-rows (id prefixed `terminal:`) we DELETE the
  // terminal session so the PTY is closed. Both keep the row off the list.
  const handleArchive = useCallback(async (topicId: string) => {
    setArchivingId(topicId);
    try {
      if (topicId.startsWith("terminal:")) {
        const sessionId = topicId.slice("terminal:".length);
        await fetch(`/api/terminal/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
      } else {
        await topicsApi.archive(topicId, true);
      }
      setSessions((prev) => prev.filter((s) => s.topicId !== topicId));
    } catch (err) {
      console.error("[MasterBoardStrip] complete failed", err);
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

  // Sessions the Master proposed to complete (legacy "archivia" verb is
  // normalised to "completa" at parse time — see canonicalVerb).
  const completions = useMemo(() => parsedActions.filter((a) => a.verb === "completa"), [parsedActions]);
  const opens = useMemo(() => parsedActions.filter((a) => a.verb === "apri"), [parsedActions]);
  // Sessions in `update` state for which the AI hasn't yet proposed an action.
  // These are "new replies the Master hasn't seen". A secondary CTA prompts
  // the Master to triage them without forcing the user to type the request.
  const uncoveredUpdates = useMemo(() => {
    const acted = new Set(parsedActions.map((a) => a.session.topicId));
    return sessions.filter((s) => s.state === "update" && !acted.has(s.topicId));
  }, [sessions, parsedActions]);

  const handleBulkComplete = useCallback(async () => {
    if (completions.length === 0) return;
    setBulkArchiving(true);
    const ids = completions.map((a) => a.session.topicId);
    try {
      // "Complete" maps to two different endpoints depending on the row kind:
      //   - regular topic id  → topicsApi.archive (sets the `archived` flag)
      //   - terminal:<id>     → DELETE /api/terminal/sessions/<id> (kills PTY)
      // We dispatch each id to the right call so the user can complete a
      // mixed batch (chat topics + terminals) from one button.
      await Promise.all(ids.map((id) => {
        if (id.startsWith("terminal:")) {
          const sessionId = id.slice("terminal:".length);
          return fetch(`/api/terminal/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
        }
        return topicsApi.archive(id, true).catch(() => {});
      }));
      setSessions((prev) => prev.filter((s) => !ids.includes(s.topicId)));
    } finally { setBulkArchiving(false); }
  }, [completions]);

  /**
   * Primary CTA — the single most useful action right now. Priority:
   *   1. AI proposed multiple completions → "Completa N proposte"
   *   2. AI proposed a single completion → "Completa <name>"
   *   3. AI proposed APRI → "Apri <name>"
   *   4. No AI proposal + updates exist → "Apri <first update>"
   *   5. No AI proposal + idle sessions → "Valuta sessioni concluse"
   *   6. Otherwise → no CTA
   */
  const primary = useMemo<
    | { label: string; sublabel?: string; onClick: () => void; disabled?: boolean; busy?: boolean }
    | null
  >(() => {
    if (completions.length > 1) {
      return {
        label: `Completa ${completions.length} proposte`,
        sublabel: completions.map((a) => a.session.name).slice(0, 3).join(", ") + (completions.length > 3 ? `, +${completions.length - 3}` : ""),
        onClick: handleBulkComplete,
        busy: bulkArchiving,
      };
    }
    if (completions.length === 1 && completions[0]) {
      const a = completions[0];
      return {
        label: `Completa "${a.session.name}"`,
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
    if (parsedActions.length === 0 && summary.update > 0 && onAskMaster) {
      // No AI proposal yet AND we have fresh updates → ask Master to triage.
      return {
        label: `Valuta ${summary.update} novità`,
        sublabel: "Chiedi al Master cosa fare con le sessioni aggiornate",
        onClick: () => {
          const snapshot = buildSnapshotMd(sessions);
          onAskMaster(`${snapshot}\n\n---\n\nCi sono ${summary.update} sessioni con un nuovo messaggio non letto (stato \`update\`). Iteralle e per ciascuna decidi:\n- Se la conversazione è ora **conclusa** (final answer dell'AI, niente in sospeso) → **COMPLETA**.\n- Se l'utente deve fare qualcosa IN quella tab → **APRI** con l'azione concreta.\n- Altrimenti non elencarla.`);
        },
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
        sublabel: `Chiedi al Master di proporre il completamento per le ${summary.idle} sessioni idle`,
        onClick: () => {
          const snapshot = buildSnapshotMd(sessions);
          onAskMaster(`${snapshot}\n\n---\n\nItera ogni sessione \`idle\` qui sopra. Per ciascuna leggi \`last (assistant)\` e decidi:\n- Se **conclusa** (final answer, nessuna domanda aperta, niente in sospeso) → proponila per **COMPLETA** nel blocco \`## Next\`.\n- Se l'utente deve fare qualcosa IN quella tab (rispondere, approvare, fornire dati, rigenerare credenziali, eseguire un comando, decidere) → **APRI** con la descrizione dell'azione concreta.\n- Altrimenti **NON elencarla**. Niente ATTENDI catch-all.`);
        },
      };
    }
    return null;
  }, [completions, opens, parsedActions.length, summary, rows, sessions, archivingId, bulkArchiving, handleArchive, handleBulkComplete, onJumpToTopic, onAskMaster]);

  // Show every session, always. Body container scrolls when overflowing.
  const listRows = rows;

  return (
    <div
      data-testid="master-board-strip"
      onClick={(e) => e.stopPropagation()}
      className={`flex flex-col mx-3 mb-1.5 bg-app-bg-secondary/90 backdrop-blur-md border border-purple-500/25 rounded-lg shadow-lg shadow-purple-500/5 ${SIZE_MAX_H[size]} overflow-hidden`}
    >
      {/* Header — clickable bar that toggles collapse. Sticky inside the
          strip so it stays put when the body scrolls. */}
      <button
        type="button"
        data-testid="master-collapse-toggle"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? "Espandi" : "Riduci"}
        aria-label={collapsed ? "Espandi" : "Riduci"}
        className="flex items-center gap-2 px-3 pt-2.5 pb-2 hover:bg-purple-500/10 transition-colors flex-shrink-0 text-left cursor-pointer"
      >
        <span className="p-0.5 rounded text-app-text-muted/80 flex-shrink-0">
          {collapsed ? <ChevronUp size={14} strokeWidth={2.25} /> : <ChevronDown size={14} strokeWidth={2.25} />}
        </span>
        <Crown size={14} strokeWidth={2.25} className="text-purple-400 flex-shrink-0" />
        <span className="text-[11px] font-medium text-purple-200/90 uppercase tracking-wide">
          Master · {sessions.length} sessioni
        </span>
        <div className="flex items-center gap-1.5 text-[10px] text-app-text-muted/80 ml-1">
          {summary.update > 0 && <Pill state="update" count={summary.update} label="nuove" />}
          {summary.streaming > 0 && <Pill state="streaming" count={summary.streaming} label="in corso" />}
          {summary.waiting > 0 && <Pill state="waiting" count={summary.waiting} label="in attesa" />}
          {summary.idle > 0 && <Pill state="idle" count={summary.idle} label="ferme" muted />}
        </div>
        <div
          role="group"
          aria-label="Altezza pannello"
          onClick={(e) => e.stopPropagation()}
          className="ml-auto flex items-center gap-0.5 bg-app-bg/40 border border-app-border/40 rounded p-0.5"
        >
          {SIZE_ORDER.map((s) => {
            const Icon = s === "sm" ? Minimize2 : s === "md" ? Rows3 : Maximize2;
            const active = s === size;
            return (
              <span
                key={s}
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); setSize(s); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setSize(s); } }}
                data-active={active}
                className={`p-1 rounded text-[10px] transition-colors cursor-pointer ${active ? "bg-purple-500/25 text-purple-100" : "text-app-text-muted hover:text-app-text"}`}
                title={SIZE_LABEL[s]}
                aria-label={SIZE_LABEL[s]}
              >
                <Icon size={14} strokeWidth={2.25} />
              </span>
            );
          })}
        </div>
        <div
          role="group"
          aria-label="Vista"
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-0.5 bg-app-bg/40 border border-app-border/40 rounded p-0.5"
        >
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); setView("list"); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setView("list"); } }}
            data-active={view === "list"}
            className={`p-1 rounded text-[10px] transition-colors cursor-pointer ${view === "list" ? "bg-purple-500/25 text-purple-100" : "text-app-text-muted hover:text-app-text"}`}
            title="Vista lista"
            aria-label="Vista lista"
          >
            <LayoutList size={14} strokeWidth={2.25} />
          </span>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); setView("kanban"); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setView("kanban"); } }}
            data-active={view === "kanban"}
            className={`p-1 rounded text-[10px] transition-colors cursor-pointer ${view === "kanban" ? "bg-purple-500/25 text-purple-100" : "text-app-text-muted hover:text-app-text"}`}
            title="Vista kanban"
            aria-label="Vista kanban"
          >
            <Columns3 size={14} strokeWidth={2.25} />
          </span>
        </div>
      </button>

      {/* Scrollable body — header above stays put thanks to overflow-hidden
          on the parent + this being the only scroll container. */}
      <div className="flex flex-col gap-2 px-3 pb-2.5 pt-1 overflow-y-auto flex-1 min-h-0">

      {/* Live banner — shown while the Master's own reply is streaming (or
          any WS-tracked stream is active). Gives the user feedback that
          triage is in progress, especially when the strip is full-screen
          (LG) and dominates the chat area. */}
      {(isMasterStreaming || wsStreaming) && (
        <div
          data-testid="master-streaming-banner"
          className="flex items-center gap-2 px-3 py-2 rounded-md border border-purple-400/40 bg-purple-500/15 text-purple-100 text-[12px] animate-pulse"
        >
          <Loader2 size={14} className="animate-spin flex-shrink-0" />
          <span className="font-medium">Master sta valutando le sessioni…</span>
          <span className="text-purple-200/70 text-[11px]">il blocco <code className="px-1 rounded bg-purple-500/20 font-mono">## Next</code> arriva tra poco</span>
        </div>
      )}

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

      {/* Secondary CTA — only when the AI already proposed actions but there
          ARE fresh updates the Master hasn't seen yet. One click re-asks the
          Master to triage them. Hidden if the primary CTA is already the
          triage prompt (parsedActions.length === 0 branch). */}
      {parsedActions.length > 0 && uncoveredUpdates.length > 0 && onAskMaster && (
        <button
          type="button"
          data-testid="master-rivaluta-cta"
          onClick={() => {
            const snapshot = buildSnapshotMd(sessions);
            onAskMaster(`${snapshot}\n\n---\n\nCi sono ${uncoveredUpdates.length} sessioni con un nuovo messaggio che non avevi ancora valutato (stato \`update\`):\n${uncoveredUpdates.map((s) => `- \`${s.topicId}\` "${s.name}"`).join("\n")}\n\nIteralle e aggiorna il blocco \`## Next\`: per ciascuna scegli **COMPLETA** se conclusa, **APRI** se l'utente deve agire, altrimenti non listarla.`);
          }}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-emerald-500/12 hover:bg-emerald-500/22 border border-emerald-400/35 text-emerald-100 text-[11.5px] transition-colors"
        >
          <MessageSquareDot size={14} strokeWidth={2.25} className="flex-shrink-0" />
          <span className="flex-1 text-left">
            Rivaluta {uncoveredUpdates.length} {uncoveredUpdates.length === 1 ? "novità" : "novità"}
            <span className="text-emerald-200/70 ml-1.5">
              {uncoveredUpdates.slice(0, 2).map((s) => s.name).join(", ")}{uncoveredUpdates.length > 2 ? `, +${uncoveredUpdates.length - 2}` : ""}
            </span>
          </span>
          <ArrowRight size={13} strokeWidth={2.25} className="flex-shrink-0 opacity-80" />
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
          size={size}
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
              size={size}
            />
          ))}
          {(() => {
            const emptyIds = rows.filter((r) => r.session.state === "empty").map((r) => r.session.topicId);
            if (emptyIds.length === 0) return null;
            return (
              <button
                type="button"
                onClick={async () => {
                  await Promise.all(emptyIds.map((id) => handleArchive(id)));
                }}
                className="self-start mt-1 inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border border-app-border/40 bg-app-bg/40 text-app-text-muted hover:text-app-text hover:bg-app-bg/70 hover:border-purple-400/40 transition-colors"
                title="Sessioni con 0 messaggi: probabilmente create per errore. Le completa tutte."
              >
                <Archive size={14} strokeWidth={2.25} />
                Completa {emptyIds.length} {emptyIds.length === 1 ? "sessione vuota" : "sessioni vuote"} (0 msg)
              </button>
            );
          })()}
        </div>
      ))}
      </div>
    </div>
  );
}

function Pill({ state, count, label, muted }: { state: MasterSessionState; count: number; label: string; muted?: boolean }) {
  // Reuse StateMarker so the header summary uses the SAME icons as the rows.
  // Builds visual recognition: the user learns once that the spinner = streaming.
  const full = `${count} ${label} — ${STATE_LABEL[state]}`;
  return (
    <span className={`inline-flex items-center gap-1 ${muted ? "opacity-70" : ""}`} title={full}>
      <StateMarker state={state} size={14} />
      <span className="tabular-nums">{count}</span>
      <span>{label}</span>
    </span>
  );
}

/* ── Row rendering ───────────────────────────────────────────────────── */

const VERB_BADGE: Record<ActionVerb, string> = {
  completa: "bg-emerald-500/15 text-emerald-200 border-emerald-400/30",
  apri: "bg-blue-500/15 text-blue-200 border-blue-400/30",
};

interface SessionRowProps {
  row: MergedRow;
  onJump: () => void;
  onArchive: () => void;
  archiving: boolean;
  pulsing: boolean;
  size: StripSize;
}
function SessionRow({ row, onJump, onArchive, archiving, pulsing, size }: SessionRowProps) {
  const { session: s, action } = row;
  // When the AI proposed an action: show ITS reason. If empty, show nothing
  // rather than falling back to the chat's last message preview — that
  // mixed two unrelated signals (AI motivation vs chat content) and read
  // as nonsense like "COMPLETA / esegui il comando bash" where the bottom
  // line was actually the chat preview, not a justification.
  // When there is NO AI action: show the chat preview, prefixed so the
  // user understands they're reading the last message, not a motivation.
  const reason = action ? (action.reason || "") : (s.lastPreview || "");
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
      className={`relative flex items-center gap-2 rounded-md border bg-surface hover:bg-purple-500/10 px-2.5 py-1.5 transition-colors group ${
        s.state === "streaming" && size === "lg"
          ? "border-yellow-400/55 ring-1 ring-yellow-400/35 animate-pulse"
          : "border-app-border/40"
      } ${pulsing ? "ring-1 ring-purple-400/60 animate-pulse" : ""}`}
    >
      <span title={STATE_LABEL[s.state]} className="flex items-center justify-center w-4 h-4 flex-shrink-0">
        <StateMarker state={s.state} size={14} />
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
          {s.sessionType === "claude-code-terminal" && (
            <ClaudeIcon size={11} className="flex-shrink-0 text-[#D97757]" />
          )}
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
            <div className="text-[12px] text-app-text/85 leading-snug line-clamp-1 mt-0.5">
              <span className="text-app-text-muted/80 mr-1 font-medium">{s.lastRole === "assistant" ? "AI:" : "tu:"}</span>
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
        <ArrowRight size={14} strokeWidth={2.25} />
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onArchive(); }}
        disabled={archiving}
        className={`p-1 rounded transition-colors flex-shrink-0 disabled:opacity-40 ${
          action?.verb === "completa"
            ? "text-emerald-300 hover:text-emerald-100 hover:bg-emerald-500/20"
            : "text-app-text-muted/60 hover:text-app-text hover:bg-app-bg/60 opacity-0 group-hover:opacity-100"
        }`}
        title="Completa sessione"
        aria-label="Completa"
      >
        <Archive size={14} strokeWidth={2.25} />
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
  size: StripSize;
}
/** Column descriptor — either an AI-verb column (e.g. APRI) or a state column. */
type KanbanColumn =
  | { kind: "verb"; verb: ActionVerb; label: string; key: string }
  | { kind: "state"; state: MasterSessionState; label: string; key: string };

// State columns shown on the LEFT. `update` is intentionally NOT a column —
// the unread badge already marks new replies on the row itself, and once the
// Master triages an update it moves to the APRI/COMPLETA column anyway. So a
// dedicated "aggiornamento" column was just inbox-clutter.
const STATE_COLUMNS: KanbanColumn[] = [
  { kind: "state", state: "waiting", label: STATE_LABEL.waiting, key: "waiting" },
  { kind: "state", state: "streaming", label: STATE_LABEL.streaming, key: "streaming" },
  { kind: "state", state: "idle", label: STATE_LABEL.idle, key: "idle" },
];

function KanbanView({ rows, onJump, onArchive, archivingId, pulsing, size }: KanbanViewProps) {
  // Build columns dynamically. AI-verb columns (APRI, COMPLETA) own their
  // sessions exclusively: pulled OUT of the state columns so AI-proposed
  // actions are surfaced as distinct buckets instead of being diluted across
  // update/waiting/idle. State columns then group whatever sessions remain.
  const apriRows = rows.filter((r) => r.action?.verb === "apri" && r.session.state !== "empty");
  const completaRows = rows.filter((r) => r.action?.verb === "completa" && r.session.state !== "empty");
  const verbIds = new Set([...apriRows, ...completaRows].map((r) => r.session.topicId));

  const byState: Record<MasterSessionState, MergedRow[]> = {
    update: [], waiting: [], streaming: [], idle: [], empty: [],
  };
  for (const r of rows) {
    if (r.session.state === "empty") continue;
    if (verbIds.has(r.session.topicId)) continue; // owned by a verb column
    // `update` rows fold into `idle` — the unread badge on the row already
    // surfaces the "new reply" signal; no need for a dedicated column.
    const bucket: MasterSessionState = r.session.state === "update" ? "idle" : r.session.state;
    byState[bucket].push(r);
  }

  // LEFT: state columns (passive — driven by chat activity).
  // RIGHT: AI-action columns (proposed by Master) — hidden when empty so
  // the kanban doesn't show two persistent empty boxes the user has to scan.
  const columns: { col: KanbanColumn; list: MergedRow[] }[] = [];
  for (const sc of STATE_COLUMNS) {
    columns.push({ col: sc, list: byState[(sc as Extract<KanbanColumn, { kind: "state" }>).state] });
  }
  if (apriRows.length > 0) {
    columns.push({ col: { kind: "verb", verb: "apri", label: "Da aprire", key: "apri" }, list: apriRows });
  }
  if (completaRows.length > 0) {
    columns.push({ col: { kind: "verb", verb: "completa", label: "Da completare", key: "completa" }, list: completaRows });
  }

  const emptyCount = rows.filter((r) => r.session.state === "empty").length;
  // Per-size column height. At "lg" we let columns fill the available body
  // height (parent already caps the strip at calc(100vh-9rem)), so the
  // kanban actually takes over the chat area as the user expects.
  const colMaxH = size === "sm" ? "max-h-[14vh]" : size === "md" ? "max-h-[34vh]" : "";

  return (
    <div className={`flex flex-col gap-2 ${size === "lg" ? "flex-1 min-h-0" : ""}`}>
    <div
      className={`flex gap-1.5 overflow-x-auto pb-1 ${size === "lg" ? "flex-1 min-h-0" : ""}`}
      data-testid="master-kanban"
    >
      {columns.map(({ col, list }) => {
        const isApri = col.kind === "verb" && col.verb === "apri";
        const isComplete = col.kind === "verb" && col.verb === "completa";
        const tint = isApri
          ? { bg: "bg-blue-500/8", border: "border-blue-400/35", header: "border-blue-400/25", labelColor: "text-blue-100", countColor: "text-blue-200/80", badgeCls: "bg-blue-500/15 text-blue-200 border-blue-400/30", badgeText: "APRI" }
          : isComplete
            ? { bg: "bg-emerald-500/8", border: "border-emerald-400/35", header: "border-emerald-400/25", labelColor: "text-emerald-100", countColor: "text-emerald-200/80", badgeCls: "bg-emerald-500/15 text-emerald-200 border-emerald-400/30", badgeText: "COMPLETA" }
            : { bg: "bg-app-bg/25", border: "border-app-border/30", header: "border-app-border/20", labelColor: "text-app-text-muted/90", countColor: "text-app-text-muted/70", badgeCls: "", badgeText: "" };
        return (
          <div
            key={col.key}
            data-testid={`master-kanban-col-${col.key}`}
            className={`flex flex-col flex-1 min-w-[160px] rounded-md ${tint.bg} border ${tint.border} ${size === "lg" ? "self-stretch min-h-0" : colMaxH}`}
          >
            <div className={`flex items-center gap-1 px-1.5 pt-1.5 pb-1 flex-shrink-0 border-b ${tint.header}`}>
              {col.kind === "state" ? (
                <StateMarker state={col.state} size={14} />
              ) : (
                <span className={`text-[8.5px] px-1 py-0.5 rounded border font-semibold tracking-wide flex-shrink-0 ${tint.badgeCls}`}>
                  {tint.badgeText}
                </span>
              )}
              <span className={`text-[10px] uppercase tracking-wide font-medium ${tint.labelColor}`}>
                {col.label}
              </span>
              <span className={`text-[10px] tabular-nums ml-auto ${tint.countColor}`}>
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
                    size={size}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
    {emptyCount > 0 && (
      <button
        type="button"
        onClick={async () => {
          const ids = rows.filter((r) => r.session.state === "empty").map((r) => r.session.topicId);
          await Promise.all(ids.map((id) => onArchive(id)));
        }}
        className="self-start inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border border-app-border/40 bg-app-bg/40 text-app-text-muted hover:text-app-text hover:bg-app-bg/70 hover:border-purple-400/40 transition-colors"
        title="Sessioni con 0 messaggi: probabilmente create per errore. Le completa tutte."
      >
        <Archive size={14} strokeWidth={2.25} />
        Completa {emptyCount} {emptyCount === 1 ? "sessione vuota" : "sessioni vuote"} (0 msg)
      </button>
    )}
    </div>
  );
}

function KanbanCard({ row, onJump, onArchive, archiving, pulsing, size }: { row: MergedRow; onJump: () => void; onArchive: () => void; archiving: boolean; pulsing: boolean; size: StripSize }) {
  const { session: s, action } = row;
  const reason = action ? (action.reason || "") : (s.lastPreview || "");
  // In LG (full-screen) we keep a prominent live indicator on streaming cards
  // so the user — who is dedicating the screen to the strip — has clear
  // ambient feedback that things are happening. In SM/MD the small marker
  // icon is enough.
  const liveStreaming = s.state === "streaming";
  const showLgLive = liveStreaming && size === "lg";
  return (
    <div
      data-testid={`master-kanban-card-${s.topicId}`}
      className={`relative rounded border bg-surface hover:bg-purple-500/10 px-2 py-1.5 transition-colors group ${
        showLgLive
          ? "border-yellow-400/55 ring-1 ring-yellow-400/35 animate-pulse"
          : "border-app-border/40"
      } ${pulsing ? "ring-1 ring-purple-400/60 animate-pulse" : ""}`}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onJump(); }}
        className="w-full text-left cursor-pointer"
        title={`${s.name}${projectLabel(s.projectPath) ? ` · ${projectLabel(s.projectPath)}` : ""}${reason ? `\n\n${reason}` : ""}`}
      >
        {/* Row 1: verb badge + project chip + state marker */}
        <div className="flex items-center gap-1 mb-1 min-w-0">
          {action && (
            <span className={`text-[8.5px] px-1 py-0.5 rounded border font-semibold tracking-wide flex-shrink-0 ${VERB_BADGE[action.verb]}`}>
              {action.verb.toUpperCase()}
            </span>
          )}
          <ProjectChip projectPath={s.projectPath} color={s.color} />
          <span title={STATE_LABEL[s.state]} className="ml-auto flex-shrink-0 flex items-center">
            <StateMarker state={s.state} size={14} />
          </span>
        </div>
        {/* Row 2: session name — readable, not truncated to a line */}
        <div className="text-[12.5px] font-semibold text-app-text leading-snug mb-1 break-words">
          {s.sessionType === "claude-code-terminal" && (
            <ClaudeIcon size={12} className="mr-1 inline-block align-[-2px] text-[#D97757]" />
          )}
          {s.role === "teammate" && <span className="mr-1" title="teammate">🤝</span>}
          {s.name}
        </div>
        {/* Row 3: reason / preview — FULL text, no clamp. Wraps inside card. */}
        {reason && (
          action ? (
            <div className="text-[11.5px] text-app-text leading-snug mb-1.5 whitespace-pre-wrap break-words">
              {reason}
            </div>
          ) : (
            <div className="text-[11px] text-app-text/85 leading-snug mb-1.5 whitespace-pre-wrap break-words">
              <span className="text-app-text-muted/80 mr-1 font-medium">{s.lastRole === "assistant" ? "AI:" : "tu:"}</span>
              {reason}
            </div>
          )
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
        title="Completa"
        aria-label="Completa"
      >
        <Archive size={13} strokeWidth={2.25} />
      </button>
    </div>
  );
}
