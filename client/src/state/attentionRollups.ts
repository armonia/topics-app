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

/** How many children of a project wait on background work: the closed folder's grey glyph. */
export function projectBackgroundCount(
  rows: AttentionRows,
  projectPath: string,
  topics: Record<string, Topic>,
  terminalSessions: readonly TerminalSessionInfo[],
): number {
  let n = 0;
  for (const c of projectChildSubjects(projectPath, topics, terminalSessions)) {
    if (attentionOf(rows, c.subject).tier === 'background') n++;
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

/** The board's cards as the store knows them: id and project. */
export interface BoardCardRef {
  id: string;
  projectId?: string | null;
}

/**
 * A board tab and the Board row: the lit `task:` subjects, of one project's
 * board or (with `projectId` null) of every board. Review, parked, and a card
 * whose agent asks something mid-turn (ATTN-16). A card the board list does
 * not hold yet counts on the general board only: there is nothing to say
 * which project it belongs to.
 */
export function boardAttention(
  rows: AttentionRows,
  cards: readonly BoardCardRef[] | null | undefined,
  projectId: string | null,
): { tier: AttentionTier | null; count: number } {
  const projectOf = new Map<string, string | null | undefined>();
  for (const c of cards ?? []) projectOf.set(c.id, c.projectId);
  const views: SubjectAttention[] = [];
  for (const subject of rows.keys()) {
    if (!subject.startsWith(TASK_SUBJECT_PREFIX)) continue;
    const id = subject.slice(TASK_SUBJECT_PREFIX.length);
    if (projectId !== null && projectOf.get(id) !== projectId) continue;
    views.push(attentionOf(rows, subject));
  }
  return rollupAttention(views);
}
