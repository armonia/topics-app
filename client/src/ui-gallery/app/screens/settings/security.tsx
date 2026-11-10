/** Settings · Security and speed (`g04`): access, devices, passkeys, addresses, data and backup, robots, and the speed of each step. */
import { Fingerprint, KeyRound, Monitor, Network, Plus, RefreshCw, ShieldCheck, Smartphone, Trash2, ArrowUpRight, CircleAlert } from 'lucide-react';
import type { ScreenCtx } from '../../kit';
import type { RegionId } from '../../../../ui/settings/model';
import { P } from '../../paths';
import { settingsFrame } from '../settings-frame';
import { Block, Callout, KpiTile, ListRow, SettingRow } from '../../../../ui/settings/Block';
import { Button } from '../../../../ui/primitives/Button';
import { Chip } from '../../../../ui/primitives/Chip';
import { ProgressBar } from '../../../../ui/primitives/Progress';
import { Select, TextField, Toggle } from '../../../../ui/primitives/Field';
import { Table } from '../../../../ui/primitives/Table';
import { CONNECTORS, IP_RANGES, PASSKEYS, REGIONS, ROBOTS, SECURITY_START, SESSIONS, STEP_SPEED } from '../../../../ui/fixtures/settings';
import { adminGate, dayText, isCidr, isRunning, stamp } from './helpers';
import { JobStatus } from './shared';
import { halleyPasswordSavedAt, vaultSlice } from '../../store/vault';
import { saveHalleyPassword } from '../programs/halley-password';

interface SecurityState {
  twoFactor: boolean;
  sessions: string[];
  passkeys: Array<{ id: string; name: string; createdOn: string }>;
  ipOn: boolean;
  ranges: Array<{ id: string; cidr: string; note: string }>;
  region: RegionId;
  backupRegion: RegionId;
  lastCheckAt: string;
  lastBackupAt: string;
}

const initial = (): SecurityState => ({
  twoFactor: true,
  sessions: SESSIONS.map((x) => x.id),
  passkeys: PASSKEYS.map((k) => ({ ...k })),
  ipOn: true,
  ranges: IP_RANGES.map((r) => ({ ...r })),
  region: SECURITY_START.region,
  backupRegion: SECURITY_START.backupRegion,
  lastCheckAt: SECURITY_START.lastCheckAt,
  lastBackupAt: SECURITY_START.lastBackupAt,
});

