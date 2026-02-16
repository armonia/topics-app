import { useState, useEffect, useRef } from 'react';
import { X, FolderOpen } from 'lucide-react';
import type { Topic, UpdateTopicRequest, AutonomyLevel } from '../../types';

interface TopicSettingsModalProps {
  topic: Topic;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
}

export function TopicSettingsModal({ topic, isOpen, onClose, onUpdate }: TopicSettingsModalProps) {
  const [projectPath, setProjectPath] = useState(topic.projectPath || '');
  const [autonomyLevel, setAutonomyLevel] = useState<AutonomyLevel>(topic.autonomyLevel || 'ask');
  const [topicName, setTopicName] = useState(topic.name);
  const [topicIcon, setTopicIcon] = useState(topic.icon);
  const [topicColor, setTopicColor] = useState(topic.color);
  const [saved, setSaved] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    setProjectPath(topic.projectPath || '');
    setAutonomyLevel(topic.autonomyLevel || 'ask');
    setTopicName(topic.name);
    setTopicIcon(topic.icon);
    setTopicColor(topic.color);
    setSaved(false);
    setIsDirty(false);
  }, [topic, isOpen]);

  // Track dirty state
  useEffect(() => {
    if (!isOpen) return;
    const pathChanged = projectPath !== (topic.projectPath || '');
    const autonomyChanged = autonomyLevel !== (topic.autonomyLevel || 'ask');
    const nameChanged = topicName !== topic.name;
    const iconChanged = topicIcon !== topic.icon;
    const colorChanged = topicColor !== topic.color;
    setIsDirty(pathChanged || autonomyChanged || nameChanged || iconChanged || colorChanged);
  }, [projectPath, autonomyLevel, topicName, topicIcon, topicColor, topic, isOpen]);

  const handleClose = () => {
    if (isDirty && !window.confirm('You have unsaved changes. Close without saving?')) {
      return;
    }
    onClose();
  };

  const handleSave = async () => {
    await onUpdate(topic.id, {
      name: topicName,
      icon: topicIcon,
      color: topicColor,
      projectPath: projectPath.trim() || undefined,
      autonomyLevel,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleUnlinkProject = async () => {
    setProjectPath('');
    await onUpdate(topic.id, { projectPath: '' });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
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
        className="relative w-full max-w-xl mx-4 bg-surface rounded-xl shadow-2xl border border-app-border-light overflow-hidden max-h-[90vh] sm:max-h-[80vh] flex flex-col focus:outline-none"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-app-border">
          <div className="flex items-center gap-2">
            <span className="text-lg">{topic.icon}</span>
            <h2 className="text-[15px] font-semibold text-app-text">{topic.name} Settings</h2>
          </div>
          <button onClick={handleClose} className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-tertiary hover:text-app-text transition-colors" aria-label="Close settings">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Name & Icon */}
          <div>
            <label className="block text-[13px] font-medium text-app-text mb-2">
              Name & Icon
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={topicIcon}
                onChange={e => setTopicIcon(e.target.value)}
                className="w-12 px-2 py-2 border border-app-border-light rounded-lg text-[16px] text-center bg-surface dark:bg-elevated focus:outline-none focus:ring-2 focus:ring-primary transition-colors"
                maxLength={4}
              />
              <input
                type="text"
                value={topicName}
                onChange={e => setTopicName(e.target.value)}
                className="flex-1 px-3 py-2 border border-app-border-light rounded-lg text-[13px] bg-surface dark:bg-elevated text-app-text focus:outline-none focus:ring-2 focus:ring-primary transition-colors"
              />
            </div>
          </div>

          {/* Color */}
          <div>
            <label className="block text-[13px] font-medium text-app-text mb-2">
              Color
            </label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={topicColor}
                onChange={e => setTopicColor(e.target.value)}
                className="w-8 h-8 rounded border border-app-border-light cursor-pointer"
              />
              <span className="text-[12px] text-app-text-muted">{topicColor}</span>
            </div>
          </div>

          {/* Link Project */}
          <div>
            <label className="block text-[13px] font-medium text-app-text mb-2">
              <span className="flex items-center gap-1.5">
                <FolderOpen size={15} />
                Link Project
              </span>
            </label>
            <p className="text-[11px] text-app-text-muted mb-2">
              Link a local project directory to enable file explorer and git integration.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={projectPath}
                onChange={e => setProjectPath(e.target.value)}
                placeholder="/Users/you/projects/my-project"
                className="flex-1 px-3 py-2 border border-app-border-light rounded-lg text-[13px] bg-surface dark:bg-elevated text-app-text placeholder-app-placeholder focus:outline-none focus:ring-2 focus:ring-primary transition-colors"
              />
              {projectPath && (
                <button
                  onClick={handleUnlinkProject}
                  className="px-3 py-2 text-[13px] text-red-600 hover:bg-red-600/10 rounded-lg border border-red-600/30 transition-colors"
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
                  className="text-[11px] px-2 py-0.5 rounded-full bg-app-hover text-app-text-muted hover:bg-primary/10 hover:text-primary transition-colors"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Autonomy Level */}
          <div>
            <label className="block text-[13px] font-medium text-app-text mb-2">
              Autonomy Level
            </label>
            <p className="text-[11px] text-app-text-muted mb-2">
              Controls how much approval the agent needs before taking actions.
            </p>
            <div className="flex rounded-lg border border-app-border-light overflow-hidden">
              {([
                { value: 'ask' as AutonomyLevel, label: 'Ask', desc: 'Approve each action' },
                { value: 'auto-apply' as AutonomyLevel, label: 'Auto-apply', desc: 'Apply, show results' },
                { value: 'yolo' as AutonomyLevel, label: 'Full Auto', desc: 'Minimal feedback' },
              ]).map(({ value, label, desc }) => (
                <button
                  key={value}
                  onClick={() => setAutonomyLevel(value)}
                  className={`flex-1 px-3 py-2 text-center transition-colors ${
                    autonomyLevel === value
                      ? 'bg-primary text-white'
                      : 'bg-surface dark:bg-elevated text-app-text-secondary hover:bg-app-hover'
                  } ${value !== 'ask' ? 'border-l border-app-border-light' : ''}`}
                >
                  <div className="text-[12px] font-medium">{label}</div>
                  <div className={`text-[10px] mt-0.5 ${autonomyLevel === value ? 'text-white/70' : 'text-app-text-muted'}`}>{desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Note about Context Inspector */}
          <div className="rounded-lg bg-primary/5 border border-primary/10 px-4 py-3">
            <p className="text-[12px] text-app-text-secondary">
              System prompt, context files, and memory are now managed in the <strong className="text-app-text">Context Inspector</strong> panel. Click the <span className="inline-flex items-center gap-0.5 px-1 py-0.5 bg-primary/10 rounded text-primary text-[11px] font-medium">Layers</span> button in the header to open it.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-app-border">
          {saved && (
            <span className="text-emerald-500 text-[13px] mr-auto">Saved</span>
          )}
          <button
            onClick={handleClose}
            className="px-4 py-2 text-[13px] text-app-text-secondary hover:bg-app-hover rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!isDirty}
            className="px-4 py-2 text-[13px] bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
