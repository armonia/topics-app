/** Settings · Anonymization (`g02`): what the AI sees, the rules with a switch for each kind of data, and a live trial. */
import { Plus, ShieldAlert, X } from 'lucide-react';
import type { ScreenCtx } from '../../kit';
import { settingsFrame } from '../settings-frame';
import { Block, Callout, KindChip, SettingRow } from '../../../../ui/settings/Block';
import { MappingTable, ReplyText, SentText, TopicsText } from '../../../../ui/settings/Anonymization';
import { ANON_CATEGORIES, anonymize, replyParts, type AnonCategory } from '../../../../ui/settings/anonymize';
import { Tabs } from '../../../../ui/primitives/Tabs';
import { Toggle, TextArea, TextField } from '../../../../ui/primitives/Field';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { EmptyState } from '../../../../ui/primitives/EmptyState';
import { KeyValue } from '../../../../ui/primitives/Panel';
import { ANON_MONTHLY, ANON_OVERHEAD_MS, ANON_REPLY, ANON_SAMPLE } from '../../../../ui/fixtures/settings';
import { adminGate } from './helpers';

type Tab = 'see' | 'rules' | 'try';

interface AnonState {
  on: boolean;
  categories: Record<AnonCategory, boolean>;
  terms: string[];
}

const INITIAL: AnonState = {
  on: true,
  categories: { 'fiscal-code': true, 'vat-iban': true, names: true, contacts: true },
  terms: [],
};

