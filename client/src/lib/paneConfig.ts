import type { PaneType } from '../types';
import { generateUUID } from '../utils/uuid';

export interface PaneConfig {
  icon: string;      // Lucide icon name
  label: string;
  color: string;     // Accent color
  singleton?: boolean; // Only one instance allowed per project
  fixed?: boolean;     // Cannot be added/removed via + menu (structural pane)
}

export const PANE_CONFIG: Record<PaneType, PaneConfig> = {
  chat:          { icon: 'MessageSquare', label: 'Chat',         color: '#0066ff' },
  file:          { icon: 'FileCode',      label: 'File',         color: '#f59e0b' },
  files:         { icon: 'FolderTree',    label: 'Files',        color: '#f59e0b', singleton: true },
  browser:       { icon: 'Globe',         label: 'Browser',      color: '#10b981' },
  terminal:      { icon: 'Terminal',      label: 'Terminal',     color: '#8b5cf6' },
  git:           { icon: 'GitBranch',     label: 'Git',          color: '#ef4444', singleton: true },
  activity:      { icon: 'Activity',      label: 'Activity',     color: '#06b6d4', singleton: true },
  journal:       { icon: 'BookOpen',      label: 'Journal',      color: '#f97316', singleton: true },
  agents:        { icon: 'Cpu',           label: 'Agents',       color: '#8b5cf6', singleton: true },
  board:         { icon: 'Kanban',        label: 'Board',        color: '#10b981', singleton: true },
  'board-memory':{ icon: 'Brain',         label: 'Board Memory', color: '#10b981', singleton: true },
  dashboard:     { icon: 'BarChart3',     label: 'Dashboard',    color: '#f59e0b', singleton: true },
  'all-boards':  { icon: 'LayoutGrid',   label: 'Board',         color: '#10b981', singleton: true },
  project:       { icon: 'FolderOpen',   label: 'Project',       color: '#10b981', singleton: false },
  'process-log':    { icon: 'Terminal',     label: 'Process',       color: '#8b5cf6' },
  'session-viewer': { icon: 'Eye',          label: 'Session',       color: '#8b5cf6' },
};

export function createPaneId(type: PaneType, key?: string): string {
  if (type === 'chat' && key) return `chat:${key}`;
  if (type === 'project' && key) return `project:${encodeURIComponent(key)}`;
  if (type === 'browser' && key) return `browser:${key}`;
  if (type === 'terminal' && key) return `terminal:${key}`;
  if (type === 'session-viewer' && key) return `session-viewer:${key}`;
  return `${type}:${crypto.randomUUID()}`;
}

export function parsePaneId(id: string): { type: PaneType; key: string } {
  const [type, ...rest] = id.split(':');
  return { type: type as PaneType, key: rest.join(':') };
}

export function isProjectPaneId(id: string): boolean {
  return id.startsWith('project:');
}

export function isBrowserPaneId(id: string): boolean {
  return id.startsWith('browser:');
}

export function isTerminalPaneId(id: string): boolean {
  return id.startsWith('terminal:');
}

export function getBrowserContextFromPaneId(id: string): string | null {
  if (!isBrowserPaneId(id)) return null;
  return id.slice('browser:'.length);
}

export function getTerminalSessionFromPaneId(id: string): string | null {
  if (!isTerminalPaneId(id)) return null;
  return id.slice('terminal:'.length);
}

export function getProjectPathFromPaneId(id: string): string | null {
  if (!isProjectPaneId(id)) return null;
  return decodeURIComponent(id.slice('project:'.length));
}

export function isSessionViewerPaneId(id: string): boolean {
  return id.startsWith('session-viewer:');
}

export function getSessionKeyFromViewerPaneId(id: string): string | null {
  if (!isSessionViewerPaneId(id)) return null;
  return id.slice('session-viewer:'.length);
}

export function isDraftPaneId(id: string): boolean {
  return id.startsWith('draft:');
}

export function createDraftPaneId(): string {
  return `draft:${generateUUID()}`;
}

const KNOWN_PANE_PREFIXES = ['project:', 'browser:', 'terminal:', 'draft:', 'chat:', 'session-viewer:', 'process-log:', '__'];

export function isKnownPanePrefix(id: string): boolean {
  return KNOWN_PANE_PREFIXES.some(prefix => id.startsWith(prefix));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUUIDLike(id: string): boolean {
  return UUID_RE.test(id);
}

let _groupCounter = 0;
export function createGroupId(): string {
  return `group:${Date.now()}-${++_groupCounter}`;
}
