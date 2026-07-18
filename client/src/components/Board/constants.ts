import type { LucideIcon } from 'lucide-react';
import { PackageCheck } from 'lucide-react';
import type { TaskStatus } from '../../lib/board';

/** Compact prose for the shared ChatMarkdown renderer inside small board
 *  surfaces (session slices, comments, task description): small text, tight
 *  paragraph/list rhythm, scrollable code blocks. */
export const COMPACT_MD_CLS =
  // list-disc/decimal restore the markers Tailwind's preflight strips — without
  // them ul/ol render as unindented plain text and a bullet/numbered description
  // "non sembra formattata md". Headings get weight/size back too (preflight
  // flattens them), so an agent's plan reads as structured markdown.
  // break-words on prose (p/li/a) so a long unbreakable token — a URL, a path,
  // a hash — wraps instead of forcing the surface (card / drawer) to overflow.
  '[&_p]:my-0.5 [&_p]:break-words [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-black/40 [&_pre]:p-2 ' +
  '[&_ul]:my-0.5 [&_ul]:pl-4 [&_ul]:list-disc [&_ol]:my-0.5 [&_ol]:pl-4 [&_ol]:list-decimal [&_li]:my-0.5 [&_li]:break-words [&_li]:marker:text-neutral-500 ' +
  '[&_h1]:font-semibold [&_h1]:text-[13px] [&_h2]:font-semibold [&_h2]:text-[13px] [&_h3]:font-semibold [&_h3]:text-xs [&_h1]:mt-1 [&_h2]:mt-1 [&_h3]:mt-1 ' +
  '[&_code]:text-[11px] [&_a]:break-words [&_a]:text-sky-400 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-white/20 [&_blockquote]:pl-2 [&_blockquote]:text-neutral-400 [&_strong]:font-semibold';

// A PLAN is a document, not a chat bubble: this reading typography gives it a
// roomy vertical rhythm, section-divider headings, and prominent numbered steps
// so the agent's proposal is scannable instead of a dense wall. Used only by the
// "Piano" tab (the thread keeps COMPACT_MD_CLS). Kept in one string so the plan
// panel and any future plan surface share the exact same look.
export const PLAN_MD_CLS =
  '[&_p]:my-2 [&_p]:leading-relaxed ' +
  // Headings act as section titles with an underline divider; first one flush to top.
  '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:pb-1 [&_h1]:border-b [&_h1]:border-white/10 [&_h1]:text-[15px] [&_h1]:font-semibold [&_h1]:text-neutral-100 ' +
  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:pb-1 [&_h2]:border-b [&_h2]:border-white/10 [&_h2]:text-[14px] [&_h2]:font-semibold [&_h2]:text-neutral-100 ' +
  '[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-neutral-200 ' +
  '[&>*:first-child]:mt-0 ' +
  // Roomy lists; numbered steps get a bold violet marker so each step reads as a beat.
  '[&_ul]:my-2 [&_ul]:pl-5 [&_ul]:list-disc [&_ol]:my-2 [&_ol]:pl-6 [&_ol]:list-decimal ' +
  '[&_li]:my-1.5 [&_li]:pl-1 [&_li]:leading-relaxed [&_li]:marker:text-violet-300/70 [&_ol>li]:marker:font-semibold [&_ol>li]:marker:text-violet-300 ' +
  '[&_li_ul]:my-1 [&_li_ol]:my-1 ' +
  '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/40 [&_pre]:p-3 [&_pre]:text-[12px] ' +
  '[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-white/10 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_code]:text-[12px] ' +
  '[&_a]:text-sky-400 [&_a]:underline [&_strong]:font-semibold [&_strong]:text-neutral-100 ' +
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-violet-400/40 [&_blockquote]:pl-3 [&_blockquote]:text-neutral-400 ' +
  '[&_hr]:my-3 [&_hr]:border-white/10';

export const PRIORITY_DOT: Record<number, string> = {
  0: 'bg-neutral-400', 1: 'bg-sky-400', 2: 'bg-emerald-400', 3: 'bg-amber-400', 4: 'bg-rose-500',
};
// 4-first: the dispatch queue serves higher priorities first.
export const PRIORITY_ORDER = [4, 3, 2, 1, 0] as const;
export const PRIORITY_LABEL: Record<number, string> = {
  4: 'Urgente', 3: 'Alta', 2: 'Media', 1: 'Bassa', 0: 'Minima',
};

export const STATUS_ICON_COLOR: Record<TaskStatus, string> = {
  backlog: 'text-neutral-500',
  todo: 'text-neutral-300',
  in_progress: 'text-sky-400',
  review: 'text-rose-400',
  done: 'text-emerald-400',
};

// Card chip for the dispatch lifecycle (server: tasks.dispatch_state).
export const DISPATCH_CHIP: Record<string, { text: string; cls: string; title?: string; Icon?: LucideIcon }> = {
  queued: { text: 'in coda', cls: 'bg-white/10 text-neutral-300' },
  starting: { text: 'avvio…', cls: 'bg-amber-500/15 text-amber-300' },
  working: { text: 'al lavoro', cls: 'bg-sky-500/15 text-sky-300' },
  // Both live in Review, but they ask different things of the human:
  // needs_input = the agent ASKED (answer required); delivered = clean
  // hand-off, the agent believes it's done (approve/reject).
  needs_input: { text: 'serve te', cls: 'bg-rose-500/15 text-rose-300' },
  delivered: { text: 'consegnato', cls: 'bg-emerald-500/15 text-emerald-300', title: "L'agent ha consegnato: aspetta la tua review", Icon: PackageCheck },
  // Parked in backlog after a dispatch ended badly. 'failed' = the agent genuinely
  // failed (timeout without review after the cap / repeated setup errors) — a red,
  // ringed chip so it never reads as a neutral manual "fermato". 'blocked' = a
  // config issue the human must fix first (no worktree / project unresolvable).
  // The specific reason rides in task.dispatchError → shown as the chip tooltip.
  failed: { text: 'fallito', cls: 'bg-rose-500/25 text-rose-200 ring-1 ring-rose-400/40' },
  blocked: { text: 'da sistemare', cls: 'bg-amber-500/15 text-amber-300' },
};

// Single shared new-task draft → single caret key (board composer is global).
export const COMPOSER_CURSOR_KEY = 'board:composer';

/**
 * One tab of a task's surface tab group. The Thread is the always-present body;
 * these are the auxiliary surfaces the side panel / inline tab bar switch to.
 */
export type TaskSurface =
  | { id: string; kind: 'output'; label: string; url: string }
  | { id: string; kind: 'plan'; label: string; content: string }
  | { id: string; kind: 'media'; label: string; url: string; path: string }
  // A task-owned browser tab (feature-flagged): a real, drivable RemoteBrowserPanel
  // scoped to the task via a canonical `task-<id8>-<seq>` contextId. Kept out of the
  // global pane store — it lives only in the task's drawer (see state/taskBrowserTabs).
  | { id: string; kind: 'browser'; label: string; url: string; contextId: string };

/** Min drawer width (px) before the surface tab group earns its own side panel;
 *  below it the surfaces fold inline into the body. */
export const SIDEPANEL_MIN = 680;

/** Live per-turn usage pushed by the dispatcher (`task:usage-live`, transient). */
export interface LiveUsage { turnStartedAt: number; baseMs: number; liveTokens: number; model: string | null }

// ── Board settings (auto-dispatch config) ───────────────────────────────────
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
