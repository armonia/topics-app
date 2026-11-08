/**
 * THE SETS OF SUBJECTS that surfaces roll up: a project's children, a group's
 * panes, a board's cards, and the whole installation for the Dock, the tray and
 * the PWA badge. Each one is a list of subjects folded by `rollupAttention`
 * (`attention.ts`), so a project row, a group card and the board tab can only
 * differ in WHICH subjects they hold, never in how they count them.
 *
 * Pure: the rows, the topics and the roster come from the caller.
 */
import type { Topic, TerminalSessionInfo } from '../types';
import type { Pane, SpaceMeta } from './pane/types';
import { resolvePaneSpace } from './pane/reducers/spaces';
import { getTerminalSessionFromPaneId } from './pane/adapters';
import { liveTopicsOfProject } from './projectAttentionIndex';
import { attentionOf, rollupAttention, type AttentionRows, type AttentionTier, type SubjectAttention } from './attention';
import { TASK_SUBJECT_PREFIX, terminalSubject, topicSubject } from '../../../shared/attention';
import { trayLitReason, type TrayLitReason } from '../../../shared/tray-board';

function terminalBelongsToProject(cwd: string, projectPath: string): boolean {
  return cwd === projectPath || cwd.startsWith(projectPath + '/');
}

/** One child of a project that is lit, with the name its row carries. */
export interface ProjectAttentionChild {
  subject: string;
  kind: 'chat' | 'terminal';
  id: string;
  name: string;
  attention: SubjectAttention;
}

/**
 * The children of a project: its live chats (not archived, not rendered on
 * their own with `standalone`) and its non-shell terminals whose cwd lives
 * under it. A shell is the person's own process, not an agent: it never
 * lights a folder.
 */
export function projectChildSubjects(
  projectPath: string,
  topics: Record<string, Topic>,
  terminalSessions: readonly TerminalSessionInfo[],
): { subject: string; kind: 'chat' | 'terminal'; id: string; name: string }[] {
  const out: { subject: string; kind: 'chat' | 'terminal'; id: string; name: string }[] = [];
  for (const t of liveTopicsOfProject(topics, projectPath)) {
    if (t.standalone) continue;
    out.push({ subject: topicSubject(t.id), kind: 'chat', id: t.id, name: t.name || 'Chat' });
  }
  for (const ts of terminalSessions) {
    if (ts.type === 'shell') continue;
    if (!ts.cwd || !terminalBelongsToProject(ts.cwd, projectPath)) continue;
    out.push({ subject: terminalSubject(ts.id), kind: 'terminal', id: ts.id, name: ts.name || ts.type || 'Terminal' });
  }
  return out;
}

/** The lit children of a project, by name: the tooltip and the tab's accessible name say who. */
export function projectAttentionChildren(
  rows: AttentionRows,
  projectPath: string,
  topics: Record<string, Topic>,
  terminalSessions: readonly TerminalSessionInfo[],
): ProjectAttentionChild[] {
  const out: ProjectAttentionChild[] = [];
  for (const c of projectChildSubjects(projectPath, topics, terminalSessions)) {
    const a = attentionOf(rows, c.subject);
    if (a.lit) out.push({ ...c, attention: a });
  }
  return out;
}

/** A project row or tab: the loudest lit child and how many are lit. */
export function projectAttention(
  rows: AttentionRows,
  projectPath: string,
  topics: Record<string, Topic>,
  terminalSessions: readonly TerminalSessionInfo[],
): { tier: AttentionTier | null; count: number } {
  return rollupAttention(projectAttentionChildren(rows, projectPath, topics, terminalSessions).map((c) => c.attention));
}

/** How many children of a project are `working` (a turn open, or tasks still running): the closed folder's ring. */
export function projectWorkingCount(
  rows: AttentionRows,
  projectPath: string,
  topics: Record<string, Topic>,
  terminalSessions: readonly TerminalSessionInfo[],
): number {
  let n = 0;
  for (const c of projectChildSubjects(projectPath, topics, terminalSessions)) {
    if (attentionOf(rows, c.subject).tier === 'working') n++;
  }
  return n;
}

