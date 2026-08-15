import { useState, useEffect, useMemo, useRef, useCallback, type ReactNode } from 'react';
import { X, Cpu, Check, ChevronDown, ChevronRight, RefreshCw, Copy, AlertCircle } from 'lucide-react';
import type { ProviderSnapshotEntry } from '../../types';
import { providersApi, appSettingsApi, type AppBehaviorSettings, type AgentRuntime } from '../../lib/api';
import { enabledToSelect, selectToEnabled } from './behaviorDefaults';
import { EFFORT_TIERS, CODEX_REASONING_EFFORTS } from '../../../../shared/effort';
import { useProvidersSnapshot } from '../../hooks/useProvidersSnapshot';
import { useT } from '../../hooks/useT';
import { PermissionsSection } from './PermissionsSection';
import { Select } from '../Shared/Select';
import {
  AUTO,
  STATUS_COLORS,
  STATUS_LABELS,
  relativeTime,
  PROVIDER_MODEL_FIELD,
} from './providerFormat';

interface TestResult {
  ok: boolean;
  message: string;
  at: number;
}

/**
 * La scheda dei provider: UNA riga per provider, e ogni riga si configura da sé.
 *
 * Prima qui sopra c'era un blocco «Behaviour defaults» con cinque tendine
 * globali, e quattro di quelle cinque erano impostazioni PER-PROVIDER travestite
 * da globali (l'effort di claude-code, l'effort e la modalità di approvazione di
 * codex, l'interruttore di claude-code). La quinta — «Default provider» — era
 * peggio: era una SECONDA superficie sullo stesso campo che governa il bottone
 * «imposta come predefinito» delle righe, e le due potevano contraddirsi.
 *   • leggevano cose diverse: la tendina leggeva `app_settings.aiProvider`, la
 *     riga leggeva `isDefault` dello snapshot — a campo vuoto la tendina diceva
 *     «Auto» mentre una riga portava il badge «Default»;
 *   • la tendina non si rileggeva dopo un «imposta come predefinito», quindi
 *     restava sul valore vecchio;
 *   • la tendina elencava cinque nomi cablati, anche non registrati: sceglierne
 *     uno assente scriveva la riga in DB senza che il default cambiasse davvero.
 * Ora la superficie è una sola. Il caso che solo la tendina sapeva dire — «non
 * scegliere, decidi tu» — è diventato un'azione della riga che ha il badge.
 */
