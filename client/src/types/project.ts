// Project-centric window types

export type WindowType = 'chat' | 'files' | 'browser' | 'terminal' | 'git';

export interface ProjectWindow {
  id: string;                    // Unique window ID
  type: WindowType;              // Type of window
  projectPath: string | null;    // Associated project (null = global)
  topicId?: string;              // For chat windows, which topic
  title?: string;                // Custom title
  url?: string;                  // For browser windows, current URL
}

export interface ProjectWindowState {
  windows: ProjectWindow[];      // All open windows
  focusedWindowId: string | null;
  layout: WindowLayout;
}

export interface WindowLayout {
  // Flexible layout: can be split horizontally or vertically
  type: 'single' | 'hsplit' | 'vsplit';
  windows?: string[];            // Window IDs if single row
  children?: WindowLayout[];     // Nested layouts if split
  sizes?: number[];              // Relative sizes (0-1) for splits
}

// Helper to create window IDs
export function createWindowId(type: WindowType, projectPath: string | null, topicId?: string): string {
  if (type === 'chat' && topicId) {
    return `chat:${topicId}`;
  }
  const projectKey = projectPath ? projectPath.replace(/[^a-zA-Z0-9]/g, '-') : 'global';
  return `${type}:${projectKey}:${Date.now()}`;
}

// Parse window ID to get type
export function parseWindowId(id: string): { type: WindowType; key: string } {
  const [type, ...rest] = id.split(':');
  return { type: type as WindowType, key: rest.join(':') };
}

// Window icons and labels
export const WINDOW_CONFIG: Record<WindowType, { icon: string; label: string; color: string }> = {
  chat: { icon: 'MessageSquare', label: 'Chat', color: '#0066ff' },
  files: { icon: 'FolderTree', label: 'Files', color: '#f59e0b' },
  browser: { icon: 'Globe', label: 'Browser', color: '#10b981' },
  terminal: { icon: 'Terminal', label: 'Terminal', color: '#8b5cf6' },
  git: { icon: 'GitBranch', label: 'Git', color: '#ef4444' },
};
