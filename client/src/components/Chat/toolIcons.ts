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

export function iconForDetail(detail: ToolCallDetail): LucideIcon {
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
    case 'mcp': return Sparkles;
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
    case 'unknown': return Wrench;
  }
}

/**
 * The icon of a call's row: a background job has its own, the terminal square the strip of live work
 * already uses for a command (a process that runs and wakes the chat), the robot stays the sub-agent's, the rest is the detail's.
 */
export function iconForCall(name: string, detail: ToolCallDetail): LucideIcon {
  return workKindOf(name, detail) === 'background' ? SquareTerminal : iconForDetail(detail);
}
