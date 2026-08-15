import { useState, useEffect, useRef } from 'react';

import { createPortal } from 'react-dom';
import { X, FolderOpen, GitBranch, BellOff, ShieldCheck } from 'lucide-react';
import type { Topic, UpdateTopicRequest, Worktree, AutonomyLevel } from '../../types';
/** Le tre voci, descritte per quello che FANNO. Il nome da solo non basta:
 *  «yolo» non dice a nessuno che quella chat può cancellarti un file. */
const AUTONOMY_CHOICES: { value: AutonomyLevel; label: string; blurb: string }[] = [
  { value: 'ask', label: 'Asks first', blurb: 'Proposes a plan and waits for your go-ahead: touches no file, runs no command.' },
  { value: 'auto-apply', label: 'Applies edits', blurb: 'Writes to files on its own; everything else it proposes.' },
  { value: 'yolo', label: 'Does everything', blurb: 'No questions asked. This is the long-standing behaviour.' },
];
import { ShareControl } from '../Share/ShareControl';
import { buildTabLinkForTarget } from '../../lib/tabLink';
import { Select } from '../Shared/Select';
import { MODAL_BACKDROP, MODAL_PANEL } from '../../lib/modalStyles';
import { useModalDialog } from '../../hooks/useModalDialog';
import { worktreesApi } from '../../lib/api';
import { useToast } from '../Shared/Toast';
import { SwitchTrack } from '../Shared/Switch';
import { useConfirm } from '../../hooks/useConfirm';

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

/**
 * Il gesto «condividi questa chat», e l'unico posto dove si decide se questa
 * chat si possa condividere affatto.
 *
 * Sta in un componente suo, e non in una riga di JSX dentro il modale, perché
 * la condizione È il comportamento: una `draft:` non ha ancora una riga sul
 * server, quindi la concessione atterrerebbe su un id che sta per essere
 * buttato — e non la ferma nessuno più a valle. `POST /api/auth/shares`
 * (server/routes/auth.ts) valida il tipo di risorsa, il tipo di soggetto e il
 * confinamento del soggetto: non controlla MAI che la riga della risorsa
 * esista. Una concessione verso `draft:xyz` viene scritta da `putGrant` e
 * sopravvive all'id buttato — un permesso verso il nulla che resta poi
 * nell'elenco.
 *
 * Isolato così, quel «non sulle bozze» è una funzione pura di props: si prova
 * senza montare niente (`TopicSettingsModal.test.tsx`), e togliere la guardia
 * fa diventare rosso quel test invece di non far fallire nulla.
 *
 * Il controllo vive QUI e non nella riga di chrome della pane perché quella
 * riga è la barra delle TAB — appartiene al gruppo, non alla singola chat —
 * mentre questo modale è la superficie che parla di UNA topic, ed è
 * raggiungibile allo stesso modo da ogni layout (gruppo standalone, cella
 * sola, finestra di progetto).
 */
export function TopicShareAction({ topicId }: { topicId: string }) {
  if (topicId.startsWith('draft:')) return null;
  // Il link di casa sta nel pannello di condivisione anche qui, per la stessa
  // ragione per cui ci sta sulla scheda di un task: «dammi il link» è una
  // domanda sola, e deve avere un posto solo dove si risponde.
  return <ShareControl resourceType="topic" resourceId={topicId} deepLink={() => buildTabLinkForTarget({ kind: 'chat', key: topicId })} />;
}

