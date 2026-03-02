import { useState, useEffect, useRef } from 'react';
import { X, Save, Brain, Globe, MessageSquare, Trash2 } from 'lucide-react';
import { useMemory } from '../../hooks/useMemory';

interface MemoryPanelProps {
  topicId: string;
  topicName: string;
  isOpen: boolean;
  onClose: () => void;
  onMessage?: (handler: (msg: any) => void) => () => void;
}

export function MemoryPanel({ topicId, topicName, isOpen, onClose, onMessage }: MemoryPanelProps) {
  const { topicMemory, globalMemory, loading, saving, error, saveTopicMemory, saveGlobalMemory, clearTopicMemory, clearGlobalMemory } = useMemory(topicId, { onMessage });
  const [activeTab, setActiveTab] = useState<'topic' | 'global'>('topic');
  const [editedTopic, setEditedTopic] = useState('');
  const [editedGlobal, setEditedGlobal] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEditedTopic(topicMemory);
    setEditedGlobal(globalMemory);
    setIsDirty(false);
  }, [topicMemory, globalMemory]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => dialogRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    const topicChanged = editedTopic !== topicMemory;
    const globalChanged = editedGlobal !== globalMemory;
    setIsDirty(topicChanged || globalChanged);
  }, [editedTopic, editedGlobal, topicMemory, globalMemory]);

  const handleSave = async () => {
    if (activeTab === 'topic') {
      await saveTopicMemory(editedTopic);
    } else {
      await saveGlobalMemory(editedGlobal);
    }
    setSaved(true);
    setIsDirty(false);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleClose = () => {
    if (isDirty && !window.confirm('You have unsaved changes. Close without saving?')) {
      return;
    }
    onClose();
  };

  const handleClear = async () => {
    const label = activeTab === 'topic' ? `"${topicName}" topic` : 'global';
    if (!window.confirm(`Clear all ${label} memory? This cannot be undone.`)) return;
    if (activeTab === 'topic') {
      await clearTopicMemory();
      setEditedTopic('');
    } else {
      await clearGlobalMemory();
      setEditedGlobal('');
    }
    setIsDirty(false);
  };

  const currentContent = activeTab === 'topic' ? editedTopic : editedGlobal;
  const setCurrentContent = activeTab === 'topic' ? setEditedTopic : setEditedGlobal;
  const charCount = currentContent.length;
  const tokenEstimate = Math.round(charCount / 4);
  const maxBytes = activeTab === 'topic' ? 10 * 1024 : 50 * 1024;
  const usagePercent = Math.round((new TextEncoder().encode(currentContent).length / maxBytes) * 100);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={handleClose} role="dialog" aria-modal="true" aria-label="Memory Panel">
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative w-full max-w-xl mx-4 bg-surface rounded-xl shadow-2xl border border-app-border-light overflow-hidden max-h-[90vh] sm:max-h-[80vh] flex flex-col focus:outline-none"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-app-border">
          <div className="flex items-center gap-2">
            <Brain size={16} className="text-purple-500" />
            <h2 className="text-[15px] font-semibold text-app-text">Memory</h2>
          </div>
          <button onClick={handleClose} className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-tertiary hover:text-app-text transition-colors" aria-label="Close">
            <X size={14} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-app-border px-5">
          <button
            onClick={() => setActiveTab('topic')}
            className={`flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors relative ${
              activeTab === 'topic' ? 'text-primary' : 'text-app-text-tertiary hover:text-app-text'
            }`}
          >
            <MessageSquare size={14} />
            <span>{topicName}</span>
            {activeTab === 'topic' && <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary rounded-t" />}
          </button>
          <button
            onClick={() => setActiveTab('global')}
            className={`flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors relative ${
              activeTab === 'global' ? 'text-primary' : 'text-app-text-tertiary hover:text-app-text'
            }`}
          >
            <Globe size={14} />
            <span>Global</span>
            {activeTab === 'global' && <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary rounded-t" />}
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-4 h-4 border-2 border-app-spinner border-t-primary rounded-full animate-spin" />
            </div>
          ) : (
            <div>
              <p className="text-[11px] text-app-text-muted mb-3">
                {activeTab === 'topic'
                  ? 'Notes and instructions specific to this topic. Included as context in every message.'
                  : 'Notes and instructions shared across all topics. Included as context in every message.'}
              </p>
              <textarea
                value={currentContent}
                onChange={e => setCurrentContent(e.target.value)}
                placeholder={activeTab === 'topic'
                  ? 'e.g. "User prefers TypeScript. Always use functional components. Project uses Tailwind v4."'
                  : 'e.g. "Respond concisely. Use markdown formatting. Prefer Bun over Node."'}
                className="w-full px-3 py-2 border border-app-border-light rounded-lg text-[13px] bg-surface dark:bg-elevated text-app-text placeholder-app-placeholder focus:outline-none focus:ring-2 focus:ring-primary resize-y min-h-[200px] font-mono transition-colors"
                rows={10}
              />
              <div className="flex items-center justify-between mt-2">
                <span className={`text-[11px] ${usagePercent > 90 ? 'text-red-500' : 'text-app-text-muted'}`}>
                  {charCount} chars / ~{tokenEstimate} tokens ({usagePercent}% of {maxBytes / 1024}KB limit)
                </span>
                {error && <span className="text-[11px] text-red-500">{error}</span>}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-app-border">
          {saved && <span className="text-emerald-500 text-[13px] mr-auto flex items-center gap-1"><Save size={14} /> Saved</span>}
          <button
            onClick={handleClear}
            disabled={saving || !currentContent}
            className="px-3 py-2 text-[13px] text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 mr-auto"
          >
            <Trash2 size={14} />
            Clear
          </button>
          <button
            onClick={handleClose}
            className="px-4 py-2 text-[13px] text-app-text-secondary hover:bg-app-hover rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!isDirty || saving}
            className="px-4 py-2 text-[13px] bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            <Save size={14} />
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
