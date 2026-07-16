import { X, CheckCircle } from 'lucide-react';
import { useVoiceTaskDialog } from '../../state/voiceTaskDialog';

export function VoiceTaskStatusBar() {
  const { lastCreatedTaskId, lastCreatedTaskTitle, clearLastCreatedTask } =
    useVoiceTaskDialog();

  if (!lastCreatedTaskId) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 max-w-lg mx-auto bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700 rounded-lg shadow-lg px-4 py-3 flex items-center justify-between z-40">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <CheckCircle size={18} className="text-green-600 dark:text-green-400 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[12px] font-medium text-green-700 dark:text-green-300 truncate">
            Task #{lastCreatedTaskId} created: <span className="font-semibold">{lastCreatedTaskTitle}</span>
          </p>
          <p className="text-[11px] text-green-600 dark:text-green-400">Agent active</p>
        </div>
      </div>
      <button
        onClick={clearLastCreatedTask}
        className="ml-2 p-1 text-green-600 hover:text-green-700 hover:bg-green-100 dark:hover:bg-green-800/50 dark:text-green-400 rounded transition-colors flex-shrink-0"
        title="Dismiss"
      >
        <X size={16} />
      </button>
    </div>
  );
}
