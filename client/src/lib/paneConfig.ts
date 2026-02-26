import type { PaneType } from '../types';

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
};

export function createPaneId(type: PaneType, key?: string): string {
  if (type === 'chat' && key) return `chat:${key}`;
  if (type === 'project' && key) return `project:${encodeURIComponent(key)}`;
  return `${type}:${Date.now()}`;
}

export function parsePaneId(id: string): { type: PaneType; key: string } {
  const [type, ...rest] = id.split(':');
  return { type: type as PaneType, key: rest.join(':') };
}

export function isProjectPaneId(id: string): boolean {
  return id.startsWith('project:');
}

export function getProjectPathFromPaneId(id: string): string | null {
  if (!isProjectPaneId(id)) return null;
  return decodeURIComponent(id.slice('project:'.length));
}

let _groupCounter = 0;
export function createGroupId(): string {
  return `group:${Date.now()}-${++_groupCounter}`;
}
