import { useState, useCallback, useEffect } from 'react';
import type { ProjectWindow, WindowType } from '../types/project';
import { createWindowId } from '../types/project';

const STORAGE_KEY = 'topics-project-windows';

interface UseProjectWindowsReturn {
  windows: ProjectWindow[];
  focusedWindowId: string | null;
  openWindow: (type: WindowType, projectPath: string | null, topicId?: string) => string;
  closeWindow: (id: string) => void;
  focusWindow: (id: string) => void;
  getWindowsByProject: (projectPath: string | null) => ProjectWindow[];
  getWindowById: (id: string) => ProjectWindow | undefined;
  updateWindow: (id: string, updates: Partial<ProjectWindow>) => void;
}

// Load saved windows from localStorage
function loadSavedWindows(): ProjectWindow[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

// Save windows to localStorage
function saveWindows(windows: ProjectWindow[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(windows));
  } catch {
    // Ignore storage errors
  }
}

export function useProjectWindows(): UseProjectWindowsReturn {
  const [windows, setWindows] = useState<ProjectWindow[]>(loadSavedWindows);
  const [focusedWindowId, setFocusedWindowId] = useState<string | null>(null);

  // Save to localStorage when windows change
  useEffect(() => {
    saveWindows(windows);
  }, [windows]);

  const openWindow = useCallback((
    type: WindowType,
    projectPath: string | null,
    topicId?: string
  ): string => {
    // For chat windows, check if already open
    if (type === 'chat' && topicId) {
      const existingChat = windows.find(w => w.type === 'chat' && w.topicId === topicId);
      if (existingChat) {
        setFocusedWindowId(existingChat.id);
        return existingChat.id;
      }
    }
    
    // For project-level windows (files, git), check if already open for this project
    if ((type === 'files' || type === 'git') && projectPath) {
      const existing = windows.find(w => w.type === type && w.projectPath === projectPath);
      if (existing) {
        setFocusedWindowId(existing.id);
        return existing.id;
      }
    }

    const id = createWindowId(type, projectPath, topicId);
    const newWindow: ProjectWindow = {
      id,
      type,
      projectPath,
      topicId,
    };

    setWindows(prev => [...prev, newWindow]);
    setFocusedWindowId(id);
    return id;
  }, [windows]);

  const closeWindow = useCallback((id: string) => {
    setWindows(prev => {
      const newWindows = prev.filter(w => w.id !== id);
      
      // If we closed the focused window, focus another
      if (focusedWindowId === id && newWindows.length > 0) {
        setFocusedWindowId(newWindows[newWindows.length - 1].id);
      } else if (newWindows.length === 0) {
        setFocusedWindowId(null);
      }
      
      return newWindows;
    });
  }, [focusedWindowId]);

  const focusWindow = useCallback((id: string) => {
    setFocusedWindowId(id);
  }, []);

  const getWindowsByProject = useCallback((projectPath: string | null): ProjectWindow[] => {
    return windows.filter(w => w.projectPath === projectPath);
  }, [windows]);

  const getWindowById = useCallback((id: string): ProjectWindow | undefined => {
    return windows.find(w => w.id === id);
  }, [windows]);

  const updateWindow = useCallback((id: string, updates: Partial<ProjectWindow>) => {
    setWindows(prev => prev.map(w => 
      w.id === id ? { ...w, ...updates } : w
    ));
  }, []);

  return {
    windows,
    focusedWindowId,
    openWindow,
    closeWindow,
    focusWindow,
    getWindowsByProject,
    getWindowById,
    updateWindow,
  };
}