export function AIProvidersSection() {
  // Single subscription point — replaces the per-component fetches the section
  // used to do. Snapshot updates arrive via WS, so opening Settings in two
  // windows shows identical state without either window polling.
  const { snapshot, loading, error, refresh, retry } = useProvidersSnapshot();
  const entries: ProviderSnapshotEntry[] = useMemo(
    () => snapshot?.providers ?? [],
    [snapshot],
  );

  // Le impostazioni globali si leggono UNA volta qui e si passano alle righe:
  // sono la seconda metà di ogni card (modello, effort, approvazione), e una
  // fetch per card significherebbe una lettura per ogni apertura di riga.
  const { settings, saving, error: settingsError, save, apply } = useBehaviorSettings();

  const [expanded, setExpanded] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [defaultError, setDefaultError] = useState<string | null>(null);

  // When a `test()` is in flight we set `testing = name` and remember the
  // entry's `fetchedAt` at trigger time. The snapshot pushes a new entry once
  // the server-side probe finishes; we detect that by comparing `fetchedAt`
  // and synthesize the user-visible result message. This avoids a parallel
  // HTTP path — every consumer sees the same snapshot.
  const testTriggeredAt = useRef<Map<string, string>>(new Map());
  // Watchdog timer for the in-flight test — if no fresh snapshot lands within
  // the timeout we clear `testing` and surface a timeout result so the spinner
  // doesn't stick forever.
  const testWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the watchdog on unmount so a pending timer can't fire after teardown.
  useEffect(() => () => {
    if (testWatchdog.current) clearTimeout(testWatchdog.current);
  }, []);

  useEffect(() => {
    if (!testing) return;
    const entry = entries.find((e) => e.name === testing);
    if (!entry) return;
    const previousAt = testTriggeredAt.current.get(testing);
    if (!previousAt || entry.fetchedAt === previousAt) return;
    // A fresh row landed — derive result from it.
    const ok = entry.status === 'ready';
    const message = ok
      ? `Connesso${entry.models.length ? ` · ${entry.models.length} modelli` : ''}${entry.version ? ` · v${entry.version}` : ''}`
      : entry.lastError ?? STATUS_LABELS[entry.status];
    if (testWatchdog.current) { clearTimeout(testWatchdog.current); testWatchdog.current = null; }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- converging external-store sync: derives the test result from a freshly-arrived WS snapshot and clears `testing`, which guards against re-runs (no cascade)
    setResults((prev) => ({ ...prev, [testing]: { ok, message, at: Date.now() } }));
    testTriggeredAt.current.delete(testing);
    setTesting(null);
  }, [entries, testing]);

  const setDefault = async (name: string) => {
    setDefaultError(null);
    try {
      // Passa da `/api/providers/default` e non da `/api/app-settings` perché
      // quella rotta VALIDA contro il registro prima di scrivere: un nome che
      // non è registrato non deve poter finire in DB come default.
      await providersApi.setDefault(name);
      // La stessa rotta scrive `app_settings.ai_provider` (updateAppSettings),
      // quindi la copia locale va riallineata: senza, il badge continuerebbe a
      // dire «automatico» su una scelta appena fatta a mano — che è esattamente
      // la lettura divergente da cui veniamo.
      apply({ aiProvider: name });
      await refresh();
    } catch (e) {
      setDefaultError(e instanceof Error ? e.message : 'non è stato possibile impostare il default');
    }
  };

  const clearDefault = async () => {
    setDefaultError(null);
    try {
      // `null` = nessuna scelta salvata: il server ricalcola (recomputeDefault)
      // e il badge passa a «Default · automatico» sulla riga che vince il
      // ripiego, che può benissimo essere un'altra.
      await save({ aiProvider: null });
      await refresh();
    } catch (e) {
      setDefaultError(e instanceof Error ? e.message : 'non è stato possibile togliere il default');
    }
  };

  const test = async (name: string) => {
    const entry = entries.find((e) => e.name === name);
    testTriggeredAt.current.set(name, entry?.fetchedAt ?? '');
    setTesting(name);
    // Arm a watchdog: if no fresh snapshot converges in time, stop spinning
    // and report a timeout instead of hanging indefinitely.
    if (testWatchdog.current) clearTimeout(testWatchdog.current);
    testWatchdog.current = setTimeout(() => {
      testWatchdog.current = null;
      testTriggeredAt.current.delete(name);
      setResults((prev) => ({ ...prev, [name]: { ok: false, message: 'La prova è scaduta', at: Date.now() } }));
      setTesting(null);
    }, 15000);
    try {
      await refresh(name);
    } catch (err) {
      if (testWatchdog.current) { clearTimeout(testWatchdog.current); testWatchdog.current = null; }
      const message = err instanceof Error ? err.message : 'Prova non riuscita';
      setResults((prev) => ({ ...prev, [name]: { ok: false, message, at: Date.now() } }));
      testTriggeredAt.current.delete(name);
      setTesting(null);
    }
  };

  // Quante righe condividono lo stesso campo «modello di default». Serve a UNA
  // cosa: dire sulla card di Claude Code e su quella di Claude (API) che la loro
  // tendina scrive nello stesso posto, invece di lasciar scoprire la cosa
  // cambiando l'una e vedendo muoversi l'altra.
  const modelFieldSiblings = useMemo(() => {
    const byField = new Map<string, string[]>();
    for (const e of entries) {
      const field = PROVIDER_MODEL_FIELD[e.name];
      if (!field) continue;
      byField.set(field, [...(byField.get(field) ?? []), e.label ?? e.name]);
    }
    return byField;
  }, [entries]);

  // I due stati di attesa NON escono dalla funzione con un `return` anticipato,
  // ed è la ragione per cui questo blocco è un ramo e non una guardia: sotto la
  // lista dei provider c'è quella dei consensi permanenti, e uno snapshot che
  // non arriva non deve poter rendere irraggiungibile la revoca di un
  // «Consenti sempre». Sono due letture diverse da due rotte diverse.
  const providersBody = error && entries.length === 0 ? (
    <div className="flex items-center gap-2 text-[12px] text-red-500">
      <AlertCircle size={12} className="flex-shrink-0" />
      <span className="break-words flex-1">{error.message || 'Failed to load providers.'}</span>
      <button
        onClick={() => { void retry(); }}
        className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-surface border border-app-border hover:bg-app-hover"
      >
        <RefreshCw size={11} />
        Riprova
      </button>
    </div>
  ) : loading && entries.length === 0 ? (
    <div className="text-[12px] text-app-text-muted">Loading…</div>
  ) : null;

  return (
    <div className="space-y-6">
      <div>
        <label className="flex items-center gap-2 text-[13px] font-medium text-app-text mb-1">
          <Cpu size={14} />
          AI Providers
        </label>
        <p className="text-[11px] text-app-text-muted mb-3">
          Una riga per provider: qui dentro c'è il suo modello di default e il
          resto di come lavora. Il predefinito è quello col badge; una chat può
          sempre scegliere altro dal picker del composer.
        </p>

        {providersBody}

        {providersBody === null && <>
        {settings && (
          <AgentRuntimeChoice
            settings={settings}
            saving={saving}
            registered={entries.some((e) => e.name === 'jcode')}
            onSave={save}
          />
        )}
        {(settingsError || defaultError) && (
          <div className="mb-2 text-[11px] text-red-500">{defaultError ?? settingsError}</div>
        )}

        {/* Una scelta salvata che non corrisponde a nessuna riga: il provider
            non è registrato adesso. Non è uno stato che la scheda possa più
            creare (la rotta valida contro il registro), ma esiste già in giro —
            lo produceva la vecchia tendina «Default provider», che elencava
            cinque nomi cablati anche non registrati. Va detto e va potuto
            togliere: finché resta, torna a valere nel momento in cui quel
            provider ricompare. */}
        {settings?.aiProvider && !entries.some((e) => e.name === settings.aiProvider) && (
          <div className="mb-2 flex items-center gap-2 text-[11px] text-app-text-muted border border-dashed border-app-border rounded-md px-2 py-1.5">
            <AlertCircle size={12} className="flex-shrink-0" />
            <span className="flex-1 break-words">
              Scelta salvata: <span className="font-mono">{settings.aiProvider}</span>. Non è fra i
              provider registrati, quindi ora il default lo decide il ripiego.
            </span>
            <button
              onClick={() => { void clearDefault(); }}
              disabled={saving}
              className="flex-shrink-0 px-2 py-1 rounded-md bg-surface border border-app-border hover:bg-app-hover disabled:opacity-50"
            >
              Togli
            </button>
          </div>
        )}

        <div className="space-y-1.5">
          {entries.map((entry) => (
            <ProviderCard
              key={entry.name}
              entry={entry}
              expanded={expanded === entry.name}
              testing={testing === entry.name}
              result={results[entry.name]}
              settings={settings}
              saving={saving}
              modelSharedWith={(modelFieldSiblings.get(PROVIDER_MODEL_FIELD[entry.name] ?? '') ?? [])
                .filter((l) => l !== (entry.label ?? entry.name))}
              onSave={save}
              onToggle={() => setExpanded(expanded === entry.name ? null : entry.name)}
              onSetDefault={() => setDefault(entry.name)}
              onClearDefault={() => clearDefault()}
              onTest={() => test(entry.name)}
              onAfterConfigure={() => { void refresh(entry.name); }}
            />
          ))}
          {entries.length === 0 && (
            <div className="text-[12px] text-app-text-muted">No providers registered.</div>
          )}
          {/* Claude Code non registrato: l'unico interruttore che può farlo
              tornare vive sulla sua card, e senza card non ci sarebbe più. */}
          {settings && !entries.some((e) => e.name === 'claude-code') && (
            <UnregisteredClaudeCode settings={settings} saving={saving} onSave={save} />
          )}
        </div>
        </>}
      </div>

      {/* I consensi permanenti stanno QUI, non in una voce di menu propria: un
          pannello che nella stragrande maggioranza dei casi è vuoto non merita
          un posto fisso in navigazione, ma la lista deve restare raggiungibile —
          è l'unico posto dove un «Consenti sempre» premuto di corsa dentro una
          chat si può rileggere e ritirare. */}
      <div className="pt-5 border-t border-app-border">
        <PermissionsSection />
      </div>
    </div>
  );
}

