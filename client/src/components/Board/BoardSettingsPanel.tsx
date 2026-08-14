/**
 * IL PANNELLO DELLE IMPOSTAZIONI DELLA BOARD.
 *
 * Viveva in fondo a `TaskDetail.tsx` insieme al cassetto di una card, e le due
 * cose non c'entrano niente l'una con l'altra: una configura il PROGETTO, l'altro
 * mostra un TASK. Stavano insieme per come sono cresciute, non per una ragione.
 *
 * Il file da cui esce era a 3.241 righe, il piu' grosso del client. Il conto non
 * scende perche' spezzare fa bene in astratto: scende perche' questo pezzo ha un
 * confine vero — non condivide stato con il cassetto, e il suo unico chiamante
 * (`KanbanBoardPane`) lo importava gia' per nome.
 *
 * Le RIGHE del pannello stanno un gradino piu' sotto, in `BoardSettingsSections.tsx`:
 * questo file tiene la struttura e le sezioni, non i singoli interruttori.
 */
import { useState } from 'react';
import { useT } from '../../hooks/useT';
import { Select } from '../Shared/Select';
import { boardApi, type BoardSettings, type BoardSettingsPatch, type ReviewCheck } from '../../lib/board';
import { NightModeCard } from './NightModeCard';
import { EFFORTS, FANOUT_CHOICES } from './constants';
import { friendlyModelLabel } from './format';
import {
  GlobalSettingsSection,
  SettingsPanelHead,
  SETTINGS_PANEL_SHELL,
} from './BoardSettingsSections';