export function AnonymizationPage({ ctx }: { ctx: ScreenCtx }) {
  const c = ctx.copy.settings;
  const a = c.anonymization;
  const gate = adminGate(ctx);
  const [st, setSt] = ctx.slice<AnonState>('anonymization', INITIAL);
  const [tab, setTab] = ctx.ui<Tab>('anon.tab', 'see');
  const [trial, setTrial] = ctx.ui<string>('anon.trial', '');
  const [term, setTerm] = ctx.ui<string>('anon.term', '');
  const [termError, setTermError] = ctx.ui<boolean>('anon.termError', false);

  /* With the whole service off nothing is replaced, not even the extra words. */
  const effective = st.on ? st.categories : { 'fiscal-code': false, 'vat-iban': false, names: false, contacts: false };
  const terms = st.on ? st.terms : [];
  const sample = anonymize(ANON_SAMPLE, effective, terms);
  const tried = anonymize(trial, effective, terms);

  const log = (what: string) => ctx.log(what, 'setting', ctx.path);

  const setMaster = (next: boolean) => {
    const apply = () => {
      setSt((prev) => ({ ...prev, on: next }));
      log(c.common.changedTo(a.side.masterLabel, next ? c.common.on : c.common.off));
      ctx.toast({ tone: next ? 'ok' : 'warn', title: c.common.saved(a.side.masterLabel) });
    };
    if (next) apply();
    else ctx.confirm({ ...a.side.confirmOff, confirmLabel: a.side.confirmOff.label, tone: 'danger', onConfirm: apply });
  };

  const toggleCategory = (cat: AnonCategory, next: boolean) => {
    setSt((prev) => ({ ...prev, categories: { ...prev.categories, [cat]: next } }));
    log(a.rules.toggled(a.rules.categories[cat].name, next));
  };

  const addTerm = () => {
    const t = term.trim();
    if (!t) return;
    if (st.terms.some((x) => x.toLowerCase() === t.toLowerCase())) return setTermError(true);
    setSt((prev) => ({ ...prev, terms: [...prev.terms, t] }));
    setTerm('');
    setTermError(false);
    log(`${a.rules.custom.title}: ${t}`);
    ctx.toast({ tone: 'ok', title: c.common.saved(a.rules.custom.title), body: t });
  };

  const removeTerm = (t: string) => {
    setSt((prev) => ({ ...prev, terms: prev.terms.filter((x) => x !== t) }));
    log(`${a.rules.custom.title}: ${c.common.remove} ${t}`);
  };

  const monthlyTotal = ANON_CATEGORIES.reduce((n, k) => n + ANON_MONTHLY[k], 0);
  const number = (n: number) => n.toLocaleString('it-IT');

  const replyAi = replyParts(ANON_REPLY, sample.table, 'ai', a.fallbackReply);
  const replyTopics = replyParts(ANON_REPLY, sample.table, 'topics', a.fallbackReply);
  const clearCount = tried.table.filter((e) => !e.masked).length;
  const maskedCount = tried.table.length - clearCount;

  return settingsFrame(ctx, 'anonimizzazione', {
    actions: <Chip tone={st.on ? 'green' : 'red'}>{st.on ? a.side.chip : a.side.chipOff}</Chip>,
    children: (
      <div className="flex flex-col gap-4">
        <Block>
          <SettingRow
            label={a.side.masterLabel}
            description={a.side.how.text}
            control={<Toggle checked={st.on} onChange={setMaster} disabled={gate.disabled} title={gate.title ?? a.side.masterLabel} />}
          />
        </Block>
        {!st.on && <Callout icon={ShieldAlert} tone="red">{a.side.offWarning}</Callout>}

        <Tabs<Tab>
          ariaLabel={a.side.masterLabel}
          value={tab}
          onChange={setTab}
          options={[{ value: 'see', label: a.tabs.see }, { value: 'rules', label: a.tabs.rules }, { value: 'try', label: a.tabs.try }]}
        />

        {tab === 'see' && (
          <div className="flex flex-col gap-4">
            <div className="grid min-w-0 gap-3 md:grid-cols-2">
              <Block title={a.see.inTopics} actions={<><Chip>{a.see.example}</Chip><Chip>{a.see.stays}</Chip></>}>
                <TopicsText segments={sample.segments} title={a.see.inTopics} />
              </Block>
              <Block title={a.see.sent} actions={<Chip tone="violet">{a.see.leaves}</Chip>} className="border-violet-500/40">
                <SentText segments={sample.segments} title={a.see.sent} />
              </Block>
            </div>
            <Block title={a.see.reply}>
              <p className="text-prose leading-6 text-app-text">
                <span className="text-app-text-tertiary">{a.see.fromAi} </span>
                <ReplyText parts={replyAi} />
                <span className="ml-3 text-app-text-tertiary">{a.see.inTopicsLabel} </span>
                <ReplyText parts={replyTopics} />
              </p>
            </Block>
          </div>
        )}

        {tab === 'rules' && (
          <div className="flex flex-col gap-4">
            <Block bodyClassName="p-0 pt-0" className="overflow-hidden">
              <div role="table" aria-label={a.tabs.rules}>
                <div role="row" className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,1fr)_100px_56px] gap-3 border-b border-app-border bg-app-inset px-3 py-2 text-compact font-medium text-app-text-secondary md:grid">
                  <span role="columnheader">{a.rules.columns.data}</span>
                  <span role="columnheader">{a.rules.columns.how}</span>
                  <span role="columnheader">{a.rules.columns.becomes}</span>
                  <span role="columnheader" className="text-right">{a.rules.columns.monthly}</span>
                  <span role="columnheader" />
                </div>
                {ANON_CATEGORIES.map((k) => (
                  <div key={k} role="row" className="grid items-center gap-x-3 gap-y-1 border-b border-app-border px-3 py-2.5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,1fr)_100px_56px]">
                    <span role="cell" className="text-prose font-semibold text-app-text">{a.rules.categories[k].name}</span>
                    <span role="cell" className="text-compact text-app-text-secondary">{a.rules.categories[k].how}</span>
                    <span role="cell" className="font-mono text-compact text-violet-800 dark:text-violet-300">{a.rules.categories[k].becomes}</span>
                    <span role="cell" className="text-compact tabular-nums text-app-text md:text-right">{number(ANON_MONTHLY[k])}</span>
                    <span role="cell" className="md:justify-self-end">
                      <Toggle checked={st.categories[k]} onChange={(next) => toggleCategory(k, next)} disabled={gate.disabled || !st.on} title={gate.title ?? (st.on ? a.rules.categories[k].name : a.side.chipOff)} />
                    </span>
                  </div>
                ))}
                <div role="row" className="grid items-center gap-x-3 gap-y-1 border-b border-app-border px-3 py-2.5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,1fr)_100px_56px]">
                  <span role="cell" className="text-prose font-semibold text-app-text">{a.rules.cadastral.name}</span>
                  <span role="cell" className="text-compact text-app-text-secondary">{a.rules.cadastral.how}</span>
                  <span role="cell" className="text-compact text-app-text-secondary md:col-span-3">{a.rules.cadastral.becomes}</span>
                </div>
                <div role="row" className="flex items-center gap-3 px-3 py-2 text-compact">
                  <span className="flex-1 font-semibold text-app-text">{a.rules.total}</span>
                  <KindChip kind="estimate" label={c.common.kinds.estimate} />
                  <span className="tabular-nums text-app-text">{number(monthlyTotal)}</span>
                </div>
              </div>
            </Block>

            <Block title={a.rules.custom.title} description={a.rules.custom.hint} bodyClassName="flex flex-col gap-3">
              <div className="flex flex-wrap items-start gap-2">
                <TextField
                  size="sm"
                  value={term}
                  onChange={(v) => { setTerm(v); if (termError) setTermError(false); }}
                  onEnter={ctx.allow('admin', addTerm) || undefined}
                  placeholder={a.rules.custom.placeholder}
                  error={termError ? a.rules.custom.duplicate : undefined}
                  disabled={gate.disabled}
                  title={gate.title}
                  className="min-w-[220px] flex-1"
                />
                <Button variant="secondary" icon={Plus} onClick={ctx.allow('admin', addTerm)} title={gate.title}>{a.rules.custom.add}</Button>
              </div>
              {st.terms.length === 0 ? (
                <p className="text-compact text-app-text-tertiary">{a.rules.custom.empty}</p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {st.terms.map((t) => (
                    <li key={t} className="inline-flex items-center gap-1 rounded-lg bg-black/[0.05] py-0.5 pl-2.5 pr-1 text-prose text-app-text dark:bg-white/10">
                      {t}
                      <Button size="sm" variant="ghost" icon={X} onClick={ctx.allow('admin', () => removeTerm(t))} title={gate.title ?? a.rules.custom.remove(t)}><span className="sr-only">{a.rules.custom.remove(t)}</span></Button>
                    </li>
                  ))}
                </ul>
              )}
            </Block>

            <Block title={a.rules.exceptions.title}>
              <KeyValue label={a.rules.exceptions.health} value={a.rules.exceptions.healthValue} />
              <KeyValue label={a.rules.exceptions.table} value={a.rules.exceptions.tableValue} />
              <KeyValue label={a.side.goals.real} value={a.side.goals.realValue} />
              <KeyValue label={a.side.goals.sample} value={a.side.goals.sampleValue} />
              <KeyValue label={a.side.goals.overhead} value={a.side.goals.overheadValue(ANON_OVERHEAD_MS)} />
              <p className="mt-2 text-compact leading-4 text-app-text-tertiary">{a.side.base.text}</p>
            </Block>
          </div>
        )}

        {tab === 'try' && (
          <div className="flex flex-col gap-4">
            <Block
              title={a.tabs.try}
              description={a.try.intro}
              actions={
                <>
                  <Button variant="secondary" onClick={() => setTrial(ANON_SAMPLE)}>{a.try.useSample}</Button>
                  {trial !== '' && <Button variant="ghost" onClick={() => setTrial('')}>{a.try.clear}</Button>}
                </>
              }
            >
              <TextArea label={a.try.input} value={trial} onChange={setTrial} placeholder={a.try.placeholder} rows={5} />
            </Block>

            {trial.trim() === '' ? (
              <Block><EmptyState icon={ShieldAlert} title={a.try.empty.title} className="min-h-0 py-6">{a.try.empty.body}</EmptyState></Block>
            ) : (
              <>
                <div className="grid min-w-0 gap-3 md:grid-cols-2">
                  <Block title={a.try.input}><TopicsText segments={tried.segments} title={a.try.input} /></Block>
                  <Block title={a.try.output} actions={<Chip tone={maskedCount > 0 ? 'violet' : 'neutral'}>{a.try.found(maskedCount)}</Chip>} className="border-violet-500/40">
                    <SentText segments={tried.segments} title={a.try.output} />
                  </Block>
                </div>
                {tried.table.length === 0 ? (
                  <Callout tone="green" icon={ShieldAlert}>{a.try.none}</Callout>
                ) : (
                  <Block title={a.try.table.title} description={a.try.table.note}>
                    <MappingTable rows={tried.table} labels={a.try.table} />
                  </Block>
                )}
                {clearCount > 0 && <Callout tone="amber" icon={ShieldAlert}>{a.side.offWarning}</Callout>}
              </>
            )}
          </div>
        )}
      </div>
    ),
  });
}
