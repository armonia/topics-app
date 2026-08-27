import { useState, useEffect, useCallback, useRef } from 'react';
import { useT } from '../../hooks/useT';
import { X, ChevronLeft, FileText, FolderOpen, Upload, Trash2, ChevronsDownUp } from 'lucide-react';
import type { Topic, UpdateTopicRequest, WSMessage } from '../../types';
import { useContextInspector } from '../../hooks/useContextInspector';
import { useOpenClawContext } from '../../hooks/useOpenClawContext';
import { useMemory } from '../../hooks/useMemory';
import { uploadApi, type MemoryTreeNode } from '../../lib/api';
import { ContextBudgetBar } from './ContextBudgetBar';
import { CostProbePanel } from './CostProbePanel';
import { useCostProbe } from '../../hooks/useCostProbe';
import { useRealContext } from '../../hooks/useRealContext';
import { formatTokens } from '../../lib/formatTokens';
import { ContextWarnings } from './ContextWarnings';
import { ContextSourceRow } from './ContextSourceRow';
import { ContextEnvelopeView } from './ContextEnvelopeView';
import { SessionEnvironmentPanel } from './SessionEnvironmentPanel';
import { useToast } from '../Shared/Toast';
import { Spinner } from '../Shared/Spinner';

/**
 * L'intestazione di una sezione: sempre la stessa, in un posto solo.
 * Era ripetuta parola per parola cinque volte, con una sesta variante che
 * aggiungeva `flex items-center` perché ci stava dentro un bottone — cioè cinque
 * copie e una che divergeva già.
 */
const SECTION_HEADER =
  'flex items-center px-4 py-1 text-[10px] font-semibold text-app-text-tertiary uppercase tracking-wider bg-black/2 dark:bg-white/2';

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
  /** Chiede la compattazione del contesto. Assente = l'azione non si mostra
   *  (es. su una topic bozza, che non ha ancora una sessione a cui chiederla). */
  onCompact?: () => void;
}