export function BoardSettingsPanel({ projectId, settings: s, dispatchOn, models, onToggleDispatch, onChanged, onClose, onError }: {
  projectId: string;
  /** Owned by the board (per-project config) — this panel only renders and patches it. */
  settings: BoardSettings | null;
  /** The GLOBAL start switch — owned by the board header (same value as the pill). */
  dispatchOn: boolean | null;
  /** Model ids from the provider snapshot (for the board-default picker). */
  models: string[];
  onToggleDispatch: () => void;
  onChanged: (s: BoardSettings) => void;
  onClose: () => void;
  onError: (e: string) => void;
}) {
  const tr = useT();
  const patch = async (p: BoardSettingsPatch) => {
    try { onChanged(await boardApi.updateSettings(projectId, p)); }
    catch (e) { onError(e instanceof Error ? e.message : 'settings save failed'); }
  };
  if (!s) return null;
  return (
    <div className={SETTINGS_PANEL_SHELL} data-testid="board-settings-panel">
      <SettingsPanelHead onClose={onClose} />

      {/* PRIMA sezione, e la sola che NON è di questa board: l'interruttore e il
          tetto sono quelli globali, gli stessi del ▾ in testata. Senza il titolo
          sopra, la prima riga di una lista piatta si leggeva come «auto-dispatch
          di questo progetto» — cioè come un'impostazione che qui non esiste.
          Le righe stanno in `BoardSettingsSections.tsx` perché il pannello della
          board generale monta le STESSE: un blocco, due pannelli. */}
      <SettingsSection label={tr('board.settings.sec.global')} first>
        <GlobalSettingsSection dispatchOn={dispatchOn} onToggleDispatch={onToggleDispatch} />
        {dispatchOn && (
          <p className="text-[11px] text-amber-300/80">{tr('board.settings.dispatchOnActive')}</p>
        )}
      </SettingsSection>

      <SettingsSection label={tr('board.settings.sec.agent')}>
      <div className="flex items-center justify-between gap-2">
        <span>{tr('board.settings.effort')}</span>
        <div className="flex gap-0.5">
          {EFFORTS.map((ef) => (
            <button
              key={ef} onClick={() => patch({ dispatchEffort: ef })}
              className={`rounded px-1.5 py-0.5 ${s.dispatchEffort === ef ? 'bg-emerald-500/80 text-white' : 'bg-white/5 text-app-text-secondary hover:bg-white/10'}`}
            >{ef}</button>
          ))}
        </div>
      </div>

      {/* `<label>` → `<div>`: da quando il controllo è il `Select` dell'app e
          non un elemento di modulo nativo non c'è più niente da associare, e
          una `<label>` intorno a un bottone renderebbe cliccabile — cioè
          apribile — anche il testo della riga. */}
      <div className="flex items-center justify-between gap-2" title={tr('board.settings.modelTitle')}>
        <span>{tr('board.settings.model')}</span>
        <Select
          value={s.dispatchModel || 'auto'}
          onChange={(v) => patch({ dispatchModel: v })}
          ariaLabel={tr('board.settings.model')}
          align="right"
          className="max-w-[55%]"
          options={[
            { value: 'auto', label: tr('board.settings.modelAuto') },
            ...models.map((m) => ({ value: m, label: friendlyModelLabel(m) })),
          ]}
        />
      </div>

      {/* Gemella della tendina in Impostazioni → Aspetto, e per «gemella» si
          intende lo stesso VALORE EFFETTIVO: «Come le Impostazioni» non copia
          la scelta globale, la EREDITA (il ripiego lo fa il server, in un punto
          solo). Copiare il valore vorrebbe dire che cambiare la preferenza
          globale non muove le board che l'avevano già letta. */}
      <div
        className="flex items-center justify-between gap-2"
        title={tr('board.settings.responseLanguageTitle')}
      >
        <span>{tr('board.settings.responseLanguage')}</span>
        <Select
          value={s.language || 'inherit'}
          onChange={(v) => patch({ language: v })}
          ariaLabel={tr('board.settings.responseLanguage')}
          align="right"
          className="max-w-[55%]"
          testId="board-language"
          options={[
            { value: 'inherit', label: tr('board.settings.langInherit') },
            { value: 'it', label: 'Italiano' },
            { value: 'en', label: 'English' },
          ]}
        />
      </div>

      <label className="flex cursor-pointer items-center justify-between" title={tr('board.settings.fullMcpTitle')}>
        <span>{tr('board.settings.fullMcp')}</span>
        <input type="checkbox" checked={s.dispatchMcp === 'inherit'} onChange={(e) => patch({ dispatchMcp: e.target.checked ? 'inherit' : 'bridge-only' })} className="h-3.5 w-3.5 accent-emerald-500" />
      </label>
      </SettingsSection>

      <SettingsSection label={tr('board.settings.sec.where')}>
      <label className="flex cursor-pointer items-center justify-between">
        <span>{tr('board.settings.isolateWorktree')}</span>
        <input type="checkbox" checked={s.dispatchUseWorktree} onChange={(e) => patch({ dispatchUseWorktree: e.target.checked })} className="h-3.5 w-3.5 accent-emerald-500" />
      </label>

      <label
        className="flex items-center justify-between gap-2"
        title={tr('board.settings.fanoutTitle')}
      >
        <span>{tr('board.settings.fanout')} <span className="text-app-text-muted">(fan-out)</span></span>
        <div className="flex gap-0.5">
          {FANOUT_CHOICES.map((n: number) => (
            <button
              key={n}
              disabled={!s.dispatchUseWorktree}
              onClick={() => patch({ dispatchFanOut: n })}
              className={`rounded px-1.5 py-0.5 disabled:opacity-40 ${
                (s.dispatchFanOut || 1) === n ? 'bg-emerald-500/80 text-white' : 'bg-white/5 text-app-text-secondary enabled:hover:bg-white/10'
              }`}
            >{n}</button>
          ))}
        </div>
      </label>
      {s.dispatchUseWorktree && (s.dispatchFanOut || 1) > 1 && (
        <p className="text-[11px] text-amber-300/80">
          {tr('board.settings.fanoutWarn', { n: s.dispatchFanOut ?? 1 })}
        </p>
      )}

      {/* La condizione del BOARD, detta dove si accende l'impostazione invece
          che scoperta a ogni task. Prima ogni dispatch moriva con «worktree
          richiesto ma il progetto non è un repo git registrato»: il messaggio
          era corretto e arrivava alla persona sbagliata. */}
      {s.dispatchUseWorktree && (s as { worktreeReady?: boolean }).worktreeReady === false && (
        <p className="text-[11px] leading-snug text-amber-300/90">
          {tr('board.settings.notRepoWarn')}
        </p>
      )}
      </SettingsSection>

      {/* La modalità notturna ha una CARD sua, non una casella in mezzo alle
          altre: l'interruttore è la parte piccola, la parte utile è lo stato —
          sta dispacciando o è in attesa, e per quale motivo. Vedi
          `NightModeCard.tsx`. */}
      <SettingsSection label={tr('board.settings.sec.when')}>
        <NightModeCard
          projectId={projectId}
          enabled={!!s.nightMode}
          until={s.nightModeUntil || '10:00'}
          onChange={patch}
        />
      </SettingsSection>

      {/* Auto-merge e checks stanno insieme perché parlano dello stesso momento:
          l'agent ha consegnato. Uno decide se quel lavoro entra in main da solo,
          l'altro cosa deve passare prima che entri in review. Erano separati da
          una riga sulla MCP, che è di un altro discorso. */}
      <SettingsSection label={tr('board.settings.sec.delivery')}>
        <label className="flex cursor-pointer items-center justify-between" title={tr('board.settings.autoMergeTitle')}>
          <span>{tr('board.settings.autoMerge')}</span>
          <input type="checkbox" checked={s.dispatchAutoMerge} disabled={!s.dispatchUseWorktree} onChange={(e) => patch({ dispatchAutoMerge: e.target.checked })} className="h-3.5 w-3.5 accent-emerald-500 disabled:opacity-40" />
        </label>
        <ReviewChecksField checks={s.reviewChecks} onSave={(reviewChecks) => patch({ reviewChecks })} />
      </SettingsSection>
    </div>
  );
}

