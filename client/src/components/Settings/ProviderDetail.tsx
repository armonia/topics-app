/**
 * THE DETAIL OF ONE ACCOUNT, the third level of the selector (model selector
 * revision 2026-10-04, §5.5).
 *
 * The heading stays put (‹, name, state, version, freshness, "Test"); the body
 * scrolls in the same panel, whose height does not change. The action of the
 * state is the FIRST line of the body: "Sign in" with "Copy command", the key
 * field, the requirements and the path, the error with "Retry". Then the
 * lines that apply to this account, as a form of two columns (a 168 px label,
 * then the value), one column on the phone:
 *
 *  · Plan (Claude Code): the plan and its two windows;
 *  · Default (never on Topics: it is the band's engine, AICTRL-01);
 *  · Default model: radios in line, Automatic first;
 *  · Effort, Activation, Reasoning, Approval: as before;
 *  · Key: replace it, and where it is kept;
 *  · Endpoint: URL, token, models, remove;
 *  · Program: the path and "Change path";
 *  · Topics: its models, the one-chat band, and "For every chat" the agents'
 *    engine and the checkpoint at every turn (SETHOME-01).
 */
import { useState, type ReactNode } from 'react';
import { AlertCircle, Check, Copy, RefreshCw, X } from 'lucide-react';
import type { ProviderSnapshotEntry, ProvidersSnapshot } from '../../types';
import type { AppBehaviorSettings, CliAgentPresence } from '../../lib/api';
import type { DirectEndpointView } from '../../../../shared/direct-endpoints';
import { EFFORT_TIERS, CODEX_REASONING_EFFORTS } from '../../../../shared/effort';
import { DEFAULT_AGENT_RUNTIME } from '../../../../shared/types';
import { copyText } from '../../lib/clipboard';
import { modelDisplayLabel } from '../../lib/modelLabel';
import { useLocale, useT } from '../../hooks/useT';
import { Select } from '../Shared/Select';
import { enabledToSelect, selectToEnabled } from './behaviorDefaults';
import { API_PROVIDERS, AUTO, PROVIDER_MODEL_FIELD, isApiProvider, relativeTime } from './providerFormat';
import type { ProviderCard } from './providersModel';
import { LevelBack, StatusDot } from './ProvidersView';
import { ApiKeyForm } from './ApiProviderSetup';
import { CliAgentRow } from './CliAgentsPanel';
import { ProviderDefaultModel } from './ProviderDefaultModel';
import { AgentRuntimeChoice } from './AgentRuntimeChoice';
import { TurnCheckpointsChoice } from './TurnCheckpointsChoice';
import { ClaudePlanUsage } from './ClaudePlanUsage';

export interface TestResult {
  ok: boolean;
  message: string;
  at: number;
}

export interface ProviderDetailProps {
  card: ProviderCard;
  entry: ProviderSnapshotEntry | undefined;
  snapshot: ProvidersSnapshot | null;
  agent: CliAgentPresence | undefined;
  endpoint: DirectEndpointView | undefined;
  settings: AppBehaviorSettings | null;
  saving: boolean;
  error: string | null;
  focus?: 'key' | 'path';
  testing: boolean;
  result?: TestResult;
  /** Other registered providers that write the same default-model field. */
  modelSharedWith: string[];
  onBack: () => void;
  onTest: () => void;
  onSignIn: (command: string) => void;
  signInCommand: string | null;
  onSave: (patch: Partial<AppBehaviorSettings>) => Promise<void>;
  onSetDefault: () => void;
  onClearDefault: () => void;
  onKeySaved: () => Promise<void>;
  onAgentsChanged: (agents: CliAgentPresence[]) => void;
  onRemoveEndpoint: (id: string) => void;
}

/** One line of the form: a label column, then the value. */
function DetailRow({ label, testId, children }: { label: string; testId?: string; children: ReactNode }) {
  return (
    <div data-testid={testId} className="grid grid-cols-1 gap-x-3 gap-y-1 border-t border-app-border py-2 first:border-t-0 @min-[30rem]:grid-cols-[168px_minmax(0,1fr)]">
      <div className="pt-1 text-mini font-medium text-app-text-secondary">{label}</div>
      <div className="min-w-0 space-y-1.5">{children}</div>
    </div>
  );
}

/** A choice of the form, with its hint under it. */
function DetailSelect({ label, hint, value, options, autoLabel, disabled, onChange }: {
  label: string;
  hint?: string;
  value: string | null;
  options: Array<{ value: string; label: string }>;
  autoLabel: string;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <>
      <Select
        ariaLabel={label}
        disabled={disabled}
        value={value ?? AUTO}
        onChange={(v) => onChange(v === AUTO ? null : v)}
        className="max-w-full min-w-[140px]"
        options={[{ value: AUTO, label: autoLabel }, ...options]}
      />
      {hint && <p className="text-mini text-app-text-secondary break-words">{hint}</p>}
    </>
  );
}

