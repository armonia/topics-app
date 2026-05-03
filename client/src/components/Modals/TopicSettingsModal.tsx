import { useState, useEffect, useRef } from 'react';
import { X, FolderOpen, GitBranch } from 'lucide-react';
import type { Topic, UpdateTopicRequest, AutonomyLevel, Worktree } from '../../types';
import { TOPIC_ICONS, getTopicIcon, TopicIcon } from '@/lib/topicIcons';
import { worktreesApi } from '../../lib/api';

interface TopicSettingsModalProps {
  topic: Topic;
  isOpen: boolean;
  onClose: () => void;
  onUpdate: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
}

interface ProviderInfo {
  name: string;
  connected: boolean;
  capabilities: string[];
  isDefault: boolean;
}

export function TopicSettingsModal({ topic, isOpen, onClose, onUpdate }: TopicSettingsModalProps) {
  const [projectPath, setProjectPath] = useState(topic.projectPath || '');
  const [autonomyLevel, setAutonomyLevel] = useState<AutonomyLevel>(topic.autonomyLevel || 'ask');
  const [topicName, setTopicName] = useState(topic.name);
  const [topicIcon, setTopicIcon] = useState(topic.icon);
  const [topicColor, setTopicColor] = useState(topic.color);
  const [systemPrompt, setSystemPrompt] = useState(topic.systemPrompt || '');
  const [contextFilesList, setContextFilesList] = useState<string[]>(topic.contextFiles || []);
  const [newContextFile, setNewContextFile] = useState('');
  const [provider, setProvider] = useState<string | null>(topic.provider ?? null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [saved, setSaved] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);
  // Phase A · TOPIC-WT-03: read-only worktree info when topic is bound.
  const [worktree, setWorktree] = useState<Worktree | null>(null);

  // Fetch the bound worktree once per (re)open. The section is hidden
  // entirely when topic.worktreeId is null/unset, so legacy topics see
  // exactly the same UI as before this change.
  useEffect(() => {
    let cancelled = false;
    setWorktree(null);
    if (!isOpen || !topic.worktreeId) return;
    worktreesApi.get(topic.worktreeId)
      .then((wt) => { if (!cancelled) setWorktree(wt); })
      .catch(() => { /* swallow — leave the section hidden if it 404s */ });
    return () => { cancelled = true; };
  }, [isOpen, topic.worktreeId]);

  useEffect(() => {
    setProjectPath(topic.projectPath || '');
    setAutonomyLevel(topic.autonomyLevel || 'ask');
    setTopicName(topic.name);
    setTopicIcon(topic.icon);
    setTopicColor(topic.color);
    setSystemPrompt(topic.systemPrompt || '');
    setContextFilesList(topic.contextFiles || []);
    setNewContextFile('');
    setProvider(topic.provider ?? null);
    setSaved(false);
    setIsDirty(false);
  }, [topic, isOpen]);

  // Fetch available providers
  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/providers')
      .then(r => r.json())
      .then(data => setProviders(data.providers || []))
      .catch(() => setProviders([]));
  }, [isOpen]);

  // Track dirty state
  useEffect(() => {
    if (!isOpen) return;
    const pathChanged = projectPath !== (topic.projectPath || '');
    const autonomyChanged = autonomyLevel !== (topic.autonomyLevel || 'ask');
    const nameChanged = topicName !== topic.name;
    const iconChanged = topicIcon !== topic.icon;
    const colorChanged = topicColor !== topic.color;
    const promptChanged = systemPrompt !== (topic.systemPrompt || '');
    const filesChanged = JSON.stringify(contextFilesList) !== JSON.stringify(topic.contextFiles || []);
    const providerChanged = provider !== (topic.provider ?? null);
    setIsDirty(pathChanged || autonomyChanged || nameChanged || iconChanged || colorChanged || promptChanged || filesChanged || providerChanged);
  }, [projectPath, autonomyLevel, topicName, topicIcon, topicColor, systemPrompt, contextFilesList, provider, topic, isOpen]);

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
      systemPrompt,
      contextFiles: contextFilesList,
      provider,
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
            <TopicIcon name={topic.icon} size={16} color={topic.color || undefined} />
            <h2 className="text-[15px] font-semibold text-app-text">{topic.name} Settings</h2>
          </div>
          <button onClick={handleClose} className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-tertiary hover:text-app-text transition-colors" aria-label="Close settings">
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Name & Icon */}
          <div>
            <label className="block text-[13px] font-medium text-app-text mb-2">
              Name & Icon
            </label>
            <div className="flex gap-2 mb-3">
              <button
                type="button"
                onClick={() => setShowIconPicker(v => !v)}
                className={`w-12 h-10 flex items-center justify-center border rounded-lg transition-colors ${
                  showIconPicker ? 'border-primary bg-primary/10' : 'border-app-border-light bg-surface dark:bg-elevated hover:bg-app-hover'
                }`}
              >
                <TopicIcon name={topicIcon} size={16} color={topicColor || undefined} />
              </button>
              <input
                type="text"
                value={topicName}
                onChange={e => setTopicName(e.target.value)}
                className="flex-1 px-3 py-2 border border-app-border-light rounded-lg text-[13px] bg-surface dark:bg-elevated text-app-text focus:outline-none focus:ring-2 focus:ring-primary transition-colors"
              />
            </div>
            {showIconPicker && (
              <div className="grid grid-cols-6 gap-1 p-3 border border-app-border-light rounded-lg bg-surface dark:bg-elevated">
                {TOPIC_ICONS.map((name) => {
                  const Icon = getTopicIcon(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => { setTopicIcon(name); setShowIconPicker(false); }}
                      className={`w-10 h-10 md:w-8 md:h-8 flex items-center justify-center rounded-lg hover:bg-app-hover transition-colors ${
                        topicIcon === name ? 'bg-primary/10 ring-2 ring-primary/50' : ''
                      }`}
                    >
                      <Icon size={16} style={{ color: topicColor || undefined }} />
                    </button>
                  );
                })}
              </div>
            )}
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
                <FolderOpen size={14} />
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

          {/* Phase A · TOPIC-WT-03: Worktree (read-only) */}
          {worktree && (
            <div>
              <label className="block text-[13px] font-medium text-app-text mb-2">
                <span className="flex items-center gap-1.5">
                  <GitBranch size={14} />
                  Worktree
                </span>
              </label>
              <p className="text-[11px] text-app-text-muted mb-2">
                Topic operations run inside this worktree's isolated branch. To unbind the topic, delete the worktree from the workspace view (the topic falls back to the project path automatically).
              </p>
              <dl className="text-[12px] grid grid-cols-[7rem_1fr] gap-y-1 px-3 py-2 rounded-lg border border-app-border-light bg-app-hover/40">
                <dt className="text-app-text-muted">Name</dt>
                <dd className="text-app-text font-medium">{worktree.name}</dd>
                {worktree.branchName && (
                  <>
                    <dt className="text-app-text-muted">Branch</dt>
                    <dd className="text-app-text font-mono text-[11px]">{worktree.branchName}</dd>
                  </>
                )}
                {worktree.baseRef && (
                  <>
                    <dt className="text-app-text-muted">Base ref</dt>
                    <dd className="text-app-text font-mono text-[11px]">{worktree.baseRef}</dd>
                  </>
                )}
                <dt className="text-app-text-muted">Path</dt>
                <dd className="text-app-text font-mono text-[11px] break-all">{worktree.absPath}</dd>
                <dt className="text-app-text-muted">Status</dt>
                <dd>
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                    worktree.status === 'ready' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' :
                    worktree.status === 'pending' ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400' :
                    'bg-red-500/15 text-red-700 dark:text-red-400'
                  }`}>
                    {worktree.status}
                  </span>
                </dd>
              </dl>
            </div>
          )}

          {/* System Prompt */}
          <div>
            <label className="block text-[13px] font-medium text-app-text mb-2">
              System Prompt
            </label>
            <p className="text-[11px] text-app-text-muted mb-2">
              Custom instructions sent at the start of every conversation in this topic.
            </p>
            <textarea
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              placeholder="Enter a system prompt for this topic..."
              rows={4}
              className="w-full px-3 py-2 border border-app-border-light rounded-lg text-[13px] bg-surface dark:bg-elevated text-app-text placeholder-app-placeholder focus:outline-none focus:ring-2 focus:ring-primary transition-colors resize-y"
              aria-label="System prompt"
            />
          </div>

          {/* Context Files */}
          <div>
            <label className="block text-[13px] font-medium text-app-text mb-2">
              Context Files
            </label>
            <p className="text-[11px] text-app-text-muted mb-2">
              File paths included as context in every conversation.
            </p>
            {contextFilesList.length > 0 && (
              <ul className="space-y-1 mb-2" aria-label="Context files list">
                {contextFilesList.map((file, i) => (
                  <li key={i} className="flex items-center gap-2 text-[12px] text-app-text-secondary bg-app-hover rounded px-2 py-1">
                    <span className="flex-1 truncate">{file}</span>
                    <button
                      onClick={() => setContextFilesList(prev => prev.filter((_, idx) => idx !== i))}
                      className="text-app-text-tertiary hover:text-red-500 transition-colors"
                      aria-label={`Remove ${file}`}
                    >
                      <X size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <input
                type="text"
                value={newContextFile}
                onChange={e => setNewContextFile(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && newContextFile.trim()) {
                    setContextFilesList(prev => [...prev, newContextFile.trim()]);
                    setNewContextFile('');
                  }
                }}
                placeholder="/path/to/file.md"
                className="flex-1 px-3 py-2 border border-app-border-light rounded-lg text-[13px] bg-surface dark:bg-elevated text-app-text placeholder-app-placeholder focus:outline-none focus:ring-2 focus:ring-primary transition-colors"
                aria-label="Add context file"
              />
              <button
                onClick={() => {
                  if (newContextFile.trim()) {
                    setContextFilesList(prev => [...prev, newContextFile.trim()]);
                    setNewContextFile('');
                  }
                }}
                disabled={!newContextFile.trim()}
                className="px-3 py-2 text-[13px] bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Add
              </button>
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

          {/* Provider */}
          <div>
            <label className="block text-[13px] font-medium text-app-text mb-2">
              Provider
            </label>
            <p className="text-[11px] text-app-text-muted mb-2">
              Which AI provider handles conversations in this topic.
            </p>
            <select
              value={provider || ''}
              onChange={e => setProvider(e.target.value || null)}
              className="w-full px-3 py-2 border border-app-border-light rounded-lg text-[13px] bg-surface dark:bg-elevated text-app-text focus:outline-none focus:ring-2 focus:ring-primary transition-colors"
            >
              <option value="">
                Default{providers.find(p => p.isDefault) ? ` (${providers.find(p => p.isDefault)!.name})` : ''}
              </option>
              {providers.map(p => (
                <option key={p.name} value={p.name}>
                  {p.connected ? '\u25CF' : '\u25CB'} {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* Note about Context Inspector */}
          <div className="rounded-lg bg-primary/5 border border-primary/10 px-4 py-3">
            <p className="text-[12px] text-app-text-secondary">
              Memory and advanced context settings are also available in the <strong className="text-app-text">Context Inspector</strong> panel. Click the <span className="inline-flex items-center gap-0.5 px-1 py-0.5 bg-primary/10 rounded text-primary text-[11px] font-medium">Layers</span> button in the header to open it.
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
