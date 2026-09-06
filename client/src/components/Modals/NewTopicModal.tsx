import { useState, useEffect, useRef } from 'react';
import { X, Loader2, AlertCircle } from 'lucide-react';
import type { CreateTopicRequest, TopicTemplate, Topic, Project, Worktree, WSMessage } from '../../types';
import { TopicIcon, DEFAULT_TOPIC_ICON } from '@/lib/topicIcons';
import { MODAL_BACKDROP, MODAL_PANEL } from '../../lib/modalStyles';
import { useModalDialog } from '../../hooks/useModalDialog';
import { projectsApi, worktreesApi } from '../../lib/api';
import { useWorktrees } from '../../hooks/useWorktrees';
import { Select } from '../Shared/Select';

const TEMPLATES: TopicTemplate[] = [
  {
    name: 'Code Review',
    icon: 'Search',
    color: '#7c3aed',
    systemPrompt: 'You are an expert code reviewer. Focus on code quality, best practices, potential bugs, performance issues, and security concerns. Provide specific, actionable feedback.',
    description: 'Get expert code review feedback',
  },
  {
    name: 'Brainstorming',
    icon: 'Lightbulb',
    color: '#eab308',
    systemPrompt: 'You are a creative brainstorming partner. Help generate ideas, explore possibilities, and think outside the box. Build on ideas and suggest creative combinations.',
    description: 'Generate and explore ideas',
  },
  {
    name: 'Debug Helper',
    icon: 'Bug',
    color: '#dc2626',
    systemPrompt: 'You are a debugging expert. Help identify root causes, suggest debugging strategies, and provide solutions. Ask clarifying questions when needed to narrow down the issue.',
    description: 'Diagnose and fix issues',
  },
  {
    name: 'Writing',
    icon: 'PenLine',
    color: '#059669',
    systemPrompt: 'You are a writing assistant. Help with drafting, editing, and improving text. Focus on clarity, tone, and structure. Suggest improvements while maintaining the author\'s voice.',
    description: 'Draft and improve text',
  },
];

/**
 * Phase A · TOPIC-WT-01 — Worktree picker mode.
 *
 *   default       — "Use project path directly" (legacy / backward-compat)
 *   pick-existing — choose a ready worktree from the list
 *   create-new    — request a new worktree, wait for materialise, then bind
 */
type WorktreeMode = 'default' | 'pick-existing' | 'create-new';

interface NewTopicModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (data: CreateTopicRequest) => Promise<Topic | null>;
  projectPath?: string;
  /**
   * A worktree of `projectPath` to preselect: the dialog opens in
   * `pick-existing` mode with this one chosen. Set by "New topic in this
   * worktree" on a sidebar worktree section; the picker stays the one and
   * only place where the choice can be changed.
   */
  worktreeId?: string;
  /**
   * Pass `useWebSocket().onMessage` for live worktree status updates.
   * Optional — without it the picker still works, but the
   * `pending → ready` flip during create-new requires a manual refresh
   * (currently handled by the hook's polling fallback once added).
   */
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
}