/** «2 to look at: Render · build». Empty when nothing is lit. */
export function describeProjectAttention(children: readonly ProjectAttentionChild[], words: { lookAt: (n: number) => string; more: (n: number) => string }): string {
  if (!children.length) return '';
  const shown = children.slice(0, 4).map((c) => c.name);
  const rest = children.length - shown.length;
  return `${words.lookAt(children.length)}: ${shown.join(' · ')}${rest > 0 ? ` · ${words.more(rest)}` : ''}`;
}

/**
 * A group card: the loudest lit subject among the group's panes. A chat pane
 * is its topic, a terminal pane its session, a project pane its children.
 */
export function spaceAttention(
  spaceId: string,
  panes: Record<string, Pane>,
  spaces: Record<string, SpaceMeta>,
  rows: AttentionRows,
  topics: Record<string, Topic>,
  terminalSessions: readonly TerminalSessionInfo[],
): { tier: AttentionTier | null; count: number } {
  const views: SubjectAttention[] = [];
  const seen = new Set<string>();
  const add = (subject: string) => {
    if (seen.has(subject)) return;
    seen.add(subject);
    views.push(attentionOf(rows, subject));
  };
  for (const pane of Object.values(panes)) {
    if (resolvePaneSpace(pane, spaces) !== spaceId) continue;
    if (pane.type === 'chat') add(topicSubject(pane.topicId ?? pane.id));
    else if (pane.type === 'terminal') {
      const sid = pane.terminalSessionId ?? getTerminalSessionFromPaneId(pane.id);
      if (sid) add(terminalSubject(sid));
    } else if (pane.type === 'project' && pane.projectPath) {
      for (const c of projectChildSubjects(pane.projectPath, topics, terminalSessions)) add(c.subject);
    }
  }
  return rollupAttention(views);
}

/** The board's cards as the store knows them: id, project and title. */
export interface BoardCardRef {
  id: string;
  projectId?: string | null;
  text?: string | null;
}

/** One lit card of a board, with where it lives and why it waits. */
export interface BoardLitCard {
  id: string;
  projectId: string | null;
  title: string;
  reason: TrayLitReason;
  attention: SubjectAttention;
}

/**
 * The lit `task:` subjects of one project's board or (with `projectId` null)
 * of every board: review, parked, and a card whose agent asks something
 * mid-turn (ATTN-16). The project is the row's own (`projectId`, written by
 * the server for every card, steps included); the feed's map is the fallback
 * for a row that does not carry it. Steps are not in the feed (it holds roots
 * only), so before the row carried the project a lit step lit the general
 * board and never its project's.
 */
export function boardLitCards(
  rows: AttentionRows,
  cards: readonly BoardCardRef[] | null | undefined,
  projectId: string | null,
): BoardLitCard[] {
  const byId = new Map<string, BoardCardRef>();
  for (const c of cards ?? []) byId.set(c.id, c);
  const out: BoardLitCard[] = [];
  for (const [subject, row] of rows) {
    if (!subject.startsWith(TASK_SUBJECT_PREFIX)) continue;
    const id = subject.slice(TASK_SUBJECT_PREFIX.length);
    const known = byId.get(id);
    const project = row.projectId ?? known?.projectId ?? null;
    if (projectId !== null && project !== projectId) continue;
    const attention = attentionOf(rows, subject);
    if (!attention.lit) continue;
    out.push({ id, projectId: project, title: row.cardTitle ?? known?.text ?? id, reason: trayLitReason(row.reason), attention });
  }
  return out;
}

/** A board tab and the Board row: the loudest lit card and how many are lit (`boardLitCards`). */
export function boardAttention(
  rows: AttentionRows,
  cards: readonly BoardCardRef[] | null | undefined,
  projectId: string | null,
): { tier: AttentionTier | null; count: number } {
  return rollupAttention(boardLitCards(rows, cards, projectId).map((c) => c.attention));
}
export const __knipBlindspotProbe = 1; // KNIP-BLINDSPOT-PROBE — sonda temporanea, se la vedi committata cancellala