function RequirementList({ entry }: { entry: ProviderSnapshotEntry }) {
  return (
    <ul className="space-y-1 text-mini">
      {entry.requirements.map((req) => (
        <li key={req.key} className="flex items-center gap-1.5">
          {req.present
            ? <Check size={12} className="shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            : <X size={12} className="shrink-0 text-red-600 dark:text-red-400" aria-hidden="true" />}
          <span className={req.present ? 'text-app-text-secondary' : 'text-app-text'}>{req.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function ProviderDetail(props: ProviderDetailProps) {
  const tr = useT();
  const locale = useLocale();
  const { card, entry, settings } = props;
  const [copied, setCopied] = useState(false);
  const save = (patch: Partial<AppBehaviorSettings>) => { void props.onSave(patch).catch(() => { /* the level shows the error */ }); };
  const apiProvider = isApiProvider(card.name) ? card.name : null;
  const hasKey = !!apiProvider && !!entry?.requirements.some((req) => req.key === API_PROVIDERS[apiProvider].requirement && req.present);
  const modelField = PROVIDER_MODEL_FIELD[card.name];
  const ready = card.status === 'ready';
  const word = tr(`ai.selector.status.${card.status}`);
  const status = [word, entry?.version ? `v${entry.version}` : null, entry?.fetchedAt ? tr('ai.providers.updated', { when: relativeTime(entry.fetchedAt, locale) }) : null]
    .filter(Boolean).join(' · ');

  const copyCommand = async () => {
    if (!props.signInCommand || !(await copyText(props.signInCommand))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // THE ACTION OF THE STATE, first line of the body (§5.5).
  let action: ReactNode = null;
  if (card.action === 'signIn' && props.signInCommand) {
    action = (
      <DetailRow label={tr('ai.providers.row.access')} testId="provider-detail-action">
        <div className="flex flex-wrap gap-2">
          <button type="button" data-testid="provider-detail-sign-in" onClick={() => props.onSignIn(props.signInCommand!)} className="rounded-md bg-primary px-3 py-1 text-compact font-medium text-white hover:bg-primary/90 coarse:min-h-11">
            {tr('ai.selector.action.signIn')}
          </button>
          <button type="button" data-testid="provider-detail-copy-command" onClick={() => { void copyCommand(); }} className="flex items-center gap-1 rounded-md border border-app-border px-2.5 py-1 text-compact text-app-text hover:bg-app-hover coarse:min-h-11">
            {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
            {tr(copied ? 'ai.providers.copied' : 'ai.providers.copyCommand')}
          </button>
        </div>
        {entry && entry.requirements.length > 0 && <RequirementList entry={entry} />}
      </DetailRow>
    );
  } else if (card.action === 'addKey' && apiProvider) {
    action = (
      <DetailRow label={tr('ai.providers.row.key')} testId="provider-detail-action">
        <ApiKeyForm provider={apiProvider} replacing={hasKey} onSaved={props.onKeySaved} autoFocus={props.focus === 'key'} />
      </DetailRow>
    );
  } else if (card.action === 'setUp') {
    action = (
      <DetailRow label={tr('ai.providers.row.requirements')} testId="provider-detail-action">
        {entry && entry.requirements.length > 0 && <RequirementList entry={entry} />}
        {props.agent && <CliAgentRow agent={props.agent} onChanged={props.onAgentsChanged} focusPath={props.focus === 'path'} />}
        {card.name === 'claude-code' && settings && (
          <DetailSelect
            label={tr('ai.providers.row.activation')}
            hint={tr('ai.providers.activation.hint')}
            value={enabledToSelect(settings.claudeCodeEnabled)}
            autoLabel={tr('ai.selector.auto')}
            disabled={props.saving}
            onChange={(v) => save({ claudeCodeEnabled: selectToEnabled(v) })}
            options={[{ value: 'on', label: tr('ai.providers.activation.on') }, { value: 'off', label: tr('ai.providers.activation.off') }]}
          />
        )}
      </DetailRow>
    );
  } else if (card.action === 'retry') {
    action = (
      <DetailRow label={tr('ai.providers.row.error')} testId="provider-detail-action">
        <p className="flex items-start gap-1.5 text-mini text-red-600 dark:text-red-400">
          <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="break-words">{entry?.lastError ?? word}</span>
        </p>
        <button type="button" data-testid="provider-detail-retry" disabled={props.testing} onClick={props.onTest} className="flex items-center gap-1 rounded-md border border-app-border px-2.5 py-1 text-compact text-app-text hover:bg-app-hover disabled:opacity-50 coarse:min-h-11">
          <RefreshCw size={12} className={props.testing ? 'animate-spin' : ''} aria-hidden="true" />
          {tr('common.retry')}
        </button>
      </DetailRow>
    );
  }

  const explicitDefault = settings?.aiProvider === card.name;
  const showDefault = card.registered && card.name !== 'topics' && (ready || entry?.isDefault);

  return (
    <div data-testid={`provider-detail-${card.name}`} data-status={card.status} className="@container flex min-h-0 flex-1 flex-col">
      <div data-testid="provider-detail-header" className="flex shrink-0 items-start gap-1 border-b border-app-border px-1 py-1">
        <LevelBack label={tr('ai.providers.backToList')} onBack={props.onBack} />
        <div className="min-w-0 flex-1 px-1 py-0.5">
          <div className="break-words text-compact font-semibold text-app-text">{card.label}</div>
          <div data-testid="provider-detail-status" className="flex flex-wrap items-center gap-x-1.5 text-mini text-app-text-secondary">
            <StatusDot status={card.status} />
            <span className="break-words">{status}</span>
          </div>
        </div>
        {entry && (
          <button
            type="button"
            data-testid="provider-detail-test"
            disabled={props.testing}
            onClick={props.onTest}
            className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-app-border px-2 text-mini text-app-text hover:bg-app-hover disabled:opacity-50 coarse:h-11 coarse:min-w-11"
          >
            <RefreshCw size={11} className={props.testing ? 'animate-spin' : ''} aria-hidden="true" />
            {tr('ai.providers.test')}
          </button>
        )}
      </div>
      <div data-testid="provider-detail-body" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-1">
        {props.result && (
          <p role="status" data-testid="provider-detail-result" className={`flex items-center gap-1 pt-2 text-mini ${props.result.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
            {props.result.ok ? <Check size={11} aria-hidden="true" /> : <AlertCircle size={11} aria-hidden="true" />}
            {props.result.message}
          </p>
        )}
        {props.error && <p role="alert" className="pt-2 text-mini text-red-600 dark:text-red-400">{props.error}</p>}
        {action}

        {card.name === 'claude-code' && card.registered && (
          <DetailRow label={tr('ai.providers.row.plan')} testId="provider-detail-plan"><ClaudePlanUsage /></DetailRow>
        )}

        {showDefault && settings && (
          <DetailRow label={tr('ai.providers.row.default')} testId="provider-detail-default">
            <p className="text-mini text-app-text-secondary">
              {entry?.isDefault ? tr(explicitDefault ? 'ai.providers.default.yes' : 'ai.providers.default.fallback') : tr('ai.providers.default.no')}
            </p>
            {!entry?.isDefault && ready && (
              <button type="button" data-testid="provider-default-set" onClick={props.onSetDefault} className="rounded-md border border-app-border px-2.5 py-1 text-compact text-app-text hover:bg-app-hover coarse:min-h-11">
                {tr('ai.providers.default.set')}
              </button>
            )}
            {entry?.isDefault && explicitDefault && (
              <button type="button" data-testid="provider-default-clear" disabled={props.saving} onClick={props.onClearDefault} className="rounded-md border border-app-border px-2.5 py-1 text-compact text-app-text hover:bg-app-hover disabled:opacity-50 coarse:min-h-11">
                {tr('ai.providers.default.clear')}
              </button>
            )}
          </DetailRow>
        )}

        {modelField && settings && entry && (entry.models.length > 0 || settings[modelField]) && (
          <DetailRow label={tr('ai.providers.row.defaultModel')} testId="provider-detail-default-model">
            <ProviderDefaultModel
              provider={card.name}
              providerName={card.label}
              snapshot={props.snapshot}
              value={settings[modelField]}
              disabled={props.saving}
              hint={[
                apiProvider ? tr('ai.api.nextTurn') : tr('ai.providers.defaultModel.restart'),
                props.modelSharedWith.length > 0 ? tr('ai.providers.defaultModel.shared', { names: props.modelSharedWith.join(', ') }) : null,
              ].filter(Boolean).join(' ')}
              onChange={(model) => save({ [modelField]: model } as Partial<AppBehaviorSettings>)}
            />
          </DetailRow>
        )}

        {card.name === 'claude-code' && card.registered && settings && (
          <>
            <DetailRow label={tr('ai.providers.row.effort')}>
              <DetailSelect
                label={tr('ai.providers.row.effort')}
                hint={tr('ai.providers.effort.hint')}
                value={settings.claudeEffort}
                autoLabel={tr('ai.selector.auto')}
                disabled={props.saving}
                onChange={(v) => save({ claudeEffort: v })}
                options={EFFORT_TIERS.map((v) => ({ value: v, label: v }))}
              />
            </DetailRow>
            <DetailRow label={tr('ai.providers.row.activation')}>
              <DetailSelect
                label={tr('ai.providers.row.activation')}
                hint={tr('ai.providers.activation.hint')}
                value={enabledToSelect(settings.claudeCodeEnabled)}
                autoLabel={tr('ai.selector.auto')}
                disabled={props.saving}
                onChange={(v) => save({ claudeCodeEnabled: selectToEnabled(v) })}
                options={[{ value: 'on', label: tr('ai.providers.activation.on') }, { value: 'off', label: tr('ai.providers.activation.off') }]}
              />
            </DetailRow>
          </>
        )}

        {card.name === 'codex' && settings && (
          <>
            <DetailRow label={tr('ai.providers.row.reasoning')}>
              <DetailSelect
                label={tr('ai.providers.row.reasoning')}
                hint={tr('ai.api.nextTurn')}
                value={settings.codexReasoningEffort}
                autoLabel={tr('ai.selector.auto')}
                disabled={props.saving}
                onChange={(v) => save({ codexReasoningEffort: v })}
                options={CODEX_REASONING_EFFORTS.map((v) => ({ value: v, label: v }))}
              />
            </DetailRow>
            <DetailRow label={tr('ai.providers.row.approval')}>
              <DetailSelect
                label={tr('ai.providers.row.approval')}
                hint={tr('ai.providers.defaultModel.restart')}
                value={settings.codexApprovalMode}
                autoLabel={tr('ai.selector.auto')}
                disabled={props.saving}
                onChange={(v) => save({ codexApprovalMode: v })}
                options={[{ value: 'auto', label: tr('ai.providers.approval.auto') }, { value: 'full-access', label: tr('ai.providers.approval.full') }]}
              />
            </DetailRow>
          </>
        )}

        {apiProvider && hasKey && card.action !== 'addKey' && (
          <DetailRow label={tr('ai.providers.row.key')} testId="provider-detail-key">
            <details data-testid={`provider-key-details-${card.name}`}>
              <summary className="cursor-pointer py-1 text-compact text-app-text coarse:min-h-11">{tr('ai.api.replaceKey')}</summary>
              <div className="pt-2"><ApiKeyForm provider={apiProvider} replacing onSaved={props.onKeySaved} /></div>
            </details>
            <p data-testid="api-billing-note" className="text-mini text-app-text-secondary">{tr('ai.api.billing')}</p>
          </DetailRow>
        )}

        {props.endpoint && (
          <DetailRow label={tr('ai.providers.row.endpoint')} testId="provider-detail-endpoint">
            <p className="break-all font-mono text-mini text-app-text">{props.endpoint.baseUrl}</p>
            <p className="text-mini text-app-text-secondary">
              {tr('ai.providers.endpoint.token')}: {props.endpoint.hasToken ? tr('ai.endpoints.tokenSet') : tr('ai.providers.endpoint.noToken')}
              {entry ? ` · ${entry.models.length === 1 ? tr('ai.providers.fact.modelOne') : tr('ai.providers.fact.models', { n: entry.models.length })}` : ''}
            </p>
            <button type="button" data-testid="provider-detail-endpoint-remove" onClick={() => props.onRemoveEndpoint(props.endpoint!.id)} className="rounded-md border border-app-border px-2.5 py-1 text-compact text-app-text hover:bg-app-hover coarse:min-h-11">
              {tr('ai.providers.endpoint.remove')}
            </button>
          </DetailRow>
        )}

        {card.registered && (entry?.binaryPath || props.agent) && card.action !== 'setUp' && (
          <DetailRow label={tr('ai.providers.row.program')} testId="provider-detail-program">
            {props.agent
              ? <CliAgentRow agent={props.agent} onChanged={props.onAgentsChanged} focusPath={props.focus === 'path'} />
              : <p className="break-all font-mono text-mini text-app-text-secondary">{entry?.binaryPath ?? tr('ai.providers.program.none')}</p>}
          </DetailRow>
        )}

        {card.name === 'topics' && (
          <>
            <DetailRow label={tr('ai.providers.row.models')} testId="provider-detail-models">
              <p className="text-compact text-app-text break-words">{(entry?.models ?? []).filter((id) => !/\[1m\]$/i.test(id)).map((id) => modelDisplayLabel(id)).join(' · ')}</p>
              <p className="text-mini text-app-text-secondary">{tr('ai.providers.oneChat')}</p>
            </DetailRow>
            {settings && (
              <div data-testid="provider-detail-every-chat" className="border-t border-app-border py-2">
                <p className="pb-1 text-mini font-semibold uppercase tracking-wide text-app-text-secondary">{tr('ai.providers.everyChat')}</p>
                <AgentRuntimeChoice
                  settings={settings}
                  saving={props.saving}
                  registered={(props.snapshot?.providers ?? []).some((p) => p.name === (settings.agentRuntime ?? DEFAULT_AGENT_RUNTIME))}
                  onSave={props.onSave}
                />
                <TurnCheckpointsChoice settings={settings} saving={props.saving} onSave={props.onSave} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
