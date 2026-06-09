/**
 * Icon map keyed on `ToolCallDetail.type`.
 *
 * Lives in its own module (not ToolCards.tsx) so that the component file can
 * export only components — keeps Vite Fast Refresh happy
 * (react-refresh/only-export-components).
 */

import { Terminal as TerminalIcon, FileText, FilePen, FilePlus, Search, Globe, ListChecks, Bot, Brain, Sparkles, Wrench, type LucideIcon } from 'lucide-react';
import type { ToolCallDetail } from '../../types';

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
    case 'mcp': return Sparkles;
    case 'unknown': return Wrench;
  }
}