/**
 * UNA SEZIONE DEL PANNELLO — un titolo e le sue righe.
 *
 * Il pannello era dieci righe di seguito, tutte con lo stesso peso: effort,
 * modello, lingua, worktree, fan-out, notturna, auto-merge, MCP, checks. Senza
 * gerarchia non si legge, si scandisce — e soprattutto la prima riga era
 * l'interruttore GLOBALE, che in cima a una lista piatta si legge come
 * un'impostazione di questa board («le impostazioni della board non mi sembrano
 * ben fatte», chi usa la app, 13/08).
 *
 * Il titolo non è decorazione: è la risposta alla domanda che ogni riga
 * poneva da sola — «questo vale per chi?». Il filetto sopra separa i gruppi
 * SENZA aggiungere una seconda scatola: il pannello è già dentro un bordo, e un
 * riquadro dentro un riquadro renderebbe ogni gruppo un oggetto a sé.
 */
function SettingsSection({ label, first, children }: { label: string; first?: boolean; children: React.ReactNode }) {
  return (
    <div className={first ? 'space-y-2' : 'space-y-2 border-t border-app-border-subtle pt-2'}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">{label}</p>
      {children}
    </div>
  );
}

/**
 * I comandi del gate pre-review, uno per riga. Testo libero e non una lista di
 * checkbox su script noti: i comandi buoni sono composti (`bun run typecheck &&
 * bun test`), cambiano da board a board, e un menu di scelte fisse costringerebbe
 * a scegliere quello sbagliato.
 *
 * Si salva su blur / ⌘↵ e non a ogni tasto: un PATCH per carattere farebbe partire
 * un salvataggio a metà comando.
 */
function ReviewChecksField({ checks, onSave }: { checks: ReviewCheck[]; onSave: (c: ReviewCheck[]) => void }) {
  const tr = useT();
  const asText = (list: ReviewCheck[]) => list.map((c) => c.cmd).join('\n');
  const saved = asText(checks);
  // `null` = allineato al server, e il testo mostrato È quello salvato. Niente
  // copia locale da tenere in sync con un effect: se le impostazioni cambiano da
  // un'altra finestra (o il parser normalizza quello che ho scritto) il campo
  // segue da solo, ma solo finché non ho modifiche non salvate sotto le dita.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? saved;
  const dirty = draft !== null;

  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const next = text.split('\n').map((l) => l.trim()).filter(Boolean).map((cmd) => ({ name: cmd, cmd }));
    if (asText(next) === saved) return;
    onSave(next);
  };

  return (
    <div className="space-y-1">
      <label
        className="flex items-center justify-between gap-2"
        title={tr('board.settings.checksTitle')}
      >
        <span>{tr('board.settings.checks')} <span className="text-app-text-muted">(un comando per riga)</span></span>
        {checks.length > 0 && <span className="text-[10px] text-app-text-muted">{checks.length}/5</span>}
      </label>
      <textarea
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }}
        rows={Math.min(5, Math.max(2, text.split('\n').length))}
        spellCheck={false}
        placeholder={'bun run typecheck\nbun test'}
        className="w-full resize-none rounded bg-white/5 px-1.5 py-1 font-mono text-[11px] text-app-text outline-none placeholder:text-app-placeholder focus:bg-white/10"
      />
      {dirty && <p className="text-[10px] text-app-text-muted">Salva uscendo dal campo (o ⌘↵).</p>}
    </div>
  );
}
