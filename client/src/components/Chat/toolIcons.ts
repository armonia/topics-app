/**
 * Icon map keyed on `ToolCallDetail.type`.
 *
 * Lives in its own module (not ToolCards.tsx) so that the component file can
 * export only components — keeps Vite Fast Refresh happy
 * (react-refresh/only-export-components).
 */

import { Terminal as TerminalIcon, FileText, FilePen, FilePlus, Search, Globe, ListChecks, Bot, Brain, Sparkles, Wrench, Activity, Timer, ScrollText, Ban, NotebookPen, Wand2, Slash, Braces, Send, Users, LayoutTemplate, LayoutGrid, MessageCircleQuestion, KanbanSquare, SquareTerminal, type LucideIcon } from 'lucide-react';
import type { ToolCallDetail } from '../../types';
import { workKindOf } from './workKind';
import type { ToolCategory } from '../../../../shared/tool-phrase';
import { phraseFor } from '../../state/toolPhraseFallback';

/** The icon of the 7-category bucket a generic (`mcp`/`unknown`) row's own
 *  tool name falls into (`shared/tool-phrase.ts`): read, write, search,
 *  network, browser, shell. Board calls already left through `task_card`'s
 *  own icon before reaching here. */
const CATEGORY_ICON: Record<ToolCategory, LucideIcon> = {
  read: FileText, write: FilePen, search: Search, network: Globe, browser: Globe, shell: TerminalIcon, other: Sparkles,
};

function genericIcon(rawName: string, tool: string, args: Record<string, unknown> | undefined, fallback: LucideIcon): LucideIcon {
  const { category } = phraseFor(rawName, tool, args);
  return category === 'other' ? fallback : CATEGORY_ICON[category];
}

export function iconForDetail(detail: ToolCallDetail, rawName?: string): LucideIcon {
  switch (detail.type) {
    case 'shell': return TerminalIcon;
    case 'read': return FileText;
    case 'edit': return FilePen;
    case 'write': return FilePlus;
    case 'search': return Search;
    case 'fetch': return Globe;
    case 'todo': return ListChecks;
    case 'sub_agent': return Bot;
    case 'plan': return Brain;
    case 'task_card': return KanbanSquare;
    case 'mcp': return genericIcon(rawName ?? detail.tool, detail.tool, detail.args, Sparkles);
    case 'monitor': return Activity;
    case 'wait': return Timer;
    case 'bash_output': return ScrollText;
    case 'kill_shell': return Ban;
    case 'notebook_edit': return NotebookPen;
    case 'skill': return Wand2;
    case 'slash_command': return Slash;
    case 'lsp': return Braces;
    case 'agent_message': return Send;
    case 'agent_control': return Users;
    case 'artifact': return LayoutTemplate;
    case 'ask_user': return MessageCircleQuestion;
    case 'browser': return Globe;
    case 'view': return LayoutGrid;
    case 'unknown': return rawName ? genericIcon(rawName, rawName, detail.raw.args, Wrench) : Wrench;
  }
}

/**
 * The icon of a call's row: a background job has its own, the terminal square the strip of live work
 * already uses for a command (a process that runs and wakes the chat), the robot stays the sub-agent's, the rest is the detail's.
 */
export function iconForCall(name: string, detail: ToolCallDetail): LucideIcon {
  return workKindOf(name, detail) === 'background' ? SquareTerminal : iconForDetail(detail, name);
}
