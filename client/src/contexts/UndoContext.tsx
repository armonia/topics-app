/**
 * Global UI undo/redo system (Blender-style).
 * Module singleton — no React context needed, works across any component.
 */

export interface UndoAction {
  description: string;
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
}

const MAX_STACK_SIZE = 30;

const undoStack: UndoAction[] = [];
const redoStack: UndoAction[] = [];

/** Push a new undoable action. Clears the redo stack. */
export function pushUndo(action: UndoAction) {
  undoStack.push(action);
  if (undoStack.length > MAX_STACK_SIZE) undoStack.shift();
  redoStack.length = 0;
}

/** Undo the most recent action. */
export async function undo(): Promise<boolean> {
  const action = undoStack.pop();
  if (!action) return false;
  await action.undo();
  redoStack.push(action);
  return true;
}

/** Redo the most recently undone action. */
export async function redo(): Promise<boolean> {
  const action = redoStack.pop();
  if (!action) return false;
  await action.redo();
  undoStack.push(action);
  return true;
}

export function canUndo(): boolean { return undoStack.length > 0; }
export function canRedo(): boolean { return redoStack.length > 0; }

/**
 * Check if an element is a text input where typing-adjacent shortcuts
 * (Cmd+Z undo, Cmd+F find, …) should be handled by the browser/component,
 * not by our global handlers.
 */
export function isTextInputFocused(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (target.isContentEditable) return true;
  // xterm.js terminal containers. When a terminal owns the keyboard, focus
  // sits on its hidden `.xterm-helper-textarea` — a TEXTAREA inside `.xterm`,
  // so the tag check above already catches it; the closest() checks keep us
  // covered if xterm ever moves focus to a non-textarea node (canvas/a11y
  // tree) in a future version.
  if (target.closest('.xterm')) return true;
  if (target.classList.contains('xterm-helper-textarea')) return true;
  // CodeMirror editors
  if (target.closest('.cm-editor')) return true;
  return false;
}