export function TopicSettingsModal({ topic, isOpen, onClose, onUpdate }: TopicSettingsModalProps) {
  const confirm = useConfirm();
  const [projectPath, setProjectPath] = useState(topic.projectPath || '');
  const [topicName, setTopicName] = useState(topic.name);
  const [topicColor, setTopicColor] = useState(topic.color);
  const [systemPrompt, setSystemPrompt] = useState(topic.systemPrompt || '');
  const [contextFilesList, setContextFilesList] = useState<string[]>(topic.contextFiles || []);
  const [newContextFile, setNewContextFile] = useState('');
  const [provider, setProvider] = useState<string | null>(topic.provider ?? null);
  const [muted, setMuted] = useState(!!topic.muted);
  const [autonomy, setAutonomy] = useState<AutonomyLevel | null>(topic.autonomyLevel ?? null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [saved, setSaved] = useState(false);
  const toast = useToast();
  // Phase A · TOPIC-WT-03: read-only worktree info when topic is bound.
  const [worktree, setWorktree] = useState<Worktree | null>(null);

  // Fetch the bound worktree once per (re)open. The section is hidden
  // entirely when topic.worktreeId is null/unset, so legacy topics see
  // exactly the same UI as before this change.
  useEffect(() => {
    let cancelled = false;
    // external-data sync: clear stale worktree before the async re-fetch on (re)open
    setWorktree(null);
    if (!isOpen || !topic.worktreeId) return;
    worktreesApi.get(topic.worktreeId)
      .then((wt) => { if (!cancelled) setWorktree(wt); })
      .catch(() => { /* swallow — leave the section hidden if it 404s */ });
    return () => { cancelled = true; };
  }, [isOpen, topic.worktreeId]);

  useEffect(() => {
    // one-shot sync of controlled form fields from the topic prop on open / topic change
    setProjectPath(topic.projectPath || '');
    setTopicName(topic.name);
    setTopicColor(topic.color);
    setSystemPrompt(topic.systemPrompt || '');
    setContextFilesList(topic.contextFiles || []);
    setNewContextFile('');
    setProvider(topic.provider ?? null);
    setMuted(!!topic.muted);
    setSaved(false);
    // Keyed on topic.id, NOT the topic object: every `topic:updated` WS
    // broadcast mints a fresh object reference (applyTopicFromWS), and with
    // `[topic, isOpen]` an unrelated background update — e.g. the auto-namer
    // renaming a New Chat a few seconds in — silently wiped whatever the user
    // was typing in these fields and dropped isDirty. Re-seeding is only
    // correct when the modal (re)opens or targets a different topic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic.id, isOpen]);

  // Fetch available providers
  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/providers')
      .then(r => r.json())
      .then(data => setProviders(data.providers || []))
      .catch(() => setProviders([]));
  }, [isOpen]);

  // Dirty state is pure derived data (current form vs. the topic prop), so we
  // compute it during render instead of mirroring it into state via an effect.
  const isDirty =
    projectPath !== (topic.projectPath || '') ||
    topicName !== topic.name ||
    topicColor !== topic.color ||
    systemPrompt !== (topic.systemPrompt || '') ||
    JSON.stringify(contextFilesList) !== JSON.stringify(topic.contextFiles || []) ||
    provider !== (topic.provider ?? null) ||
    muted !== !!topic.muted;

  const handleClose = async () => {
    if (isDirty && !await confirm({ title: 'You have unsaved changes.', body: 'Close without saving?', confirmLabel: 'Discard' })) {
      return;
    }
    onClose();
  };

  const handleSave = async () => {
    // updateTopic swallows request errors and resolves null rather than
    // throwing, so an unguarded await always looked like a successful save.
    const result = await onUpdate(topic.id, {
      name: topicName,
      color: topicColor,
      projectPath: projectPath.trim() || undefined,
      // Il livello di autonomia ora si sceglie da qui, quindi si manda. Se non
      // è mai stato scelto resta `undefined` e la PATCH parziale non tocca la
      // colonna — un topic che non ha deciso continua a comportarsi come prima.
      ...(autonomy ? { autonomyLevel: autonomy } : {}),
      systemPrompt,
      contextFiles: contextFilesList,
      provider,
      muted,
    });
    if (!result) {
      toast.error('Failed to save settings');
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleUnlinkProject = async () => {
    const previousProjectPath = projectPath;
    setProjectPath('');
    const result = await onUpdate(topic.id, { projectPath: '' });
    if (!result) {
      // Roll back the optimistic clear — the server still has the old
      // projectPath, so leaving the field blank would be a phantom unlink.
      setProjectPath(previousProjectPath);
      toast.error('Failed to unlink project');
      return;
    }
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

  // Escape chiude (passando da handleClose, così la guardia sulle modifiche non
  // salvate scatta lo stesso), il Tab resta dentro, il focus torna da dove è
  // partito: hooks/useModalDialog. L'Escape scritto a mano stava su `document`
  // e in bolla — con un dialogo annidato rispondevano tutti e due.
  useModalDialog({ open: isOpen, onClose: handleClose, panelRef: dialogRef });

  if (!isOpen) return null;

  // Portale su <body>. Questo modale è montato DENTRO una pane (ChatPanel,
  // ProjectWindow, StandaloneChatGroup) e un `position: fixed` si àncora al
  // viewport solo finché nessun antenato è un containing block. Da quando il
  // guscio delle pane ha `contain: layout` — che serve a impedire che una riga
  // sporca di terminale faccia rilayoutare l'intero albero — quell'antenato
  // esiste, e senza portale il modale resterebbe imprigionato nella pane invece
  // di coprire la finestra. Vedi PaneKeepAlive.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={handleClose} role="dialog" aria-modal="true" aria-label={`${topic.name} Settings`}>
      <div className={`absolute ${MODAL_BACKDROP}`} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`relative w-full max-w-xl mx-4 max-h-[90vh] sm:max-h-[80vh] flex flex-col focus:outline-none ${MODAL_PANEL}`}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-app-border">
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold text-app-text">{topic.name} Settings</h2>
          </div>
          <div className="flex items-center gap-1">
            {/* Condividere una CHAT, con lo stesso controllo con cui si condivide
                una scheda (`TaskDetail`) — non una seconda interfaccia che dice
                la stessa cosa in un altro modo. Il modello sotto è una tabella
                `grants` sola, generica sul tipo di risorsa: due pannelli diversi
                sarebbero esattamente la divergenza che quel modello esiste per
                evitare. La regola «non sulle bozze» sta dentro
                `TopicShareAction`, sopra. */}
            <TopicShareAction topicId={topic.id} />
            <button onClick={handleClose} className="w-7 h-7 flex items-center justify-center rounded hover:bg-black/5 dark:hover:bg-white/5 text-app-text-tertiary hover:text-app-text transition-colors" aria-label="Close settings">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Name */}
          <div>
            <label className="block text-[13px] font-medium text-app-text mb-2">
              Name
            </label>
            <input
              type="text"
              value={topicName}
              onChange={e => setTopicName(e.target.value)}
              className="w-full px-3 py-2 border border-app-border-light rounded-lg text-[13px] bg-surface dark:bg-elevated text-app-text focus:outline-none focus:ring-2 focus:ring-primary transition-colors"
            />
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

          {/* Mute notifications (per-topic — migration 073) */}
          <div>
            <label className="block text-[13px] font-medium text-app-text mb-2">
              <span className="flex items-center gap-1.5">
                <BellOff size={14} />
                Notifications
              </span>
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={muted}
              onClick={() => setMuted(v => !v)}
              className="w-full flex items-center justify-between gap-3 px-3 py-2 border border-app-border-light rounded-lg bg-surface dark:bg-elevated text-left hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <span className="text-[12px] text-app-text-muted">
                {muted
                  ? 'Muted: no banner and no sound at the end of a turn (it still counts in the badge).'
                  : 'On: banner and sound when an agent finishes in this topic.'}
              </span>
              <SwitchTrack checked={muted} />
            </button>
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

          {/* Livello di autonomia — esisteva nel modello dati e non era collegato
              a niente: OGNI chat partiva comunque senza chiedere nulla. Ora
              decide la modalità di permessi della CLI, e ogni voce dice cosa FA
              invece del suo nome. Responsive: in colonna sotto i 640px, dove tre
              bottoni affiancati diventerebbero illeggibili. */}
          <div>
            <label className="block text-[13px] font-medium text-app-text mb-2">
              <span className="flex items-center gap-1.5">
                <ShieldCheck size={14} />
                Autonomy
              </span>
            </label>
            <p className="text-[11px] text-app-text-muted mb-2">
              How much this chat may do on its own before stopping to ask you something.
              {!autonomy && ' You have not chosen yet: for now it does everything without asking.'}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5" role="radiogroup" aria-label="Autonomy level">
              {AUTONOMY_CHOICES.map((c) => {
                // Nessun livello scelto ⇒ nessuno evidenziato. Illuminare «Fa
                // tutto» sarebbe mentire due volte: dice che qualcuno ha scelto,
                // e sceglie il più potente al posto suo. (Il comportamento a
                // runtime resta quello, ed è scritto nella riga sotto.)
                const active = autonomy === c.value;
                return (
                  <button
                    key={c.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    data-testid={`autonomy-${c.value}`}
                    onClick={() => setAutonomy(c.value)}
                    className={`text-left px-3 py-2 rounded-lg border transition-colors ${
                      active
                        ? 'border-primary/50 bg-primary/10 text-app-text'
                        : 'border-app-border-light bg-app-hover/40 text-app-text-muted hover:text-app-text'
                    }`}
                  >
                    <span className="block text-[12px] font-medium">{c.label}</span>
                    <span className="block text-[11px] leading-snug mt-0.5">{c.blurb}</span>
                  </button>
                );
              })}
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
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium ${
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

          {/* Il selettore "Autonomy Level" stava qui, e MENTIVA.
              Mostrava "Ask — Approve each action" selezionato su ogni topic (è
              il default di schema: tutti i 461 nel DB reale) mentre lo spawn
              usava `bypassPermissions`, cioè nessuna approvazione. Un controllo
              che appare impostato e non fa niente è peggio di un controllo
              assente: chi lo legge crede che l'agente chieda.

              NON è un cablaggio dimenticato, è un pezzo che manca. I livelli
              dovrebbero mappare sui `--permission-mode` della CLI, ma tutti
              quelli che CHIEDONO (`manual`, e `acceptEdits` per tutto ciò che
              non è una modifica di file) inoltrano la richiesta su un canale di
              controllo che Topics non gestisce: `can_use_tool` non compare da
              nessuna parte nel server. Collegarli oggi significherebbe far
              bloccare il turno finché non scatta il watchdog — una trappola, non
              una funzione.

              La colonna `topics.autonomy_level`, la `PATCH` che la scrive e il
              tipo restano intatti: i dati non si buttano per una UI. Cosa serve
              per riaccenderlo sta in
              openspec/changes/autonomy-level-needs-permission-channel/. */}

          {/* Provider */}
          <div>
            <label className="block text-[13px] font-medium text-app-text mb-2">
              Provider
            </label>
            <p className="text-[11px] text-app-text-muted mb-2">
              Which AI provider handles conversations in this topic.
            </p>
            <Select
              value={provider || ''}
              onChange={v => setProvider(v || null)}
              ariaLabel="Provider"
              className="w-full"
              options={[
                {
                  value: '',
                  label: `Default${providers.find(p => p.isDefault) ? ` (${providers.find(p => p.isDefault)!.name})` : ''}`,
                },
                ...providers.map(p => ({
                  value: p.name,
                  // Il pallino pieno/vuoto diceva \u00ABconnesso\u00BB senza dirlo: ora \u00E8
                  // una glossa in chiaro, che il menu disegnato pu\u00F2 permettersi
                  // e una `<option>` nativa no.
                  label: p.name,
                  hint: p.connected ? 'Connesso' : 'Non connesso',
                })),
              ]}
            />
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
    </div>,
    document.body,
  );
}
