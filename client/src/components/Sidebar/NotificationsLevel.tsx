/**
 * THE NOTIFICATIONS, one home for every preference about them (USERMENU-03).
 *
 * This was the «Notifications» page of the Settings panel, and the bell's gear
 * opened that page. Everything that page held is here, moved and not
 * rewritten: the three switches, the true state of the system banners with the
 * one button that state allows (NOTIF-PERM-01), the disk access «Do not
 * disturb» needs when it is missing, this device's push subscription, the
 * other devices, and the muted projects. The push block is two child levels,
 * because in a 288px level it does not fit in one.
 *
 * The bell keeps the HISTORY; the preferences are here. Two panels, two jobs.
 */
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Bell, BellOff, Check, Moon, Smartphone } from 'lucide-react';
import type { AppSettings } from '../../types';
import { notificationStatus, requestNotificationPermission, type NativeNotificationStatus } from '../../lib/shell/app';
import { describeNativeNotifications, notificationPermissionAction } from '../../lib/notificationStatus';
import { focusGateState, FULL_DISK_ACCESS_URL, type FocusGateState } from '../../lib/shell/focus';
import { openExternalOnce } from '../../lib/openExternal';
import { usePushNotifications } from '../../hooks/usePushNotifications';
import type { PushWhenOpen } from '../../state/pushDevice';
import { useT } from '@/hooks/useT';
import { SubmenuItem } from '../Shared/SubmenuItem';
import { Segmented } from '../Shared/Segmented';
import { Switch } from '../Shared/Switch';
import { LevelHeading, SwitchRow } from './PreferenceRow';
import type { MenuPreferences } from './AppearanceLevel';

const NOTE = 'flex items-start gap-2 px-3 py-1 text-mini leading-snug';
const ACTION = 'mt-1 rounded-md bg-primary px-2.5 py-1 text-mini font-medium text-white hover:opacity-90 disabled:opacity-50 coarse:min-h-11 coarse:px-3';

export function NotificationsLevel({ preferences, defaultOpen = false }: {
  preferences: MenuPreferences;
  defaultOpen?: boolean;
}) {
  const tr = useT();
  const { settings, onSettingChange } = preferences;
  const on = settings.notificationsEnabled;

  return (
    <SubmenuItem
      icon={Bell}
      label={tr('settings.section.notifications')}
      testId="topics-menu-notifications"
      minWidth={288}
      maxWidth={340}
      defaultOpen={defaultOpen}
      tail={
        <span data-testid="topics-menu-notifications-tail" className="flex-shrink-0 text-mini text-app-text-tertiary">
          {on ? tr('notif.level.on') : tr('notif.level.off')}
        </span>
      }
    >
      <div className="py-1">
        <SwitchRow
          label={tr('notif.level.enabled')}
          checked={on}
          onChange={(v) => onSettingChange('notificationsEnabled', v)}
          testId="notif-enabled"
        />
        <SwitchRow
          label={tr('notif.level.sound')}
          checked={settings.notificationsSound}
          onChange={(v) => onSettingChange('notificationsSound', v)}
          disabled={!on}
          testId="notif-sound"
        />
        <SwitchRow
          label={tr('notif.level.focused')}
          checked={settings.notifyEvenWhenFocused}
          onChange={(v) => onSettingChange('notifyEvenWhenFocused', v)}
          disabled={!on}
          testId="notif-focused"
        />
      </div>
      <NativeBannerStatus />
      <FocusGateStatus />
      <PushLevels />
      <MutedProjects settings={settings} onChange={(v) => onSettingChange('mutedProjects', v)} />
    </SubmenuItem>
  );
}

/**
 * The true state of the native banner chain, and the one action it allows.
 *
 * Read from the shell (`notification_status`); the button acts on the
 * permission and the level redraws from the status that call returns, so it
 * tells the truth right after the click. Which button, if any, is decided by
 * `notificationPermissionAction`.
 */