/**
 * COME si esegue un agente, che è una domanda diversa da CHI risponde.
 *
 * Sta in cima alla scheda e non dentro una card perché non appartiene a nessun
 * provider: governa la meccanica con cui tutte le righe qui sotto vengono
 * eseguite. `cli` è una CLI per sessione in una PTY; `jcode` manda le sessioni
 * dentro un demone condiviso via ACP.
 *
 * Il numero è nel testo, e ci sta per un motivo: è tutta la ragione per cui
 * l'interruttore esiste, ed è misurato su questa macchina, non stimato. Senza
 * il numero la scelta sembra una preferenza di gusto, e nessuno la cambierebbe.
 *
 * Detto com'è, non com'è comodo: il provider si registra all'AVVIO del server
 * (`initProviders`), quindi la scelta vale da lì. Prometterla immediata
 * significherebbe che chi la cambia e non vede cambiare nulla pensa sia rotta.
 */
function AgentRuntimeChoice({
  settings, saving, registered, onSave,
}: {
  settings: AppBehaviorSettings;
  saving: boolean;
  registered: boolean;
  onSave: (patch: Partial<AppBehaviorSettings>) => Promise<void>;
}) {
  const t = useT();
  const chosen = settings.agentRuntime ?? 'cli';
  return (
    <div className="mb-3 rounded-lg border border-app-border bg-surface/40 px-3 py-2">
      <SettingSelect
        label={t('runtime.label')}
        hint={t('runtime.hint')}
        value={settings.agentRuntime}
        disabled={saving}
        autoLabel={t('runtime.cliDefault')}
        onChange={(v) => { void onSave({ agentRuntime: v as AgentRuntime | null }).catch(() => { /* l'errore lo mostra la scheda */ }); }}
        options={[
          { value: 'cli', label: t('runtime.cli') },
          { value: 'jcode', label: t('runtime.jcode') },
        ]}
      />
      <p className="text-[11px] text-app-text-muted break-words">{t('runtime.blurb')}</p>
      {chosen === 'jcode' && !registered && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-app-text-muted border border-dashed border-app-border rounded-md px-2 py-1.5">
          <AlertCircle size={12} className="flex-shrink-0" />
          {/* Scelto ma non presente fra le righe: o il server non è ancora
              ripartito, o `jcode` non è nel PATH — il registro salta gli agenti
              ACP il cui eseguibile non c'è. Sono i due casi veri, e nessuno dei
              due si vede senza dirlo. */}
          <span className="flex-1 break-words">{t('runtime.missing')}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Le impostazioni globali (`/api/app-settings`) come stato unico della scheda.
 *
 * `save` è ottimistica e riconcilia con l'eco del server; `apply` aggiorna la
 * sola copia locale ed esiste per una ragione precisa: `PUT /api/providers/default`
 * scrive la stessa riga passando da un'altra rotta, e senza riallineamento la
 * scheda tornerebbe a mostrare due letture diverse dello stesso campo.
 */
function useBehaviorSettings() {
  const [settings, setSettings] = useState<AppBehaviorSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    appSettingsApi.get()
      .then((s) => { if (live) setSettings(s); })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Failed to load settings'); });
    return () => { live = false; };
  }, []);

  const apply = useCallback((patch: Partial<AppBehaviorSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const save = useCallback(async (patch: Partial<AppBehaviorSettings>) => {
    setSaving(true);
    setError(null);
    apply(patch);
    try {
      const next = await appSettingsApi.update(patch);
      setSettings(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
      // Re-fetch to drop the optimistic value on failure.
      try { setSettings(await appSettingsApi.get()); } catch { /* keep last */ }
      throw e;
    } finally {
      setSaving(false);
    }
  }, [apply]);

  return { settings, saving, error, save, apply };
}

function SettingSelect({
  label, hint, value, options, onChange, disabled, autoLabel = 'Auto (env/default)',
}: {
  label: string;
  hint?: string;
  value: string | null;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string | null) => void;
  disabled?: boolean;
  autoLabel?: string;
}) {
  // `<label>` → `<div>`: il controllo non è più un elemento di modulo nativo,
  // quindi non c'è niente da etichettare per associazione — il nome accessibile
  // viaggia sull'`aria-label` del grilletto. Lasciando la `<label>` il click sul
  // testo avrebbe attivato il bottone, cioè aperto il menu, che è un aggancio
  // che nessuno cerca su una riga di descrizione.
  //
  // `flex-wrap` + `min-w-0`: a 390px la riga etichetta+controllo non ci sta in
  // orizzontale, e senza il ritorno a capo il pannello guadagnava una barra di
  // scorrimento laterale.
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1">
      <span className="flex min-w-0 flex-col">
        <span className="text-[12px] text-app-text">{label}</span>
        {hint && <span className="text-[11px] text-app-text-muted break-words">{hint}</span>}
      </span>
      <Select
        ariaLabel={label}
        disabled={disabled}
        align="right"
        value={value ?? AUTO}
        onChange={(v) => onChange(v === AUTO ? null : v)}
        className="max-w-full flex-shrink-0 min-w-[140px]"
        options={[{ value: AUTO, label: autoLabel }, ...options]}
      />
    </div>
  );
}

interface ProviderCardProps {
  entry: ProviderSnapshotEntry;
  expanded: boolean;
  testing: boolean;
  result?: TestResult;
  settings: AppBehaviorSettings | null;
  saving: boolean;
  /** Altri provider registrati che scrivono nello stesso campo «modello». */
  modelSharedWith: string[];
  onSave: (patch: Partial<AppBehaviorSettings>) => Promise<void>;
  onToggle: () => void;
  onSetDefault: () => void;
  onClearDefault: () => void;
  onTest: () => void;
  onAfterConfigure: () => void;
}

function ProviderCard({
  entry, expanded, testing, result, settings, saving, modelSharedWith,
  onSave, onToggle, onSetDefault, onClearDefault, onTest, onAfterConfigure,
}: ProviderCardProps) {
  // Il badge distingue una SCELTA da un ripiego: `isDefault` dice solo chi è il
  // default adesso, non se qualcuno l'ha deciso. Finché le impostazioni non
  // sono arrivate non lo sappiamo, e il badge resta muto sul come — dire
  // «automatico» in attesa della risposta sarebbe un'affermazione sbagliata
  // mostrata a ogni apertura del pannello.
  const defaultKnown = settings !== null;
  const explicitDefault = settings?.aiProvider === entry.name;
  // `label` arriva SEMPRE dallo snapshot (server/providers/snapshot-manager.ts):
  // una tabella di nomi qui sarebbe la terza copia, e le due precedenti erano
  // già divergenti fra loro.
  const label = entry.label ?? entry.name;
  const modelsCount = entry.models.length;
  // Test connection only makes sense once requirements are met. When the
  // provider is "not set up" (unavailable), there's nothing to test — the user
  // first needs to satisfy the requirements below.
  const canTest = entry.status !== 'unavailable';

  return (
    <div className={`rounded-lg border ${entry.isDefault ? 'border-primary/40 bg-primary/5' : 'border-app-border bg-app-hover/40'}`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left coarse:min-h-11"
      >
        {expanded ? <ChevronDown size={13} className="text-app-text-muted flex-shrink-0" /> : <ChevronRight size={13} className="text-app-text-muted flex-shrink-0" />}
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_COLORS[entry.status]}`} />
        <span className="text-[12px] font-semibold text-app-text">{label}</span>
        <span className="text-[11px] text-app-text-muted">{STATUS_LABELS[entry.status]}</span>
        {entry.version && <span className="text-[11px] text-app-text-muted">· v{entry.version}</span>}
        {modelsCount > 0 && (
          <span className="text-[11px] text-app-text-muted">· {modelsCount} models</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {entry.isDefault && (
            <span
              className="text-[11px] bg-primary/20 text-primary px-1.5 py-0.5 rounded"
              title={!defaultKnown
                ? 'Il provider usato dalle chat che non scelgono.'
                : explicitDefault
                  ? 'Scelto qui: resta anche dopo un riavvio.'
                  : 'Nessuna scelta salvata: lo decide il ripiego (o la variabile AI_PROVIDER). Può cambiare da solo se questo provider va giù.'}
            >
              {defaultKnown && !explicitDefault ? 'Default · automatico' : 'Default'}
            </span>
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-app-border space-y-2">
          {/* Action row */}
          <div className="flex items-center gap-2 flex-wrap">
            {canTest && (
              <button
                onClick={(e) => { e.stopPropagation(); onTest(); }}
                disabled={testing}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-surface border border-app-border hover:bg-app-hover disabled:opacity-50"
              >
                <RefreshCw size={11} className={testing ? 'animate-spin' : ''} />
                Prova la connessione
              </button>
            )}
            {!entry.isDefault && entry.status === 'ready' && (
              <button
                onClick={(e) => { e.stopPropagation(); onSetDefault(); }}
                className="px-2 py-1 rounded-md text-[11px] bg-surface border border-app-border hover:bg-app-hover"
              >
                Imposta come predefinito
              </button>
            )}
            {entry.isDefault && explicitDefault && (
              // Il caso che prima sapeva dire solo la tendina «Auto»: nessuna
              // scelta salvata, decide il server. Senza questo, una volta
              // scelto un default non si poteva più tornare indietro dalla UI.
              <button
                onClick={(e) => { e.stopPropagation(); onClearDefault(); }}
                disabled={saving}
                className="px-2 py-1 rounded-md text-[11px] bg-surface border border-app-border hover:bg-app-hover disabled:opacity-50"
              >
                Togli il default (scegli automaticamente)
              </button>
            )}
            {result && (
              <span className={`text-[11px] flex items-center gap-1 ${result.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                {result.ok ? <Check size={11} /> : <AlertCircle size={11} />}
                {result.message}
              </span>
            )}
          </div>

          {/* Le impostazioni di QUESTO provider */}
          {settings && (
            <ProviderSettings
              entry={entry}
              settings={settings}
              saving={saving}
              modelSharedWith={modelSharedWith}
              onSave={onSave}
            />
          )}

          {/* Binary path */}
          {entry.binaryPath && (
            <div className="text-[11px] text-app-text-muted font-mono break-all">
              {entry.binaryPath}
            </div>
          )}

          {/* Last error (only when no fresh test result has overridden) */}
          {entry.lastError && !result && (
            <div className="flex items-start gap-1.5 text-[11px] text-red-500">
              <AlertCircle size={12} className="flex-shrink-0 mt-0.5" />
              <span className="break-words">{entry.lastError}</span>
            </div>
          )}

          {/* Requirements */}
          {entry.requirements.length > 0 && (
            <div className="space-y-1.5">
              {entry.requirements.map((req) => (
                <RequirementRow key={req.key} req={req} />
              ))}
            </div>
          )}

          {/* Inline configure forms */}
          {entry.name === 'claude' && entry.requirements.some((r) => r.key === 'ANTHROPIC_API_KEY' && !r.present) && (
            <ApiKeyForm provider="claude" placeholder="sk-ant-..." onSaved={onAfterConfigure} />
          )}
          {entry.name === 'openai' && entry.requirements.some((r) => r.key === 'OPENAI_API_KEY' && !r.present) && (
            <ApiKeyForm provider="openai" placeholder="sk-..." onSaved={onAfterConfigure} />
          )}

          {/* Freshness footer */}
          {entry.fetchedAt && (
            <div className="text-[11px] text-app-text-muted pt-1">
              Updated {relativeTime(entry.fetchedAt)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Il blocco «come lavora questo provider»: il modello di default più le manopole
 * che gli appartengono.
 *
 * Ogni controllo scrive un campo di `app_settings` che ESISTEVA GIÀ ed era già
 * letto dal server — mancava solo la superficie che lo scrivesse. Il modello in
 * particolare era il caso peggiore: l'unica UI che lo cambiava (il picker dentro
 * la card espansa) non lo persisteva affatto, teneva la scelta in
 * `localStorage` — quindi il «default» era per-DISPOSITIVO — e la ri-applicava
 * al boot passando da `registerProvider`, che ferma il provider e con lui i
 * processi CLI vivi. Cambiare un default uccideva le chat in corso.
 *
 * Quando un valore vale è scritto sul singolo controllo, perché NON è lo stesso
 * per tutti: gli effort il server li rilegge dal DB a ogni spawn, il modello e
 * la modalità di approvazione entrano nella config del provider all'avvio.
 */
function ProviderSettings({
  entry, settings, saving, modelSharedWith, onSave,
}: {
  entry: ProviderSnapshotEntry;
  settings: AppBehaviorSettings;
  saving: boolean;
  modelSharedWith: string[];
  onSave: (patch: Partial<AppBehaviorSettings>) => Promise<void>;
}) {
  const save = (patch: Partial<AppBehaviorSettings>) => { void onSave(patch).catch(() => { /* l'errore lo mostra la scheda */ }); };

  const modelField = PROVIDER_MODEL_FIELD[entry.name];
  const modelValue = modelField ? settings[modelField] : null;
  // La lista dei modelli arriva dal provider; se il valore salvato non c'è
  // (modello ritirato, cache fredda) va comunque mostrato — altrimenti la
  // tendina mostrerebbe il primo della lista e chi guarda crederebbe che sia
  // quello in uso, senza un modo per cancellare il valore vecchio.
  const modelOptions = useMemo(() => {
    const all = [...entry.models];
    if (modelValue && !all.includes(modelValue)) all.unshift(modelValue);
    return all.map((m) => ({ value: m, label: m }));
  }, [entry.models, modelValue]);

  const rows: ReactNode[] = [];

  if (modelField && modelOptions.length > 0) {
    const shared = modelSharedWith.length > 0
      ? ` Lo stesso campo vale anche per ${modelSharedWith.join(', ')}.`
      : '';
    rows.push(
      <SettingSelect
        key="model"
        label="Modello di default"
        // Il valore in uso ORA lo dichiara il provider (`defaultModel()` nello
        // snapshot). Finché la config viva non rilegge l'impostazione, i due
        // possono differire fino al riavvio: meglio dirlo che far credere che
        // la scelta sia già in vigore.
        hint={`${entry.defaultModel ? `In uso ora: ${entry.defaultModel}. ` : ''}Vale dal prossimo avvio del server.${shared}`}
        value={modelValue}
        disabled={saving}
        onChange={(v) => save({ [modelField]: v } as Partial<AppBehaviorSettings>)}
        options={modelOptions}
        autoLabel="Auto (lo decide il provider)"
      />,
    );
  }

  if (entry.name === 'claude-code') {
    rows.push(
      <SettingSelect
        key="effort"
        label="Effort"
        hint="Vale dalla prossima sessione. Una chat può cambiarlo per sé."
        value={settings.claudeEffort}
        disabled={saving}
        onChange={(v) => save({ claudeEffort: v })}
        options={EFFORT_TIERS.map((v) => ({ value: v, label: v }))}
      />,
      <SettingSelect
        key="enabled"
        label="Attivazione"
        // Detto com'è, non com'è comodo: il server registra claude-code se la
        // CLI c'è OPPURE se il flag è acceso (providers/index.ts, initProviders).
        // Quindi «Disattivo» spegne solo il ramo forzato — con la CLI nel PATH
        // il provider resta. Un'etichetta simmetrica prometterebbe un
        // interruttore che non esiste.
        hint="Auto rileva la CLI. «Attivo» lo registra anche senza CLI; «Disattivo» non lo toglie se la CLI c'è."
        value={enabledToSelect(settings.claudeCodeEnabled)}
        disabled={saving}
        onChange={(v) => save({ claudeCodeEnabled: selectToEnabled(v) })}
        options={[
          { value: 'on', label: 'Attivo' },
          { value: 'off', label: 'Disattivo' },
        ]}
      />,
    );
  }

  if (entry.name === 'codex') {
    rows.push(
      <SettingSelect
        key="reasoning"
        label="Reasoning effort"
        hint="Vale dal prossimo turno."
        value={settings.codexReasoningEffort}
        disabled={saving}
        onChange={(v) => save({ codexReasoningEffort: v })}
        options={CODEX_REASONING_EFFORTS.map((v) => ({ value: v, label: v }))}
      />,
      <SettingSelect
        key="approval"
        label="Modalità di approvazione"
        hint="Vale dal prossimo avvio del server."
        value={settings.codexApprovalMode}
        disabled={saving}
        onChange={(v) => save({ codexApprovalMode: v })}
        options={[
          { value: 'auto', label: 'auto' },
          { value: 'full-access', label: 'full-access' },
        ]}
      />,
    );
  }

  if (rows.length === 0) return null;

  return <div className="rounded-md border border-app-border bg-surface/40 px-2.5 py-1.5">{rows}</div>;
}

/**
 * Claude Code non è registrato: nessuna card, quindi nessun posto dove dire
 * «provaci lo stesso».
 *
 * Il server registra il provider se la CLI c'è OPPURE se `claudeCodeEnabled` è
 * forzato (server/providers/index.ts, initProviders). Quel «oppure» era
 * raggiungibile solo dalla tendina globale appena rimossa: senza questa riga,
 * chi non ha la CLI nel PATH non avrebbe più nessun modo di forzarlo dalla UI.
 */
function UnregisteredClaudeCode({
  settings, saving, onSave,
}: {
  settings: AppBehaviorSettings;
  saving: boolean;
  onSave: (patch: Partial<AppBehaviorSettings>) => Promise<void>;
}) {
  return (
    <div className="rounded-lg border border-dashed border-app-border px-3 py-2">
      <div className="text-[12px] font-semibold text-app-text">Claude Code</div>
      <div className="text-[11px] text-app-text-muted mb-1">
        Non registrato: la CLI <span className="font-mono">claude</span> non è stata trovata.
      </div>
      <SettingSelect
        label="Attivazione"
        hint="Forzarla lo registra al prossimo avvio del server, anche senza CLI rilevata."
        value={enabledToSelect(settings.claudeCodeEnabled)}
        disabled={saving}
        onChange={(v) => { void onSave({ claudeCodeEnabled: selectToEnabled(v) }).catch(() => { /* l'errore lo mostra la scheda */ }); }}
        options={[
          { value: 'on', label: 'Attivo' },
          { value: 'off', label: 'Disattivo' },
        ]}
      />
    </div>
  );
}

function RequirementRow({ req }: { req: { key: string; label: string; present: boolean; hint?: string } }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!req.hint) return;
    const cmd = req.hint.match(/Run [^:]*:\s*(.+)/)?.[1]
      ?? req.hint.match(/→\s*(.+)/)?.[1]
      ?? req.hint;
    navigator.clipboard.writeText(cmd.trim()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      // Clipboard write can be rejected (no permission / insecure context) —
      // swallow it so it doesn't surface as an unhandled rejection.
    });
  };

  return (
    <div className="text-[11px]">
      <div className="flex items-center gap-1.5">
        {req.present ? (
          <Check size={12} className="text-green-500 flex-shrink-0" />
        ) : (
          <X size={12} className="text-red-500 flex-shrink-0" />
        )}
        <span className={req.present ? 'text-app-text-secondary' : 'text-app-text'}>{req.label}</span>
      </div>
      {!req.present && req.hint && (
        <div className="ml-5 mt-0.5 flex items-start gap-1.5 text-app-text-muted">
          <span className="break-words flex-1">{req.hint}</span>
          <button
            onClick={copy}
            className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface border border-app-border hover:bg-app-hover text-[11px]"
            title="Copy"
          >
            <Copy size={10} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  );
}

function ApiKeyForm({ provider, placeholder, onSaved }: { provider: 'claude' | 'openai'; placeholder: string; onSaved: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (provider === 'claude') await providersApi.configureClaude(apiKey.trim());
      else await providersApi.configureOpenAI(apiKey.trim());
      setApiKey('');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save key');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pt-1">
      <div className="flex gap-1.5">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={placeholder}
          className="flex-1 min-w-0 px-2 py-1 rounded-md text-[11px] bg-surface border border-app-border text-app-text placeholder:text-app-text-muted focus:outline-none focus:border-primary/50"
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button
          onClick={submit}
          disabled={saving || !apiKey.trim()}
          className="px-2 py-1 rounded-md text-[11px] font-medium bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {saving ? '…' : 'Save'}
        </button>
      </div>
      {error && (
        <div className="mt-1 text-[11px] text-red-500">{error}</div>
      )}
    </div>
  );
}