export function ContextInspector({ topic, isOpen, onClose, onUpdateTopic, onMessage, onOpenFile, onCompact }: ContextInspectorProps) {
  const tr = useT();
  // Keep the latest topic in a ref so stable callbacks (handleToggleSource) read
  // current values without listing `topic` in their deps. Synced in an effect to
  // avoid mutating a ref during render.
  const topicRef = useRef(topic);
  useEffect(() => {
    topicRef.current = topic;
  }, [topic]);

  const { sources, totalTokens, budgetLimit, budgetPercent, warnings, loading, reload } = useContextInspector(topic.id, onMessage);
  // La sonda del costo. `isOpen` è la chiave di rilettura: il pannello si apre
  // per guardare i numeri, ed è l'unico momento in cui vale la pena andarli a
  // riprendere. Il contesto continua ad aggiornarsi dal filo anche a pannello
  // aperto, senza altre richieste.
  const costProbe = useCostProbe(topic.sessionKey ?? null, onMessage, isOpen);
  // La MISURA VIVA — la stessa che disegna l'anello nel composer, dalla stessa
  // sorgente. Il pannello si apre cliccando quell'anello: trovarci dentro solo
  // il preventivo dell'envelope era rispondere a una domanda che nessuno aveva
  // fatto. L'hook è condiviso, quindi i due numeri non possono divergere.
  const live = useRealContext(topic.sessionKey ?? null, onMessage);
  const { data: openclawData } = useOpenClawContext();
  const { saveTopicMemory, saveGlobalMemory } = useMemory(topic.id, { onMessage });
  const toast = useToast();

  const [browsingMemoryTree, setBrowsingMemoryTree] = useState(false);
  /** La diagnostica dell'envelope è aperta? Vedi il `<details>` in fondo: da
   *  chiusa il suo contenuto non si monta, quindi non fa le sue due fetch. */
  const [envelopeAperto, setEnvelopeAperto] = useState(false);
  /** Is the inherited environment open? Same reason as the flag above. */
  const [ambienteAperto, setAmbienteAperto] = useState(false);

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

  /**
   * Una sezione, e SOLO se ha qualcosa dentro.
   *
   * L'intestazione porta il totale della sezione: prima bisognava sommare a
   * occhio le righe per sapere se la memoria pesava trecento token o trentamila,
   * che è esattamente la domanda per cui si scorre questo elenco.
   */
  const renderSection = (title: string, groupSources: typeof sources) => {
    if (groupSources.length === 0) return null;
    const tokens = groupSources.reduce((sum, s) => sum + s.tokens, 0);
    return (
      <div>
        <div className={SECTION_HEADER}>
          <span className="flex-1">{title}</span>
          <span className="tabular-nums font-normal normal-case tracking-normal">{formatTokens(tokens)}</span>
        </div>
        {renderSourceGroup(groupSources)}
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
          <button aria-label="Indietro"
            onClick={() => setBrowsingMemoryTree(false)}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-[13px] font-medium text-app-text truncate">
            OpenClaw Memory Tree
          </span>
          <div className="flex-1" />
          <button aria-label={tr('ctxInspector.close')} onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary">
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
      {/* Header — il titolo, l'azione, la chiusura. Il bottone «ricarica» era
          un terzo bersaglio per una cosa che si aggiorna da sola dal filo a
          ogni turno: è andato via con la riga di sezioni vuote qui sotto. */}
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-app-border flex-shrink-0">
        <span className="text-[12px] font-medium text-app-text">{tr('ctxInspector.title')}</span>
        {loading && <Spinner size="sm" />}
        <div className="flex-1" />
        {/* «Compatta ora» — l'unica azione di questo pannello, quindi sta in
            testa e non sepolta a metà. Prima l'unico modo di chiederla era il
            bottone dentro l'avviso di soglia, che compariva solo sopra soglia:
            proprio quando serve pianificare non c'era. */}
        {onCompact && (
          <button
            type="button"
            onClick={() => { onCompact(); onClose(); }}
            className="px-2 py-1 text-[11px] rounded-md border border-app-border-light text-app-text-secondary hover:text-app-text hover:bg-app-hover transition-colors inline-flex items-center gap-1.5"
            title={tr('ctxInspector.compact')}
          >
            <ChevronsDownUp size={12} />
            {tr('ctxInspector.compactAction')}
          </button>
        )}
        <button
          onClick={onClose}
          aria-label={tr('ctxInspector.close')}
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-app-hover text-app-text-tertiary"
        >
          <X size={14} />
        </button>
      </div>

      {/* IL GRAFICO IN CIMA, com'è ovunque: quanto è pieno, e di cosa.
          Prima la prima cosa sotto l'intestazione era il pannello del costo,
          cioè una moltiplicazione in prosa — un conto, non una misura. Il
          conto resta, ma dopo: si guarda quanto è pieno, poi quanto costa. */}
      <ContextBudgetBar
        sources={sources}
        totalTokens={totalTokens}
        budgetLimit={budgetLimit}
        budgetPercent={budgetPercent}
        live={live ?? null}
      />

      {/* Il costo, subito sotto la misura: contesto × chiamate. */}
      <CostProbePanel probe={costProbe} />

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
            {/* LE SEZIONI VUOTE NON SI DISEGNANO PIÙ.
                Erano cinque intestazioni fisse con sotto, quasi sempre, «No
                memory content yet» / «No system prompt set» / «No template
                files found» / «No pinned messages»: quattro righe che dicono
                che non c'è niente da vedere, in un pannello aperto per vedere
                qualcosa. Una sezione compare quando ha contenuto; l'unica che
                resta sempre è quella dei file, perché lì l'intestazione porta
                un'AZIONE (aggiungi). */}
            {renderSection(tr('ctxInspector.section.openclaw'), openclawSources)}
            {renderSection(tr('ctxInspector.section.memory'), memorySources)}
            {renderSection(tr('ctxInspector.section.prompt'), promptSources)}
            {topic.projectPath && renderSection(tr('ctxInspector.section.template'), templateSources)}

            {/* Context Files — sempre presente: l'intestazione è un'azione. */}
            <div>
              <div className={SECTION_HEADER}>
                <span className="flex-1">{tr('ctxInspector.section.files')}</span>
                <label className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-primary hover:bg-primary/10 cursor-pointer transition-colors normal-case tracking-normal">
                  <Upload size={10} />
                  <span>{tr('ctxInspector.addFile')}</span>
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    onChange={handleUploadContextFile}
                  />
                </label>
              </div>
              {fileSources.length > 0 && (
                <div>
                  {fileSources.map(source => (
                    <div key={source.id} className="flex items-center gap-2 px-4 py-1.5 hover:bg-app-hover/50 border-b border-app-border last:border-b-0">
                      <span className="text-[12px] text-app-text truncate flex-1">{source.label}</span>
                      <span className="text-[11px] text-app-text-muted tabular-nums">{formatTokens(source.tokens)}</span>
                      <button aria-label={tr('ctxInspector.removeSource')}
                        onClick={() => handleRemoveContextFile(source.id.replace('file:', ''))}
                        className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-500/10 text-app-text-muted hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {renderSection(tr('ctxInspector.section.pinned'), pinnedSources)}

            {/*
              L'envelope canonico — ciò che il modello riceve davvero: strategia
              del provider, blocchi di sistema composti, storia con i marker
              tolti, e l'anello degli ultimi invii.

              È una vista da DEBUG e adesso lo dichiara: sta chiusa in fondo.
              Aperta di default aggiungeva tre tab, un JSON grezzo e un pannello
              di snapshot a un pannello che deve rispondere a «quanto è pieno e
              di cosa»: informazione vera, ma per chi sviluppa Topics.

              E si monta SOLO QUANDO SI APRE. Un `<details>` chiuso nasconde i
              figli, non li smonta: il componente dentro girava comunque, e con
              lui le sue DUE fetch (`context-preview` + `context-snapshots`) —
              pagate a ogni apertura del pannello da chiunque non guarderà mai
              quella sezione. Il difetto era invisibile a occhio e l'ha trovato
              un'asserzione sul `<details>`, non un umano.
            */}
            {/*
              THE INHERITED ENVIRONMENT. The session spawns the real CLI with
              the user's setting sources, so hooks, skills, commands and MCP
              servers written under `.claude` are already in force: what was
              missing was the place to SEE them. It belongs here because it
              answers the same question as this panel, "what does this session
              actually have", and it is closed by default because it is an
              answer people go looking for, not one they need on every open.

              Same rule as the envelope below: a closed `<details>` HIDES its
              children, it does not unmount them, so without the flag the fetch
              would run for everyone who never opens the section.
            */}
            <details
              className="border-t border-app-border"
              onToggle={(e) => setAmbienteAperto((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary className="px-4 py-2 text-[11px] text-app-text-tertiary cursor-pointer hover:text-app-text-secondary select-none">
                {tr('sessionEnv.title')}
              </summary>
              {ambienteAperto && <SessionEnvironmentPanel topicId={topic.id} />}
            </details>

            <details
              data-testid="envelope-details"
              className="border-t border-app-border"
              onToggle={(e) => setEnvelopeAperto((e.currentTarget as HTMLDetailsElement).open)}
            >
              <summary className="px-4 py-2 text-[11px] text-app-text-tertiary cursor-pointer hover:text-app-text-secondary select-none">
                {tr('ctxInspector.envelope')}
              </summary>
              {envelopeAperto && (
                <ContextEnvelopeView
                  topicId={topic.id}
                  providerName={topic.provider ?? undefined}
                  onMessage={onMessage}
                />
              )}
            </details>
          </div>
        )}
      </div>
    </div>
  );
}