function NativeBannerStatus() {
  const tr = useT();
  const [status, setStatus] = useState<NativeNotificationStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void notificationStatus().then((s) => { if (alive.current) setStatus(s); });
    return () => { alive.current = false; };
  }, []);

  const act = async () => {
    setBusy(true);
    try {
      const next = await requestNotificationPermission();
      if (alive.current) setStatus(next);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  // Still in flight: a diagnosis not yet read is not drawn.
  if (status === undefined) return null;

  const verdict = describeNativeNotifications(status);
  const action = notificationPermissionAction(status);
  const tone = {
    ok: 'text-app-text-muted',
    degraded: 'text-amber-800 dark:text-amber-400',
    broken: 'text-red-700 dark:text-red-400',
    unknown: 'text-app-text-muted',
  }[verdict.health];

  return (
    <div data-testid="notif-native-status" className={`border-t border-app-border ${NOTE} py-1.5`}>
      {verdict.health === 'ok'
        ? <Check size={12} className={`mt-px shrink-0 ${tone}`} />
        : <AlertCircle size={12} className={`mt-px shrink-0 ${tone}`} />}
      <div className="min-w-0">
        <div className={tone}>{verdict.headline}</div>
        {verdict.hint && <div className="mt-0.5 text-app-text-muted">{verdict.hint}</div>}
        {status?.logPath && verdict.health !== 'ok' && (
          <div className="mt-0.5 break-all font-mono text-micro text-app-text-muted">{status.logPath}</div>
        )}
        {action.kind !== 'none' && (
          <button
            type="button"
            disabled={busy}
            data-testid="notif-permission-action"
            onClick={() => { void act(); }}
            className={ACTION}
          >{tr(action.labelKey)}</button>
        )}
      </div>
    </div>
  );
}

/**
 * The «Do not disturb» gate, only when there is something to say: the Focus
 * state lives behind macOS privacy, and without Full Disk Access the gate
 * stays open (banners keep coming during a Focus). The grant stays a gesture of
 * the person; the app can only lead them there.
 */
function FocusGateStatus() {
  const tr = useT();
  const [state, setState] = useState<FocusGateState>(() => focusGateState());
  useEffect(() => {
    // The first read is asynchronous: poll until it has landed.
    if (state !== 'pending') return;
    const timer = setInterval(() => {
      const next = focusGateState();
      if (next !== 'pending') { setState(next); clearInterval(timer); }
    }, 400);
    return () => clearInterval(timer);
  }, [state]);

  if (state !== 'blocked') return null;

  return (
    <div data-testid="notif-focus-gate" className={`border-t border-app-border ${NOTE} py-1.5 text-app-text-muted`}>
      <Moon size={12} className="mt-px shrink-0" />
      <div className="min-w-0">
        {tr('notif.focus.blurb')}{' '}
        <button
          type="button"
          onClick={() => openExternalOnce(FULL_DISK_ACCESS_URL)}
          className="underline underline-offset-2 hover:text-app-text"
        >{tr('notif.focus.grant')}</button>
        {tr('notif.focus.thenRestart')}
      </div>
    </div>
  );
}

/**
 * Notifications with the app CLOSED, per device: this one and the others.
 *
 * The subscription is per endpoint, so the preferences follow the device: the
 * phone and the Mac say different things and each sees itself marked. The
 * subscribe button exists only when pressing it does something; with the
 * permission denied the status line says where the remedy is.
 */
function PushLevels() {
  const tr = useT();
  const { status, subscribed, devices, loading, subscribe, unsubscribe, setDevicePrefs } = usePushNotifications();
  const thisDevice = devices.find((d) => d.isThisDevice);
  const others = devices.filter((d) => !d.isThisDevice);
  const tone = {
    on: 'text-app-text-muted',
    off: 'text-amber-800 dark:text-amber-400',
    blocked: 'text-red-700 dark:text-red-400',
    unavailable: 'text-app-text-muted',
  }[status.health];
  const headline = status.headlineKey ? tr(status.headlineKey) : status.headline;
  const hint = status.hintKey ? tr(status.hintKey) : status.hint;

  return (
    <div className="border-t border-app-border py-1">
      <LevelHeading>{tr('notif.push.title')}</LevelHeading>
      <SubmenuItem
        icon={Smartphone}
        label={tr('notif.level.thisDevice')}
        testId="notif-this-device"
        minWidth={288}
        maxWidth={340}
        tail={
          <span className={`max-w-[96px] flex-shrink-0 truncate text-mini ${subscribed && thisDevice?.enabled ? 'text-app-text-tertiary' : tone}`}>
            {subscribed ? (thisDevice?.enabled === false ? tr('notif.level.off') : tr('notif.level.on')) : tr('notif.level.notSubscribed')}
          </span>
        }
      >
        <div data-testid="settings-push-devices" className="py-1">
          <div data-testid="push-status" className={NOTE}>
            {status.health === 'on'
              ? <Check size={12} className={`mt-px shrink-0 ${tone}`} />
              : <AlertCircle size={12} className={`mt-px shrink-0 ${tone}`} />}
            <div className="min-w-0">
              <div className={tone} data-testid="push-status-headline">{headline}</div>
              {hint && <div className="mt-0.5 text-app-text-muted" data-testid="push-status-hint">{hint}</div>}
              {status.canSubscribe && (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void subscribe()}
                  data-testid="push-subscribe"
                  className={ACTION}
                >
                  {tr('notif.push.enableHere')}
                </button>
              )}
            </div>
          </div>
          {subscribed && thisDevice && (
            <>
              <SwitchRow
                label={tr('notif.level.receiveHere')}
                hint={tr('notif.level.receiveHereHint')}
                checked={thisDevice.enabled}
                onChange={(v) => void setDevicePrefs(thisDevice.deviceId!, { enabled: v })}
                testId="push-receive-here"
              />
              <div className="px-3 py-1 text-compact text-app-text">
                <div>{tr('notif.push.whenOpen')}</div>
                <Segmented<PushWhenOpen>
                  value={thisDevice.whenOpen}
                  onChange={(v) => void setDevicePrefs(thisDevice.deviceId!, { whenOpen: v })}
                  ariaLabel={tr('notif.push.whenOpen')}
                  testId="push-when-open"
                  className="mt-1 w-full"
                  options={[
                    { value: 'native', label: tr('notif.level.whenOpenNative') },
                    { value: 'in-app', label: tr('notif.level.whenOpenInApp') },
                  ]}
                />
                <div className="mt-1 text-mini leading-snug text-app-text-muted">{tr('notif.push.oneVoice')}</div>
              </div>
              <div className="border-t border-app-border px-3 py-1">
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => void unsubscribe()}
                  data-testid="push-unsubscribe"
                  className="text-mini text-app-text-muted underline underline-offset-2 hover:text-app-text disabled:opacity-50 coarse:min-h-11"
                >
                  {tr('notif.push.unsubscribe')}
                </button>
              </div>
            </>
          )}
        </div>
      </SubmenuItem>
      {others.length > 0 && (
        <SubmenuItem
          icon={Smartphone}
          label={tr('notif.push.others')}
          testId="notif-other-devices"
          minWidth={260}
          maxWidth={340}
          tail={<span className="flex-shrink-0 text-mini tabular-nums text-app-text-tertiary">{others.filter((d) => d.enabled).length}/{others.length}</span>}
        >
          <div className="max-h-[260px] overflow-y-auto py-1">
            {others.map((d) => (
              <div key={d.deviceId ?? d.label} data-testid={`push-device-${d.deviceId ?? 'legacy'}`} className="flex items-center gap-2 px-3 py-1 text-compact coarse:min-h-11">
                <Smartphone size={12} className="shrink-0 text-app-text-muted" />
                <span className="min-w-0 flex-1 truncate text-app-text">{d.label}</span>
                {d.deviceId && (
                  <Switch
                    checked={d.enabled}
                    onChange={(v) => void setDevicePrefs(d.deviceId!, { enabled: v })}
                    label={d.enabled ? tr('notif.push.offHere') : tr('notif.push.onHere')}
                  />
                )}
              </div>
            ))}
          </div>
        </SubmenuItem>
      )}
    </div>
  );
}