export function SecurityPage({ ctx }: { ctx: ScreenCtx }) {
  const c = ctx.copy.settings;
  const s = c.security;
  const gate = adminGate(ctx);
  const [st, setSt] = ctx.slice<SecurityState>('security', initial());
  const [ipText, setIpText] = ctx.ui<string>('sicurezza.ip', '');
  const [ipError, setIpError] = ctx.ui<'' | 'invalid' | 'duplicate'>('sicurezza.ipError', '');
  const day = ctx.now.slice(0, 10);

  const log = (what: string) => ctx.log(what, 'access', ctx.path);

  /* Two-step verification: turning it off asks first. */
  const setTwoFactor = (on: boolean) => {
    const apply = () => {
      setSt((prev) => ({ ...prev, twoFactor: on }));
      log(c.common.changedTo(s.access.twoFactor.label, on ? c.common.on : c.common.off));
    };
    if (on) apply();
    else ctx.confirm({ ...s.access.twoFactor.confirmOff, confirmLabel: s.access.twoFactor.confirmOff.label, tone: 'danger', onConfirm: apply });
  };

  const signOut = (id: string) =>
    ctx.confirm({
      title: s.access.sessions.confirm.title,
      body: s.access.sessions.confirm.body,
      confirmLabel: s.access.sessions.confirm.label,
      tone: 'danger',
      onConfirm: () => {
        setSt((prev) => ({ ...prev, sessions: prev.sessions.filter((x) => x !== id) }));
        log(`${s.access.sessions.signOut}: ${SESSIONS.find((x) => x.id === id)?.device ?? id}`);
        ctx.toast({ tone: 'ok', title: s.access.sessions.toast });
      },
    });

  const signOutOthers = () =>
    ctx.confirm({
      title: s.access.sessions.confirmAll.title,
      body: s.access.sessions.confirmAll.body,
      confirmLabel: s.access.sessions.confirmAll.label,
      tone: 'danger',
      onConfirm: () => {
        setSt((prev) => ({ ...prev, sessions: prev.sessions.filter((x) => SESSIONS.find((y) => y.id === x)?.current) }));
        log(s.access.sessions.signOutOthers);
        ctx.toast({ tone: 'ok', title: s.access.sessions.toast });
      },
    });

  const addPasskey = () => {
    const n = st.passkeys.length + 1;
    ctx.startJob({
      id: 'passkey-add',
      title: s.access.passkeys.job.title,
      steps: s.access.passkeys.job.steps.map((label) => ({ label, ms: 700 })),
      onDone: (ok) => {
        if (!ok) return;
        const name = s.access.passkeys.newName(n);
        setSt((prev) => ({ ...prev, passkeys: [...prev.passkeys, { id: `pk-new-${n}-${prev.passkeys.length}`, name, createdOn: day }] }));
        log(`${s.access.passkeys.add}: ${name}`);
        ctx.toast({ tone: 'ok', title: s.access.passkeys.job.done, body: name });
      },
    });
  };

  const removePasskey = (id: string) =>
    ctx.confirm({
      title: s.access.passkeys.confirm.title,
      body: s.access.passkeys.confirm.body,
      confirmLabel: s.access.passkeys.confirm.label,
      tone: 'danger',
      onConfirm: () => {
        const name = st.passkeys.find((k) => k.id === id)?.name ?? id;
        setSt((prev) => ({ ...prev, passkeys: prev.passkeys.filter((k) => k.id !== id) }));
        log(`${s.access.passkeys.remove}: ${name}`);
        ctx.toast({ tone: 'ok', title: c.common.saved(s.access.passkeys.title) });
      },
    });

  const setIpOn = (on: boolean) => {
    const apply = () => {
      setSt((prev) => ({ ...prev, ipOn: on }));
      log(c.common.changedTo(s.access.ip.toggle, on ? c.common.on : c.common.off));
    };
    if (!on) apply();
    else ctx.confirm({ ...s.access.ip.confirmOn, confirmLabel: s.access.ip.confirmOn.label, onConfirm: apply });
  };

  const addRange = () => {
    const text = ipText.trim();
    if (!isCidr(text)) return setIpError('invalid');
    if (st.ranges.some((r) => r.cidr === text)) return setIpError('duplicate');
    setSt((prev) => ({ ...prev, ranges: [...prev.ranges, { id: `ip-new-${prev.ranges.length}-${text}`, cidr: text, note: s.access.ip.newNote }] }));
    setIpText('');
    setIpError('');
    log(`${s.access.ip.title}: ${text}`);
    ctx.toast({ tone: 'ok', title: c.common.saved(s.access.ip.title), body: text });
  };

  const removeRange = (id: string) => {
    const cidr = st.ranges.find((r) => r.id === id)?.cidr ?? id;
    setSt((prev) => ({ ...prev, ranges: prev.ranges.filter((r) => r.id !== id) }));
    log(`${s.access.ip.title}: ${c.common.remove} ${cidr}`);
  };

  const sameRegion = st.region === st.backupRegion;
  const setRegion = (key: 'region' | 'backupRegion', value: RegionId) => {
    setSt((prev) => ({ ...prev, [key]: value }));
    const other = key === 'region' ? st.backupRegion : st.region;
    if (value !== other) {
      log(c.common.changedTo(key === 'region' ? s.data.region : s.data.backupRegion, s.data.regions[value]));
      ctx.toast({ tone: 'ok', title: c.common.saved(key === 'region' ? s.data.region : s.data.backupRegion) });
    }
  };

  const runCheck = () =>
    ctx.startJob({
      id: 'security-check',
      title: s.checkJob.title,
      steps: s.checkJob.steps.map((label) => ({ label, ms: 650 })),
      onDone: (ok) => {
        if (!ok) return;
        setSt((prev) => ({ ...prev, lastCheckAt: ctx.now }));
        log(s.checkJob.title);
        ctx.toast({ tone: 'ok', title: s.checkJob.done, body: s.checkJob.doneBody });
      },
    });

  const runBackup = () =>
    ctx.startJob({
      id: 'backup-run',
      title: s.data.backup.job.title,
      steps: s.data.backup.job.steps.map((label) => ({ label, ms: 800 })),
      onDone: (ok) => {
        if (!ok) return;
        setSt((prev) => ({ ...prev, lastBackupAt: ctx.now }));
        log(s.data.backup.job.title);
        ctx.toast({ tone: 'ok', title: s.data.backup.job.done });
      },
    });

  const renewPassword = () =>
    ctx.startJob({
      id: 'robot-renew',
      title: s.robots.job.title,
      steps: s.robots.job.steps.map((label) => ({ label, ms: 700 })),
      onDone: (ok) => {
        if (!ok) return;
        saveHalleyPassword(ctx, { resume: true });
        log(s.robots.job.title);
        ctx.toast({ tone: 'ok', title: s.robots.job.done });
      },
    });

  const regionOptions = REGIONS.map((r) => ({ value: r, label: s.data.regions[r] }));
  const sessions = SESSIONS.filter((x) => st.sessions.includes(x.id));
  const others = sessions.filter((x) => !x.current);
  const robotName = ROBOTS[0].name;
  // The robot here is Halley's: its password is the one in the vault every screen reads (the stopped run, Programmi, the sidebar).
  const halleySaved = halleyPasswordSavedAt(vaultSlice(ctx)[0]);

  const checking = isRunning(ctx, 'security-check');

  return settingsFrame(ctx, 'sicurezza', {
    actions: (
      <Button variant="secondary" icon={RefreshCw} onClick={checking ? false : ctx.allow('admin', runCheck)} title={checking ? ctx.copy.app.jobs.running : gate.title}>{s.checkNow}</Button>
    ),
    children: (
      <div className="flex flex-col gap-4">
        <JobStatus job={ctx.job('security-check')} />
        <div className="flex">
          <Chip tone="green" icon={ShieldCheck}>{s.lastCheck(stamp(st.lastCheckAt))}</Chip>
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">
          {s.kpis.map((k) => (
            <KpiTile key={k.label} label={k.label} value={k.value} detail={k.detail} good={k.value === '0'} />
          ))}
        </div>

        <Block title={s.access.title}>
          <SettingRow
            label={s.access.twoFactor.label}
            description={s.access.twoFactor.description}
            control={<Toggle checked={st.twoFactor} onChange={setTwoFactor} disabled={gate.disabled} title={gate.title ?? s.access.twoFactor.label} />}
          />
          <SettingRow
            label={s.access.ip.toggle}
            description={s.access.ip.description}
            control={<Toggle checked={st.ipOn} onChange={setIpOn} disabled={gate.disabled} title={gate.title ?? s.access.ip.toggle} />}
          />
        </Block>

        <Block
          title={s.access.sessions.title}
          actions={others.length > 0 ? <Button variant="secondary" onClick={ctx.allow('admin', signOutOthers)} title={gate.title}>{s.access.sessions.signOutOthers}</Button> : undefined}
        >
          {sessions.map((x) => (
            <ListRow
              key={x.id}
              icon={x.device.includes('iPhone') ? Smartphone : Monitor}
              title={x.device}
              detail={`${x.place} · ${s.access.sessions.lastSeen(x.minutesAgo)}`}
              tone={x.current ? 'green' : 'neutral'}
              trailing={
                x.current ? (
                  <Chip tone="green">{s.access.sessions.current}</Chip>
                ) : (
                  <Button size="sm" variant="secondary" onClick={ctx.allow('admin', () => signOut(x.id))} title={gate.title}>{s.access.sessions.signOut}</Button>
                )
              }
            />
          ))}
          {others.length === 0 && <p className="pt-2 text-compact text-app-text-tertiary">{s.access.sessions.empty}</p>}
        </Block>

        <Block
          title={s.access.passkeys.title}
          actions={<Button variant="secondary" icon={Plus} onClick={isRunning(ctx, 'passkey-add') ? false : ctx.allow('admin', addPasskey)} title={isRunning(ctx, 'passkey-add') ? ctx.copy.app.jobs.running : gate.title}>{s.access.passkeys.add}</Button>}
        >
          <JobStatus job={ctx.job('passkey-add')} />
          {st.passkeys.map((k) => (
            <ListRow
              key={k.id}
              icon={Fingerprint}
              title={k.name}
              detail={s.access.passkeys.created(dayText(k.createdOn))}
              trailing={<Button size="sm" variant="danger" icon={Trash2} onClick={ctx.allow('admin', () => removePasskey(k.id))} title={gate.title}>{s.access.passkeys.remove}</Button>}
            />
          ))}
          {st.passkeys.length === 0 && <p className="text-compact text-app-text-tertiary">{s.access.passkeys.empty}</p>}
        </Block>

        <Block title={s.access.ip.title} bodyClassName="flex flex-col gap-3">
          <div className="flex flex-wrap items-start gap-2">
            <TextField
              size="sm"
              icon={Network}
              value={ipText}
              onChange={(v) => { setIpText(v); if (ipError) setIpError(''); }}
              onEnter={addRange}
              placeholder={s.access.ip.placeholder}
              error={ipError ? s.access.ip[ipError] : undefined}
              disabled={gate.disabled}
              title={gate.title}
              className="min-w-[220px] flex-1"
            />
            <Button variant="secondary" icon={Plus} onClick={ctx.allow('admin', addRange)} title={gate.title}>{s.access.ip.add}</Button>
          </div>
          <div>
            {st.ranges.map((r) => (
              <ListRow
                key={r.id}
                icon={Network}
                title={<span className="font-mono">{r.cidr}</span>}
                detail={r.note}
                trailing={<Button size="sm" variant="ghost" icon={Trash2} onClick={ctx.allow('admin', () => removeRange(r.id))} title={gate.title ?? `${c.common.remove} ${r.cidr}`}><span className="sr-only">{c.common.remove} {r.cidr}</span></Button>}
              />
            ))}
            {st.ranges.length === 0 && <p className="text-compact text-app-text-tertiary">{s.access.ip.empty}</p>}
          </div>
        </Block>

        <Block title={s.data.title} bodyClassName="flex flex-col gap-1">
          <SettingRow
            label={s.data.region}
            control={<Select value={st.region} options={regionOptions} onChange={(v) => setRegion('region', v as RegionId)} disabled={gate.disabled} title={gate.title ?? s.data.region} className="w-48" />}
          />
          <SettingRow
            label={s.data.backupRegion}
            control={<Select value={st.backupRegion} options={regionOptions} onChange={(v) => setRegion('backupRegion', v as RegionId)} disabled={gate.disabled} title={gate.title ?? s.data.backupRegion} className="w-48" />}
          />
          {sameRegion && <Callout icon={CircleAlert} tone="red">{s.data.sameRegion}</Callout>}
          <SettingRow label={s.data.encryptedAtRest} control={<Chip tone="green">{c.common.on}</Chip>} />
          <SettingRow label={s.data.encryptedInTransit} control={<Chip tone="green">{c.common.on}</Chip>} />
          <SettingRow
            label={s.data.backup.title}
            description={`${s.data.backup.last(stamp(st.lastBackupAt))} · ${s.data.backup.keep(SECURITY_START.backupKeepDays)}`}
            control={<Button variant="secondary" icon={RefreshCw} onClick={isRunning(ctx, 'backup-run') ? false : ctx.allow('admin', runBackup)} title={isRunning(ctx, 'backup-run') ? ctx.copy.app.jobs.running : gate.title}>{s.data.backup.run}</Button>}
          />
          <JobStatus job={ctx.job('backup-run')} />
        </Block>

        <Block title={s.robots.title}>
          <SettingRow
            label={s.robots.robots}
            control={
              <>
                <Chip tone="green">{s.robots.robotsValue(ROBOTS.length, ROBOTS.length)}</Chip>
                <Button size="sm" variant="ghost" icon={ArrowUpRight} onClick={() => ctx.go(P.programs())}>{c.common.open}</Button>
              </>
            }
          />
          <SettingRow label={s.robots.secrets} control={<Chip tone="green">{c.common.on}</Chip>} />
          <SettingRow
            label={s.robots.connectors}
            description={CONNECTORS.join(', ')}
            control={
              <>
                <Chip tone="green">{s.robots.connectorsValue(CONNECTORS.length)}</Chip>
                <Button size="sm" variant="ghost" icon={ArrowUpRight} onClick={() => ctx.go(P.programs())}>{c.common.open}</Button>
              </>
            }
          />
          <SettingRow label={s.robots.injection} control={<Chip tone="green">{c.common.on}</Chip>} />
          <SettingRow
            label={s.robots.password(robotName)}
            description={halleySaved ? s.robots.renewed(stamp(halleySaved)) : s.robots.expired(stamp(SECURITY_START.robotRenewedAt))}
            control={<Button variant="secondary" icon={KeyRound} onClick={isRunning(ctx, 'robot-renew') ? false : ctx.allow('admin', renewPassword)} title={isRunning(ctx, 'robot-renew') ? ctx.copy.app.jobs.running : gate.title}>{s.robots.renew}</Button>}
          />
          <JobStatus job={ctx.job('robot-renew')} />
        </Block>

        <Block title={s.speed.title} actions={<Chip tone="amber">{s.speed.badge}</Chip>} bodyClassName="flex flex-col gap-3">
          <Table
            ariaLabel={s.speed.title}
            columns={[
              { id: 'step', label: s.speed.columns.step },
              { id: 'median', label: s.speed.columns.median, width: 90, align: 'right' },
              { id: 'p95', label: s.speed.columns.p95, width: 90, align: 'right' },
              { id: 'limit', label: s.speed.columns.limit, width: 90, align: 'right' },
              { id: 'bar', label: '', width: 120 },
            ]}
            rows={STEP_SPEED.map((r) => ({
              id: r.id,
              onOpen: () => ctx.go(P.flow('pec')),
              cells: {
                step: r.label,
                median: s.speed.seconds(r.median),
                p95: s.speed.seconds(r.p95),
                limit: s.speed.seconds(r.limit),
                bar: <ProgressBar value={r.p95 / r.limit} tone={r.p95 / r.limit > 0.8 ? 'amber' : 'green'} label={`${s.speed.columns.p95}: ${r.label}`} />,
              },
            }))}
          />
          <p className="text-compact text-app-text-tertiary">{s.speed.note}</p>
        </Block>
      </div>
    ),
  });
}
