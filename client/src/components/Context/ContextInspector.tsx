import { useState, useEffect, useCallback, useRef } from 'react';
import { X, RefreshCw, ChevronLeft, FileText, FolderOpen, Upload, Trash2 } from 'lucide-react';
import type { Topic, UpdateTopicRequest, WSMessage } from '../../types';
import { useContextInspector } from '../../hooks/useContextInspector';
import { useOpenClawContext } from '../../hooks/useOpenClawContext';
import { useMemory } from '../../hooks/useMemory';
import { uploadApi, type MemoryTreeNode } from '../../lib/api';
import { ContextBudgetBar } from './ContextBudgetBar';
import { ContextWarnings } from './ContextWarnings';
import { ContextSourceRow } from './ContextSourceRow';
import { ContextEnvelopeView } from './ContextEnvelopeView';
import { useToast } from '../Shared/Toast';
import { Spinner } from '../Shared/Spinner';

/** Extract a human-readable message from an unknown thrown value. */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

interface ContextInspectorProps {
  topic: Topic;
  isOpen: boolean;
  onClose: () => void;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  onMessage?: (handler: (msg: WSMessage) => void) => () => void;
  onOpenFile?: (path: string) => void;
}

export function ContextInspector({ topic, isOpen, onClose, onUpdateTopic, onMessage, onOpenFile }: ContextInspectorProps) {
  // Keep the latest topic in a ref so stable callbacks (handleToggleSource) read
  // current values without listing `topic` in their deps. Synced in an effect to
  // avoid mutating a ref during render.
  const topicRef = useRef(topic);
  useEffect(() => {
    topicRef.current = topic;
  }, [topic]);

  const { sources, totalTokens, budgetLimit, budgetPercent, warnings, loading, reload } = useContextInspector(topic.id, onMessage);
  const { data: openclawData } = useOpenClawContext();
  const { saveTopicMemory, saveGlobalMemory } = useMemory(topic.id, { onMessage });
  const toast = useToast();

  const [browsingMemoryTree, setBrowsingMemoryTree] = useState(false);

  // Re-analyze when topic changes
  useEffect(() => {
    if (isOpen) reload();
  }, [topic.id, isOpen, reload]);

  const handleToggleSource = useCallback(async (sourceId: string, enabled: boolean) => {
    const current = topicRef.current.disabledContextSources || [];
    let newDisabled: string[];
    if (enabled) {
      newDisabled = current.filter(id => id !== sourceId);
    } else {
      newDisabled = [...current, sourceId];
    }
    await onUpdateTopic(topicRef.current.id, { disabledContextSources: newDisabled });
    // Reload analysis after toggle
    setTimeout(reload, 300);
  }, [onUpdateTopic, reload]);

  const handleEditSource = useCallback(async (sourceId: string, content: string) => {
    if (sourceId === 'memory:topic') {
      await saveTopicMemory(content);
    } else if (sourceId === 'memory:global') {
      await saveGlobalMemory(content);
    } else if (sourceId === 'prompt:system') {
      await onUpdateTopic(topic.id, { systemPrompt: content });
    }
    setTimeout(reload, 300);
  }, [topic.id, saveTopicMemory, saveGlobalMemory, onUpdateTopic, reload]);

  const handleBrowseMemory = useCallback(() => {
    setBrowsingMemoryTree(true);
  }, []);

  const handleOpenMemoryFile = useCallback((path: string) => {
    if (onOpenFile && openclawData?.workspacePath) {
      onOpenFile(`${openclawData.workspacePath}/${path}`);
    }
  }, [onOpenFile, openclawData?.workspacePath]);

  const handleUploadContextFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const files = Array.from(input.files || []);
    if (files.length === 0) return;
    try {
      for (const file of files) {
        await uploadApi.uploadContextFile(file, topic.id);
      }
      reload();
    } catch (err) {
      toast.error(errMessage(err) || 'Failed to upload context file');
    } finally {
      input.value = '';
    }
  }, [topic.id, reload, toast]);

  const handleRemoveContextFile = useCallback(async (filePath: string) => {
    try {
      await uploadApi.deleteContextFile(topic.id, filePath);
      reload();
    } catch (err) {
      toast.error(errMessage(err) || 'Failed to remove context file');
    }
  }, [topic.id, reload, toast]);

  if (!isOpen) return null;

  // Group sources by category
  const openclawSources = sources.filter(s => s.category === 'openclaw');
  const memorySources = sources.filter(s => s.category === 'memory');
  const promptSources = sources.filter(s => s.category === 'prompt');
  const templateSources = sources.filter(s => s.category === 'template');
  const fileSources = sources.filter(s => s.category === 'file');
  const pinnedSources = sources.filter(s => s.category === 'pinned');

  const renderSourceGroup = (groupSources: typeof sources) => {
    if (groupSources.length === 0) return null;
    return (
      <div>
        {groupSources.map(source => (
          <ContextSourceRow
            key={source.id}
            source={source}
            onToggle={source.category === 'template' ? undefined : handleToggleSource}
            onEdit={source.editable ? handleEditSource : undefined}
            onBrowseMemory={source.id === 'openclaw:memory-tree' ? handleBrowseMemory : undefined}
          />
        ))}
      </div>
    );
  };

  // Memory tree browser view
  if (browsingMemoryTree) {
    const memoryIndex = openclawData?.memoryIndex || [];

    const renderTree = (nodes: MemoryTreeNode[], depth = 0) => (
      <div style={{ paddingLeft: depth > 0 ? 12 : 0 }}>
        {nodes.map(node => (
          <div key={node.path}>
            {node.type === 'dir' ? (
              <div>
                <div className="flex items-center gap-1.5 py-1 px-2 text-[12px] text-app-text hover:bg-app-hover rounded cursor-default">
                  <FolderOpen size={12} className="text-app-text-tertiary" />
                  <span className="font-medium">{node.name}</span>
                </div>
                {node.children && renderTree(node.children, depth + 1)}
              </div>
            ) : (
              <button
                onClick={() => handleOpenMemoryFile(node.path)}
                className="w-full flex items-center gap-1.5 py-1 px-2 text-[12px] text-app-text-secondary hover:bg-app-hover hover:text-app-text rounded transition-colors text-left"
              >
                <FileText size={12} className="text-app-text-tertiary flex-shrink-0" />
                <span className="truncate flex-1">{node.name}</span>
                {node.tokens !== undefined && (
                  <span className="text-[11px] text-app-text-muted flex-shrink-0">~{node.tokens} tok</span>
                )}
              </button>
            )}
          </div>
        ))}
      </div>
    );

    return (
      <div className="flex flex-col h-full bg-surface border-l border-app-border">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-app-border flex-shrink-0">
          <button
            onClick={() => setBrowsingMemoryTree(false)}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-[13px] font-medium text-app-text truncate">
            OpenClaw Memory Tree
          </span>
          <div className="flex-1" />
          <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary">
            <X size={14} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3">
          {memoryIndex.length > 0 ? renderTree(memoryIndex) : (
            <div className="text-[12px] text-app-text-muted text-center py-8">No memory files found</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="context-inspector" className="flex flex-col h-full bg-surface border-l border-app-border">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-app-border flex-shrink-0">
        <span className="text-[13px] font-medium text-app-text">Context Inspector</span>
        <div className="flex-1" />
        <button
          onClick={reload}
          disabled={loading}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary transition-colors"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary"
        >
          <X size={14} />
        </button>
      </div>

      {/* Budget bar */}
      <ContextBudgetBar
        sources={sources}
        totalTokens={totalTokens}
        budgetLimit={budgetLimit}
        budgetPercent={budgetPercent}
      />

      {/* Warnings */}
      <ContextWarnings warnings={warnings} />

      {/* Sources list */}
      <div className="flex-1 overflow-y-auto">
        {loading && sources.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Spinner size="md" />
          </div>
        ) : (
          <div>
            {/* OpenClaw Base Context */}
            {openclawSources.length > 0 && (
              <div>
                <div className="px-4 py-1.5 text-[11px] font-semibold text-app-text-tertiary uppercase tracking-wider bg-black/2 dark:bg-white/2">
                  OpenClaw Base Context
                </div>
                {renderSourceGroup(openclawSources)}
              </div>
            )}

            {/* Memory */}
            <div>
              <div className="px-4 py-1.5 text-[11px] font-semibold text-app-text-tertiary uppercase tracking-wider bg-black/2 dark:bg-white/2">
                Memory
              </div>
              {memorySources.length > 0 ? (
                renderSourceGroup(memorySources)
              ) : (
                <div className="px-4 py-2 text-[11px] text-app-text-muted italic">No memory content yet</div>
              )}
            </div>

            {/* System Prompt */}
            <div>
              <div className="px-4 py-1.5 text-[11px] font-semibold text-app-text-tertiary uppercase tracking-wider bg-black/2 dark:bg-white/2">
                System Prompt
              </div>
              {promptSources.length > 0 ? (
                renderSourceGroup(promptSources)
              ) : (
                <div className="px-4 py-2 text-[11px] text-app-text-muted italic">No system prompt set</div>
              )}
            </div>

            {/* Context Templates */}
            {topic.projectPath && (
              <div>
                <div className="px-4 py-1.5 text-[11px] font-semibold text-app-text-tertiary uppercase tracking-wider bg-black/2 dark:bg-white/2">
                  Context Templates
                </div>
                {templateSources.length > 0 ? (
                  renderSourceGroup(templateSources)
                ) : (
                  <div className="px-4 py-2 text-[11px] text-app-text-muted italic">No template files found in project</div>
                )}
              </div>
            )}

            {/* Context Files */}
            <div>
              <div className="px-4 py-1.5 text-[11px] font-semibold text-app-text-tertiary uppercase tracking-wider bg-black/2 dark:bg-white/2 flex items-center">
                <span className="flex-1">Context Files</span>
                <label className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-primary hover:bg-primary/10 cursor-pointer transition-colors">
                  <Upload size={10} />
                  <span>Add</span>
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    onChange={handleUploadContextFile}
                  />
                </label>
              </div>
              {fileSources.length > 0 ? (
                <div>
                  {fileSources.map(source => (
                    <div key={source.id} className="flex items-center gap-2 px-4 py-2 hover:bg-app-hover/50 border-b border-app-border last:border-b-0">
                      <span className="text-[13px]">{'\u{1F4CE}'}</span>
                      <span className="text-[12px] text-app-text truncate flex-1">{source.label}</span>
                      <span className="text-[11px] text-app-text-muted tabular-nums">~{source.tokens > 1000 ? `${(source.tokens / 1000).toFixed(1)}K` : source.tokens} tok</span>
                      <button
                        onClick={() => handleRemoveContextFile(source.id.replace('file:', ''))}
                        className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-500/10 text-app-text-muted hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-2 text-[11px] text-app-text-muted italic">No context files uploaded</div>
              )}
            </div>

            {/* Pinned Messages */}
            <div>
              <div className="px-4 py-1.5 text-[11px] font-semibold text-app-text-tertiary uppercase tracking-wider bg-black/2 dark:bg-white/2">
                Pinned Messages
              </div>
              {pinnedSources.length > 0 ? (
                renderSourceGroup(pinnedSources)
              ) : (
                <div className="px-4 py-2 text-[11px] text-app-text-muted italic">No pinned messages</div>
              )}
            </div>

            {/*
              Canonical envelope view (change `topic-context-canonical`).
              Surfaces what the model ACTUALLY receives — provider strategy,
              composed system messages, history with stripped markers visible,
              and the snapshot ring of the last sends.

              Strictly additive: rendered below the existing source list so
              the legacy UI is unaffected. Hidden automatically when no
              envelope data is available (loading / error / not configured).
            */}
            <ContextEnvelopeView
              topicId={topic.id}
              providerName={topic.provider ?? undefined}
              onMessage={onMessage}
            />
          </div>
        )}
      </div>
    </div>
  );
}