/** The last segment of a path: the name the column shows. */
function projectName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * The projects you muted, and the gesture to bring them back.
 *
 * `mutedProjects` grows from a project's own menu in the column; this is where
 * the list is READ and undone, from any device. Nothing to list, nothing drawn.
 */
function MutedProjects({ settings, onChange }: {
  settings: AppSettings;
  onChange: (next: string[]) => void;
}) {
  const tr = useT();
  const muted = settings.mutedProjects ?? [];
  if (muted.length === 0) return null;

  return (
    <div data-testid="settings-muted-projects" className="border-t border-app-border py-1">
      <LevelHeading>{tr('notif.muted.title')}</LevelHeading>
      {muted.map((path) => (
        <div key={path} data-testid={`muted-project-${path}`} title={path} className="flex items-center gap-2 px-3 py-1 text-compact coarse:min-h-11">
          <BellOff size={12} className="shrink-0 text-app-text-muted" />
          <span className="min-w-0 flex-1 truncate text-app-text">{projectName(path)}</span>
          <button
            type="button"
            data-testid="muted-project-unmute"
            onClick={() => onChange(muted.filter((p) => p !== path))}
            title={tr('notif.muted.unmute')}
            className="flex-shrink-0 rounded px-1.5 py-0.5 text-mini text-primary hover:bg-primary/10 coarse:min-h-11 coarse:px-3"
          >
            {tr('notif.muted.reactivate')}
          </button>
        </div>
      ))}
    </div>
  );
}
