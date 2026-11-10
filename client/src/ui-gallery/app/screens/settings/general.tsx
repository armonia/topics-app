/** Settings · General (`set-general`): the organization, language and time, notifications, its facts, and the demo reset. */
import { RotateCcw } from 'lucide-react';
import type { ScreenCtx } from '../../kit';
import { settingsFrame } from '../settings-frame';
import { Block, SettingRow, Callout } from '../../../../ui/settings/Block';
import { TextField, Select, Toggle } from '../../../../ui/primitives/Field';
import { Button } from '../../../../ui/primitives/Button';
import { Source } from '../../../../ui/primitives/Source';
import { KeyValue } from '../../../../ui/primitives/Panel';
import { Info } from 'lucide-react';
import { NOTIFICATION_KEYS, ORG_FACTS, ORG_IDENTITY, TIME_ZONES, type NotificationKey } from '../../../../ui/fixtures/settings';
import { adminGate } from './helpers';

interface GeneralState {
  name: string;
  shortName: string;
  seat: string;
  language: 'it' | 'en';
  timeZone: string;
  notifications: Record<NotificationKey, boolean>;
}

const INITIAL: GeneralState = {
  name: ORG_IDENTITY.fullName,
  shortName: ORG_IDENTITY.shortName,
  seat: ORG_IDENTITY.seat,
  language: 'it',
  timeZone: ORG_IDENTITY.timeZone,
  notifications: { deadlines: true, failures: true, digest: true, jobs: false },
};

type TextKey = 'name' | 'shortName' | 'seat';

export function GeneralPage({ ctx }: { ctx: ScreenCtx }) {
  const c = ctx.copy.settings;
  const g = c.general;
  const gate = adminGate(ctx);
  const [saved, setSaved] = ctx.slice<GeneralState>('settings.general', INITIAL);
  const [draft, setDraft] = ctx.ui<Partial<Record<TextKey, string>>>('general.draft', {});

  const labels: Record<TextKey, string> = { name: g.identity.name, shortName: g.identity.shortName, seat: g.identity.seat };
  const dirtyKeys = (Object.keys(draft) as TextKey[]).filter((k) => draft[k] !== undefined && draft[k] !== saved[k]);

  const edit = (key: TextKey, value: string) => setDraft((prev) => ({ ...prev, [key]: value }));
  const saveDrafts = () => {
    const changed = dirtyKeys;
    if (!changed.length) return;
    setSaved((prev) => ({ ...prev, ...Object.fromEntries(changed.map((k) => [k, (draft[k] ?? '').trim() || prev[k]])) }));
    setDraft({});
    for (const k of changed) ctx.log(c.common.changedTo(labels[k], (draft[k] ?? '').trim()), 'setting', ctx.path);
    ctx.toast({ tone: 'ok', title: c.common.saved(changed.map((k) => labels[k]).join(', ')) });
  };
  const discardDrafts = () => setDraft({});

  const change = <K extends keyof GeneralState>(key: K, value: GeneralState[K], label: string, shown: string) => {
    setSaved((prev) => ({ ...prev, [key]: value }));
    ctx.log(c.common.changedTo(label, shown), 'setting', ctx.path);
    ctx.toast({ tone: 'ok', title: c.common.saved(label) });
  };

  const toggleNotification = (key: NotificationKey, on: boolean) => {
    setSaved((prev) => ({ ...prev, notifications: { ...prev.notifications, [key]: on } }));
    ctx.log(c.common.changedTo(g.notifications.items[key].label, on ? c.common.on : c.common.off), 'setting', ctx.path);
  };

  const reset = () =>
    ctx.confirm({
      title: g.preview.confirmTitle,
      body: g.preview.confirmBody,
      confirmLabel: g.preview.confirmLabel,
      tone: 'danger',
      onConfirm: () => {
        ctx.dispatch({ type: 'reset' });
        ctx.toast({ tone: 'ok', title: g.preview.toast, body: g.preview.toastBody });
      },
    });

  return settingsFrame(ctx, 'generale', {
    children: (
      <div className="flex flex-col gap-4">
        <Block
          title={g.identity.title}
          actions={
            dirtyKeys.length > 0 ? (
              <>
                <Button variant="ghost" onClick={discardDrafts}>{c.common.cancel}</Button>
                <Button variant="primary" onClick={saveDrafts}>{c.common.save}</Button>
              </>
            ) : undefined
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label={g.identity.name} value={draft.name ?? saved.name} onChange={(v) => edit('name', v)} onEnter={saveDrafts} disabled={gate.disabled} title={gate.title} className="sm:col-span-2" />
            <TextField label={g.identity.shortName} value={draft.shortName ?? saved.shortName} onChange={(v) => edit('shortName', v)} onEnter={saveDrafts} hint={g.identity.shortNameHint} disabled={gate.disabled} title={gate.title} />
            <TextField label={g.identity.seat} value={draft.seat ?? saved.seat} onChange={(v) => edit('seat', v)} onEnter={saveDrafts} disabled={gate.disabled} title={gate.title} />
          </div>
          <div className="mt-3 border-t border-app-border pt-1">
            <KeyValue
              label={g.identity.legalForm}
              value={<span className="inline-flex flex-wrap items-center justify-end gap-1.5">{ORG_IDENTITY.legalForm}<Source source={{ label: ORG_IDENTITY.legalSource }} pageLabel={(n) => String(n)} /></span>}
              valueClassName="text-right"
            />
          </div>
        </Block>

        <Block title={g.regional.title}>
          <SettingRow
            label={g.regional.language}
            description={g.regional.languageNote}
            control={
              <Select
                value={saved.language}
                options={[{ value: 'it', label: g.regional.languages.it }, { value: 'en', label: g.regional.languages.en }]}
                onChange={(v) => change('language', v as 'it' | 'en', g.regional.language, g.regional.languages[v as 'it' | 'en'])}
                disabled={gate.disabled}
                title={gate.title ?? g.regional.language}
                className="w-44"
              />
            }
          />
          <SettingRow
            label={g.regional.timeZone}
            control={
              <Select
                value={saved.timeZone}
                options={TIME_ZONES.map((z) => ({ value: z, label: z }))}
                onChange={(v) => change('timeZone', v, g.regional.timeZone, v)}
                disabled={gate.disabled}
                title={gate.title ?? g.regional.timeZone}
                className="w-44"
              />
            }
          />
        </Block>

        <Block title={g.notifications.title} description={g.notifications.intro}>
          {NOTIFICATION_KEYS.map((k) => (
            <SettingRow
              key={k}
              label={g.notifications.items[k].label}
              description={g.notifications.items[k].description}
              control={<Toggle checked={saved.notifications[k]} onChange={(on) => toggleNotification(k, on)} disabled={gate.disabled} title={gate.title ?? g.notifications.items[k].label} />}
            />
          ))}
        </Block>

        <Block title={g.facts.title} description={g.facts.intro(ORG_IDENTITY.factsSource)}>
          <div className="flex flex-col">
            {ORG_FACTS.map((f) => (
              <KeyValue key={f.id} label={g.facts.labels[f.id]} value={f.value} />
            ))}
          </div>
        </Block>

        <Block title={g.preview.title} className="border-dashed">
          <Callout icon={Info} tone="blue">{g.preview.body}</Callout>
          <div className="mt-3">
            <Button icon={RotateCcw} onClick={reset}>{g.preview.reset}</Button>
          </div>
        </Block>
      </div>
    ),
  });
}
