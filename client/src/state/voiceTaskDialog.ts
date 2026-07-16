import { create } from 'zustand';

interface VoiceTaskDialogState {
  isOpen: boolean;
  transcript: string;
  isListening: boolean;
  lastCreatedTaskId: string | null;
  lastCreatedTaskTitle: string | null;

  // Actions
  open: () => void;
  close: () => void;
  setTranscript: (transcript: string) => void;
  setIsListening: (isListening: boolean) => void;
  clearTranscript: () => void;
  setLastCreatedTask: (taskId: string, title: string) => void;
  clearLastCreatedTask: () => void;
}

export const useVoiceTaskDialog = create<VoiceTaskDialogState>((set) => ({
  isOpen: false,
  transcript: '',
  isListening: false,
  lastCreatedTaskId: null,
  lastCreatedTaskTitle: null,

  open: () => set({ isOpen: true, transcript: '' }),
  close: () => set({ isOpen: false }),
  setTranscript: (transcript) => set({ transcript }),
  setIsListening: (isListening) => set({ isListening }),
  clearTranscript: () => set({ transcript: '' }),
  setLastCreatedTask: (taskId, title) =>
    set({ lastCreatedTaskId: taskId, lastCreatedTaskTitle: title }),
  clearLastCreatedTask: () =>
    set({ lastCreatedTaskId: null, lastCreatedTaskTitle: null }),
}));