export function NewTopicModal({ isOpen, onClose, onCreate, projectPath, worktreeId, onMessage }: NewTopicModalProps) {
  const [name, setName] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<TopicTemplate | null>(null);
  const [showTemplates, setShowTemplates] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // False once the modal unmounts — lets the waitForReady poll chain bail
  // instead of firing setTimeout for up to 15s against a dead component.
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  // ── Phase A: Worktree picker state ──────────────────────────────────────
  const [project, setProject] = useState<Project | null>(null);
  const [wtMode, setWtMode] = useState<WorktreeMode>('default');
  const [pickedWorktreeId, setPickedWorktreeId] = useState<string>('');
  const [newWtMode, setNewWtMode] = useState<'branch' | 'reuse' | 'detached'>('branch');
  const [newWtBaseRef, setNewWtBaseRef] = useState<string>('main');
  const [newWtName, setNewWtName] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Phase C · TOPIC-IM-01: optional one-shot initial message persisted
  // at create time. The renderer auto-dispatches on first session open.
  const [initialMessage, setInitialMessage] = useState<string>('');

  // The hook keeps the worktree list live via WS; project-scoped when we
  // know the project, no-op when we don't.
  const { ready: readyWorktrees, byId: worktreeById } = useWorktrees({
    projectId: project?.id,
    onMessage,
  });

  useEffect(() => {
    if (isOpen) {
      setName('');
      setSelectedTemplate(null);
      setShowTemplates(true);
      setSubmitError(null);
      setSubmitting(false);
      setInitialMessage('');
      // Opened from a worktree section: that worktree is already the choice.
      setWtMode(worktreeId ? 'pick-existing' : 'default');
      setPickedWorktreeId(worktreeId ?? '');
      setNewWtMode('branch');
      setNewWtBaseRef('main');
      setNewWtName('');
    }
  }, [isOpen, worktreeId]);

  // Resolve the Project record for the projectPath (if any). When a row
  // exists we surface the worktree picker; otherwise the modal behaves
  // exactly like the pre-Phase-A version.
  useEffect(() => {
    let cancelled = false;
    setProject(null);
    if (!isOpen || !projectPath) return;
    projectsApi
      .byPath(projectPath)
      .then((p) => { if (!cancelled) setProject(p); })
      .catch(() => { /* swallow — picker just stays hidden */ });
    return () => { cancelled = true; };
  }, [isOpen, projectPath]);

  /**
   * Wait for a freshly-created worktree to flip out of `pending`. The
   * hook already folds in the `worktree:updated` envelope; we just poll
   * its derived state up to `timeoutMs`.
   */
  function waitForReady(id: string, timeoutMs = 15_000): Promise<Worktree> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (!aliveRef.current) { reject(new Error('Modal closed')); return; }
        const wt = worktreeById(id);
        if (wt && wt.status === 'ready') { resolve(wt); return; }
        if (wt && wt.status === 'error') { reject(new Error(wt.errorMessage || 'Worktree creation failed')); return; }
        if (Date.now() - start >= timeoutMs) {
          reject(new Error('Worktree creation timed out'));
          return;
        }
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  const handleCreate = async () => {
    if (submitting) return;
    setSubmitError(null);
    const finalName = name.trim() || selectedTemplate?.name || 'New Chat';

    let worktreeId: string | undefined;
    try {
      if (project && wtMode === 'pick-existing') {
        if (!pickedWorktreeId) {
          setSubmitError('Pick a worktree to bind, or switch to "Use project path directly".');
          return;
        }
        worktreeId = pickedWorktreeId;
      } else if (project && wtMode === 'create-new') {
        setSubmitting(true);
        const baseRef = newWtBaseRef.trim() || 'main';
        const created = await worktreesApi.create({
          project_id: project.id,
          mode: newWtMode,
          base_ref: baseRef,
          name: newWtName.trim() || undefined,
        });
        const ready = await waitForReady(created.id);
        worktreeId = ready.id;
      }
      // wtMode === 'default' → worktreeId stays undefined → legacy behaviour.

      const trimmedInitial = initialMessage.trim();
      const data: CreateTopicRequest = {
        name: finalName,
        icon: selectedTemplate?.icon || DEFAULT_TOPIC_ICON,
        color: selectedTemplate?.color || '#0066ff',
        systemPrompt: selectedTemplate?.systemPrompt,
        projectPath,
        worktreeId,
        initialMessage: trimmedInitial.length > 0 ? trimmedInitial : undefined,
      };
      const topic = await onCreate(data);
      if (topic) onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create topic';
      setSubmitError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSelectTemplate = (template: TopicTemplate) => {
    setSelectedTemplate(template);
    if (!name.trim()) setName(template.name);
    setShowTemplates(false);
  };

  // Escape chiude, il Tab resta dentro, il focus torna da dove è partito. Sta
  // PRIMA dell'uscita anticipata (regole degli hook) ed è gated su `isOpen`.
  useModalDialog({ open: isOpen, onClose, panelRef, initialFocusRef: inputRef });

  if (!isOpen) return null;

  const showPicker = !!project;
  const hasReadyWorktrees = readyWorktrees.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose} role="presentation">
      <div className={`absolute ${MODAL_BACKDROP}`} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-topic-title"
        className={`relative w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto ${MODAL_PANEL}`}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-app-border">
          <h2 id="new-topic-title" className="text-[15px] font-semibold text-app-text">New Topic</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-tertiary hover:text-app-text transition-colors" aria-label="Close dialog">
            <X size={14} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Topic name */}
          <div>
            <label className="block text-[13px] font-medium text-app-text mb-1.5">
              Topic Name
            </label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !submitting) handleCreate();
                if (e.key === 'Escape') onClose();
              }}
              placeholder="Enter topic name..."
              disabled={submitting}
              className="w-full px-3 py-2 border border-app-border-light rounded-lg text-[13px] bg-surface dark:bg-elevated text-app-text placeholder-app-placeholder focus:outline-none focus:ring-2 focus:ring-primary transition-colors disabled:opacity-60"
            />
          </div>

          {/* Templates */}
          {showTemplates && (
            <div>
              <label className="block text-[13px] font-medium text-app-text mb-2">
                Or start from a template
              </label>
              <div className="grid grid-cols-2 gap-2">
                {TEMPLATES.map(template => (
                  <button
                    key={template.name}
                    onClick={() => handleSelectTemplate(template)}
                    className={`text-left p-3 rounded-lg border transition-colors ${
                      selectedTemplate?.name === template.name
                        ? 'border-primary/50 bg-primary/10'
                        : 'border-app-border-light hover:bg-app-hover'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <TopicIcon name={template.icon} size={16} color={template.color} />
                      <span className="text-[13px] font-medium text-app-text">{template.name}</span>
                    </div>
                    <p className="text-[11px] text-app-text-muted">{template.description}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Selected template info */}
          {selectedTemplate && !showTemplates && (
            <div className="bg-app-hover rounded-lg p-3 border border-app-border-light">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <TopicIcon name={selectedTemplate.icon} size={16} color={selectedTemplate.color} />
                  <span className="text-[13px] font-medium text-app-text">
                    {selectedTemplate.name} Template
                  </span>
                </div>
                <button
                  onClick={() => { setSelectedTemplate(null); setShowTemplates(true); }}
                  className="text-[12px] text-primary hover:text-primary-hover"
                >
                  Change
                </button>
              </div>
              <p className="text-[11px] text-app-text-muted">{selectedTemplate.description}</p>
            </div>
          )}

          {/* Phase A · Worktree picker (conditional on a known Project) */}
          {showPicker && (
            <div className="border-t border-app-border-light pt-4">
              <label className="block text-[13px] font-medium text-app-text mb-2">
                Working tree for this topic
              </label>
              <p className="text-[11px] text-app-text-muted mb-2">
                Topics bound to a worktree run inside an isolated branch. Default keeps the legacy behaviour: the topic uses the project's main directory.
              </p>
              <div className="space-y-2">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="wtMode"
                    value="default"
                    checked={wtMode === 'default'}
                    onChange={() => setWtMode('default')}
                    disabled={submitting}
                    className="mt-0.5"
                  />
                  <span className="text-[12px] text-app-text">Use project path directly</span>
                </label>
                <label className={`flex items-start gap-2 ${hasReadyWorktrees ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}>
                  <input
                    type="radio"
                    name="wtMode"
                    value="pick-existing"
                    checked={wtMode === 'pick-existing'}
                    onChange={() => setWtMode('pick-existing')}
                    disabled={submitting || !hasReadyWorktrees}
                    className="mt-0.5"
                  />
                  <span className="text-[12px] text-app-text">
                    Pick existing worktree
                    {!hasReadyWorktrees && (
                      <span className="ml-2 text-app-text-muted">(none ready)</span>
                    )}
                  </span>
                </label>
                {wtMode === 'pick-existing' && hasReadyWorktrees && (
                  <Select
                    value={pickedWorktreeId}
                    onChange={setPickedWorktreeId}
                    disabled={submitting}
                    ariaLabel="Worktree"
                    className="w-[calc(100%-1.25rem)] ml-5"
                    options={[
                      { value: '', label: 'Choose…' },
                      ...readyWorktrees.map(wt => ({
                        value: wt.id,
                        label: wt.name,
                        hint: wt.branchName ?? undefined,
                      })),
                    ]}
                  />
                )}
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="wtMode"
                    value="create-new"
                    checked={wtMode === 'create-new'}
                    onChange={() => setWtMode('create-new')}
                    disabled={submitting}
                    className="mt-0.5"
                  />
                  <span className="text-[12px] text-app-text">Create new worktree</span>
                </label>
                {wtMode === 'create-new' && (
                  <div className="ml-5 space-y-2 p-2 rounded-md border border-app-border-light bg-app-hover/40">
                    <div className="flex gap-2">
                      <label className="flex items-center gap-1.5 text-[11px] text-app-text">
                        <input
                          type="radio"
                          name="newWtMode"
                          checked={newWtMode === 'branch'}
                          onChange={() => setNewWtMode('branch')}
                          disabled={submitting}
                        />
                        new branch
                      </label>
                      <label className="flex items-center gap-1.5 text-[11px] text-app-text">
                        <input
                          type="radio"
                          name="newWtMode"
                          checked={newWtMode === 'reuse'}
                          onChange={() => setNewWtMode('reuse')}
                          disabled={submitting}
                        />
                        reuse branch
                      </label>
                      <label className="flex items-center gap-1.5 text-[11px] text-app-text">
                        <input
                          type="radio"
                          name="newWtMode"
                          checked={newWtMode === 'detached'}
                          onChange={() => setNewWtMode('detached')}
                          disabled={submitting}
                        />
                        detached
                      </label>
                    </div>
                    <div>
                      <label className="block text-[11px] text-app-text-muted mb-0.5">
                        {newWtMode === 'branch' ? 'Base ref' : newWtMode === 'reuse' ? 'Existing branch' : 'Ref'}
                      </label>
                      <input
                        type="text"
                        value={newWtBaseRef}
                        onChange={e => setNewWtBaseRef(e.target.value)}
                        placeholder="main"
                        disabled={submitting}
                        className="w-full px-2 py-1 text-[12px] border border-app-border-light rounded-md bg-surface dark:bg-elevated text-app-text focus:outline-none focus:ring-2 focus:ring-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-app-text-muted mb-0.5">
                        Name <span className="text-app-text-muted">(auto-generated when blank)</span>
                      </label>
                      <input
                        type="text"
                        value={newWtName}
                        onChange={e => setNewWtName(e.target.value)}
                        placeholder="lyrical-cobra"
                        disabled={submitting}
                        pattern="[a-z][a-z0-9-]*"
                        className="w-full px-2 py-1 text-[12px] border border-app-border-light rounded-md bg-surface dark:bg-elevated text-app-text focus:outline-none focus:ring-2 focus:ring-primary"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Phase C · TOPIC-IM-01: optional one-shot initial message */}
          <div>
            <label className="block text-[13px] font-medium text-app-text mb-1.5">
              Initial message <span className="text-app-text-muted font-normal">(optional)</span>
            </label>
            <p className="text-[11px] text-app-text-muted mb-2">
              Type your first prompt now. It will be queued and delivered as soon as the agent connects, so you don't have to wait.
            </p>
            <textarea
              value={initialMessage}
              onChange={(e) => setInitialMessage(e.target.value)}
              placeholder="What do you want the agent to do first?"
              rows={3}
              maxLength={8000}
              disabled={submitting}
              className="w-full px-3 py-2 border border-app-border-light rounded-lg text-[13px] bg-surface dark:bg-elevated text-app-text placeholder-app-placeholder focus:outline-none focus:ring-2 focus:ring-primary transition-colors resize-y disabled:opacity-60"
            />
          </div>

          {submitError && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-red-500/40 bg-red-500/10 text-[12px] text-red-600 dark:text-red-400">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{submitError}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-app-border">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-[13px] text-app-text-secondary hover:bg-app-hover rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={(!name.trim() && !selectedTemplate) || submitting}
            className="inline-flex items-center gap-2 px-4 py-2 text-[13px] bg-primary text-white rounded-lg hover:bg-primary-hover disabled:bg-app-disabled disabled:text-app-text-muted transition-colors"
          >
            {submitting && <Loader2 size={13} className="animate-spin" />}
            {submitting && wtMode === 'create-new' ? 'Setting up worktree…' : 'Create Topic'}
          </button>
        </div>
      </div>
    </div>
  );
}
