import { useState, useEffect, useRef } from 'react';
import { X, Upload, Trash2, FileText, FolderOpen } from 'lucide-react';
import type { Topic, UpdateTopicRequest } from '../../types';
import { uploadApi } from '../../lib/api';

interface TopicSettingsModalProps {
  topic: Topic;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
}

export function TopicSettingsModal({ topic, isOpen, onClose, onUpdate }: TopicSettingsModalProps) {
  const [systemPrompt, setSystemPrompt] = useState(topic.systemPrompt || '');
  const [contextFiles, setContextFiles] = useState<string[]>(topic.contextFiles || []);
  const [projectPath, setProjectPath] = useState(topic.projectPath || '');
  const [uploading, setUploading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSystemPrompt(topic.systemPrompt || '');
    setContextFiles(topic.contextFiles || []);
    setProjectPath(topic.projectPath || '');
    setSaved(false);
    setIsDirty(false);
  }, [topic, isOpen]);

  // Track dirty state
  useEffect(() => {
    if (!isOpen) return;
    const promptChanged = systemPrompt !== (topic.systemPrompt || '');
    const pathChanged = projectPath !== (topic.projectPath || '');
    const filesChanged = JSON.stringify(contextFiles) !== JSON.stringify(topic.contextFiles || []);
    setIsDirty(promptChanged || pathChanged || filesChanged);
  }, [systemPrompt, projectPath, contextFiles, topic, isOpen]);

  const handleClose = () => {
    if (isDirty && !window.confirm('You have unsaved changes. Close without saving?')) {
      return;
    }
    onClose();
  };

  const handleSave = async () => {
    await onUpdate(topic.id, {
      systemPrompt,
      contextFiles,
      projectPath: projectPath.trim() || undefined,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleUnlinkProject = async () => {
    setProjectPath('');
    await onUpdate(topic.id, {
      systemPrompt,
      contextFiles,
      projectPath: '',
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    
    setUploading(true);
    try {
      for (const file of files) {
        const result = await uploadApi.uploadContextFile(file, topic.id);
        setContextFiles(prev => [...prev, result.path]);
      }
    } catch (err) {
      console.error('Upload failed:', err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemoveFile = async (filePath: string) => {
    try {
      await uploadApi.deleteContextFile(topic.id, filePath);
      setContextFiles(prev => prev.filter(f => f !== filePath));
    } catch (err) {
      console.error('Failed to remove file:', err);
    }
  };

  // Common project paths suggestions
  const commonPaths = [
    '~/Projects/',
    '~/Sites/',
    '~/Developer/',
    '~/Code/',
    '~/.openclaw/workspace/',
  ];

  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus the dialog when it opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => dialogRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={handleClose} role="dialog" aria-modal="true" aria-label={`${topic.name} Settings`}>
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative w-full max-w-xl mx-4 bg-white dark:bg-[#1e1e1e] rounded-xl shadow-2xl border border-[#e0e0e0] dark:border-[#333] overflow-hidden max-h-[90vh] sm:max-h-[80vh] flex flex-col focus:outline-none"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#e8e8e8] dark:border-[#2a2a2a]">
          <div className="flex items-center gap-2">
            <span className="text-lg">{topic.icon}</span>
            <h2 className="text-[15px] font-semibold text-[#1a1a1a] dark:text-[#e5e5e5]">{topic.name} Settings</h2>
          </div>
          <button onClick={handleClose} className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-[#8b8b8b] hover:text-[#555] dark:hover:text-[#ccc] transition-colors" aria-label="Close settings">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Link Project */}
          <div>
            <label className="block text-[13px] font-medium text-[#333] dark:text-[#ccc] mb-2">
              <span className="flex items-center gap-1.5">
                <FolderOpen size={15} />
                Link Project
              </span>
            </label>
            <p className="text-[11px] text-[#888] dark:text-[#666] mb-2">
              Link a local project directory to enable file explorer and git integration.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={projectPath}
                onChange={e => setProjectPath(e.target.value)}
                placeholder="/Users/you/projects/my-project"
                className="flex-1 px-3 py-2 border border-[#e0e0e0] dark:border-[#333] rounded-lg text-[13px] bg-white dark:bg-[#222] text-[#1a1a1a] dark:text-[#e5e5e5] placeholder-[#aaa] dark:placeholder-[#666] focus:outline-none focus:ring-2 focus:ring-[var(--primary)] transition-colors"
              />
              {projectPath && (
                <button
                  onClick={handleUnlinkProject}
                  className="px-3 py-2 text-[13px] text-[#dc2626] hover:bg-[#dc2626]/10 rounded-lg border border-[#dc2626]/30 transition-colors"
                >
                  Unlink
                </button>
              )}
            </div>
            {/* Quick path suggestions */}
            <div className="flex flex-wrap gap-1 mt-2">
              {commonPaths.map(p => (
                <button
                  key={p}
                  onClick={() => setProjectPath(p)}
                  className="text-[11px] px-2 py-0.5 rounded-full bg-[#f5f5f5] dark:bg-[#2a2a2a] text-[#888] dark:text-[#666] hover:bg-[var(--primary)]/10 hover:text-[var(--primary)] transition-colors"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* System Prompt */}
          <div>
            <label className="block text-[13px] font-medium text-[#333] dark:text-[#ccc] mb-2">
              System Prompt
            </label>
            <p className="text-[11px] text-[#888] dark:text-[#666] mb-2">
              Custom instructions sent as system message. Shapes how the AI responds in this topic.
            </p>
            <textarea
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              placeholder="e.g. You are a code review expert. Focus on code quality, best practices, and potential bugs..."
              className="w-full px-3 py-2 border border-[#e0e0e0] dark:border-[#333] rounded-lg text-[13px] bg-white dark:bg-[#222] text-[#1a1a1a] dark:text-[#e5e5e5] placeholder-[#aaa] dark:placeholder-[#666] focus:outline-none focus:ring-2 focus:ring-[var(--primary)] resize-y min-h-[100px] transition-colors"
              rows={4}
            />
          </div>

          {/* Context Files */}
          <div>
            <label className="block text-[13px] font-medium text-[#333] dark:text-[#ccc] mb-2">
              Context Files
            </label>
            <p className="text-[11px] text-[#888] dark:text-[#666] mb-2">
              Files included as context in every message. Great for reference docs, code, specs.
            </p>
            
            {contextFiles.length > 0 && (
              <div className="space-y-1.5 mb-3">
                {contextFiles.map((filePath, i) => (
                  <div key={i} className="flex items-center gap-2 bg-[#f5f5f5] dark:bg-[#222] rounded-lg px-3 py-2 text-[13px] border border-[#e0e0e0] dark:border-[#333]">
                    <FileText size={14} className="text-[#8b8b8b] flex-shrink-0" />
                    <span className="flex-1 truncate text-[#444] dark:text-[#ccc]">
                      {filePath.split('/').pop()}
                    </span>
                    <button
                      onClick={() => handleRemoveFile(filePath)}
                      className="p-1 hover:bg-[#dc2626]/10 rounded text-[#dc2626]"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleUploadFile}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="flex items-center gap-2 px-3 py-2 border border-dashed border-[#ccc] dark:border-[#444] rounded-lg text-[13px] text-[#666] dark:text-[#999] hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a] transition-colors"
            >
              <Upload size={14} />
              {uploading ? 'Uploading...' : 'Add context file'}
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-[#e8e8e8] dark:border-[#2a2a2a]">
          {saved && (
            <span className="text-[#22c55e] text-[13px] mr-auto">✓ Saved</span>
          )}
          <button
            onClick={handleClose}
            className="px-4 py-2 text-[13px] text-[#666] dark:text-[#999] hover:bg-[#f5f5f5] dark:hover:bg-[#2a2a2a] rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-[13px] bg-[var(--primary)] text-white rounded-lg hover:bg-[#0055dd] transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
