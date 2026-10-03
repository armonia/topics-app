/**
 * THE DEVICES, managed where they are listed.
 *
 * The level used to be a read-only copy of the Settings page with a «Manage»
 * row that opened the other copy, where the gesture that counts (revoking a
 * device) lived. Now the level is the only list: rename and revoke sit on the
 * row, «whose is it» opens from the row when there is more than one person,
 * and the revoked devices are a level below. On the phone this is the only
 * place where a device can be renamed or revoked (USERMENU-04, USERMENU-09).
 *
 * THE COMPUTER IS THE FIRST ROW, with neither pencil nor bin: the route sends it
 * apart (`thisComputer`), it has no row in the database, and revoking the
 * machine the server runs on would mean nothing.
 *
 * READ AGAIN ON OPEN. A phone connecting sends no event, and this level shows
 * live dots, not a bare count.
 *
 * EVERY ROW CARRIES ITS AUDIT LINE (`deviceAudit`): when it was last seen and
 * from which address it paired; a revoked row says when. This list is the only
 * place where an access you do not recognise shows up. A read that fails says
 * so, with a retry, instead of leaving the level empty.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Monitor, Pencil, Server, Smartphone, Trash2, Users } from 'lucide-react';
import { Menu } from '../Shared/Menu';
import { SubmenuItem } from '../Shared/SubmenuItem';
import { CHIP_INK_DIM } from './identityChip';
import { PALLINO_OK, SEGNALE_OK } from './chromeSignals';
import { moveDevice, renameDevice, revokeDevice } from '@/lib/devicesApi';
import type { DevicePerson, DevicesSnapshot, PairedDevice } from '@/lib/devicesRead';
import { pendingRemoteRequests } from '@/lib/remoteNodeRequests';
import { NotificationBadge } from '../Shared/NotificationBadge';
import { MachinesLevel } from './FormLevels';
import { nodeRequestsLabel } from './formLevelTails';
import { deviceRevokedLine, deviceSeenLine } from '@/lib/deviceAudit';
import { useActiveLocale, useT } from '@/hooks/useT';

const ROW = 'flex items-center gap-2 px-3 py-1 text-mini coarse:min-h-11 coarse:text-compact';
const ICON_BUTTON = 'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-app-text-tertiary hover:bg-app-hover hover:text-app-text coarse:h-11 coarse:w-11';
const TEXT_BUTTON = 'flex-shrink-0 rounded px-1.5 py-0.5 text-mini coarse:min-h-11 coarse:px-3';

export function DevicesLevel({ devices, failed = false, width, onReadDevices, defaultOpen = false, machinesOpen = false }: {
  /** `null` until the route has answered once. */
  devices: DevicesSnapshot | null;
  /** The last read did not answer. */
  failed?: boolean;
  /** The host panel's width: the level's floor and its ceiling. */
  width: number;
  /** Asks the route again. Stable: the level calls it on open. */
  onReadDevices: () => void;
  defaultOpen?: boolean;
  /** The Machines section open too (`openUserMenu('nodes')`, the palette). */
  machinesOpen?: boolean;
}) {
  const tr = useT();
  const locale = useActiveLocale();
  const [remote, setRemote] = useState(0);
  // Bumped by the requests line: the Machines level opens on it, fresh.
  const [machinesAsked, setMachinesAsked] = useState(0);
  // THE BADGE IS ON THE ROW, so it is read with the menu (mounting is
  // opening): a request from another computer waits for an answer, and the
  // person must not have to open Devices to learn there is one.
  useEffect(() => {
    let alive = true;
    void pendingRemoteRequests().then((n) => { if (alive) setRemote(n); });
    return () => { alive = false; };
  }, []);
  // Stable, because `SubmenuItem` reports from an effect keyed on it.
  const onOpenChange = useCallback((open: boolean) => {
    if (!open) return;
    onReadDevices();
    void pendingRemoteRequests().then(setRemote);
  }, [onReadDevices]);
  const [refusal, setRefusal] = useState<string | null>(null);

  const computer = devices?.computer ?? null;
  const active = (devices?.devices ?? []).filter((d) => d.revokedAt === null);
  const revoked = (devices?.devices ?? []).filter((d) => d.revokedAt !== null);
  const people = devices?.people ?? [];
  const activeOnline = active.filter((d) => d.connected).length;
  const listed = active.length + (computer ? 1 : 0);
  const online = activeOnline + (computer ? 1 : 0);

  /** One gesture, then the list again, and the refusal (if any) stays shown. */
  const run = useCallback(async (gesture: Promise<string | null>): Promise<boolean> => {
    const refused = await gesture;
    setRefusal(refused === null ? null : tr(refused));
    onReadDevices();
    return refused === null;
  }, [onReadDevices, tr]);

  return (
    <SubmenuItem
      icon={Monitor}
      label={tr('statusBar.me.devicesRow')}
      testId="profile-menu-devices"
      minWidth={260}
      maxWidth={Math.max(width, 300)}
      onOpenChange={onOpenChange}
      defaultOpen={defaultOpen}
      tail={active.length > 0 || remote > 0 ? (
        <>
          {active.length > 0 && (
            <span data-testid="devices-count" className={`flex-shrink-0 tabular-nums ${activeOnline > 0 ? SEGNALE_OK : CHIP_INK_DIM}`}>
              {tr('statusBar.me.devicesCount', { n: online, tot: listed })}
            </span>
          )}
          {remote > 0 && (
            <NotificationBadge
              count={remote}
              testId="devices-requests-badge"
              ariaLabel={nodeRequestsLabel(remote, tr)}
              title={nodeRequestsLabel(remote, tr)}
            />
          )}
        </>
      ) : undefined}
    >
      {remote > 0 && (
        <button
          type="button"
          data-testid="devices-remote-requests"
          // The requests are answered in the Machines section at the foot of
          // this level: it opens beside it.
          onClick={() => setMachinesAsked((n) => n + 1)}
          className={`${ROW} w-full text-left text-app-text hover:bg-app-hover`}
        >
          <Server size={12} className="flex-shrink-0 text-app-text-muted" />
          <span className="min-w-0 flex-1 truncate">{tr('devices.remoteRequests', { n: remote })}</span>
        </button>
      )}
      {refusal && (
        <p data-testid="devices-error" role="alert" className="px-3 py-1 text-mini leading-snug text-red-700 dark:text-red-400">{refusal}</p>
      )}
      {failed && (
        <div data-testid="devices-load-failed" role="alert" className={ROW}>
          <span className="min-w-0 flex-1 leading-snug text-red-700 dark:text-red-400">{tr('devices.loadFailed')}</span>
          <button
            type="button"
            data-testid="devices-retry"
            onClick={onReadDevices}
            className={`${TEXT_BUTTON} text-app-text hover:bg-app-hover`}
          >
            {tr('devices.retry')}
          </button>
        </div>
      )}
      {devices && (
        <div className="max-h-[280px] overflow-y-auto py-1">
          {computer && (
            <div data-testid="device-row" data-connected="true" className={ROW}>
              <Monitor size={12} className="flex-shrink-0 text-app-text-muted" />
              <span className="min-w-0 flex-1 truncate text-app-text">
                {tr(computer.current ? 'statusBar.me.thisComputer' : 'statusBar.me.hostComputer')}
              </span>
              {computer.current && <span className="flex-shrink-0 text-app-text-muted">{tr('devices.youAreHere')}</span>}
              <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${PALLINO_OK}`} />
            </div>
          )}
          {active.map((d) => (
            <DeviceRow key={d.id} device={d} people={people} locale={locale} run={run} />
          ))}
          {active.length === 0 && (
            <div data-testid="devices-none" className="px-3 py-1 text-mini text-app-text-muted">{tr('statusBar.me.devicesNone')}</div>
          )}
        </div>
      )}
      {revoked.length > 0 && (
        <div className="border-t border-app-border py-1">
          <SubmenuItem
            label={tr('devices.revokedCount', { n: revoked.length })}
            testId="devices-revoked-level"
            minWidth={240}
          >
            <div data-testid="devices-revoked" className="max-h-[240px] overflow-y-auto py-1">
              {revoked.map((d) => (
                <div key={d.id} data-testid="device-revoked-row" className={`${ROW} text-app-text-muted`}>
                  <Smartphone size={12} className="flex-shrink-0 opacity-50" />
                  <span className="min-w-0 flex-1 truncate line-through">{d.name}</span>
                  <span data-testid="device-revoked-when" className="flex-shrink-0 text-micro">{deviceRevokedLine(d, tr, locale)}</span>
                </div>
              ))}
            </div>
          </SubmenuItem>
        </div>
      )}
      {/* THE MACHINES ARE COMPUTERS TOO: the nodes this board spans and the
          requests from other computers, at the foot of the devices
          (SETHOME-01). A form, so a level of its own beside this one. */}
      <div className="border-t border-app-border py-1">
        <MachinesLevel
          key={machinesAsked}
          defaultOpen={machinesOpen || machinesAsked > 0}
          onRequestsRead={setRemote}
        />
      </div>
    </SubmenuItem>
  );
}

/**
 * One paired device, in one of three states: read, renamed, asked to confirm.
 *
 * Every state keeps the row's height, so the level does not jump under the
 * pointer while it changes.
 */
function DeviceRow({ device: d, people, locale, run }: {
  device: PairedDevice;
  people: DevicePerson[];
  locale: string;
  run: (gesture: Promise<string | null>) => Promise<boolean>;
}) {
  const tr = useT();
  const [mode, setMode] = useState<'read' | 'rename' | 'confirm'>('read');
  const [name, setName] = useState(d.name);
  const [busy, setBusy] = useState(false);
  const [whoseOpen, setWhoseOpen] = useState(false);
  const whoseRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // ESCAPE CANCELS THE RENAME, IT DOES NOT CLOSE THE MENU. The menu listens for
  // Escape on the document in the capture phase, so the field's own handler
  // would run too late: this listener sits on the window, which the capture
  // phase reaches first.
  useEffect(() => {
    if (mode === 'read') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setMode('read');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mode]);

  // The confirmation takes the focus on its safe answer.
  useEffect(() => {
    if (mode === 'confirm') cancelRef.current?.focus();
  }, [mode]);

  const save = async () => {
    const next = name.trim();
    if (!next || next === d.name) { setMode('read'); return; }
    setBusy(true);
    // The field keeps what was typed when the server says no.
    const ok = await run(renameDevice(d.id, next));
    setBusy(false);
    if (ok) setMode('read');
  };

  const revoke = async () => {
    setBusy(true);
    await run(revokeDevice(d.id));
    setBusy(false);
    setMode('read');
  };

  const move = async (personId: string) => {
    setWhoseOpen(false);
    await run(moveDevice(d.id, personId));
  };

  if (mode === 'confirm') {
    return (
      <div data-testid="device-row" data-connected={d.connected} data-confirming="true" className={ROW}>
        <span className="min-w-0 flex-1 truncate text-app-text">{tr('devices.revokeAsk', { nome: d.name })}</span>
        <button
          type="button"
          disabled={busy}
          data-testid="device-revoke-confirm"
          onClick={() => void revoke()}
          className={`${TEXT_BUTTON} text-red-700 hover:bg-red-600/10 disabled:opacity-50 dark:text-red-400`}
        >
          {tr('devices.revokeShort')}
        </button>
        <button
          ref={cancelRef}
          type="button"
          data-testid="device-revoke-cancel"
          onClick={() => setMode('read')}
          className={`${TEXT_BUTTON} text-app-text-secondary hover:bg-app-hover`}
        >
          {tr('devices.cancelLabel')}
        </button>
      </div>
    );
  }

  if (mode === 'rename') {
    return (
      <div data-testid="device-row" data-connected={d.connected} className={ROW}>
        <Smartphone size={12} className="flex-shrink-0 text-app-text-muted" />
        <input
          autoFocus
          value={name}
          maxLength={60}
          disabled={busy}
          data-testid="device-rename-field"
          aria-label={tr('devices.newNameFor', { nome: d.name })}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            // The menu roves on the arrows; inside a field they move the caret.
            if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); void save(); }
          }}
          className="min-w-0 flex-1 rounded border border-app-border bg-app-bg px-1.5 py-0.5 text-mini text-app-text outline-none focus:border-primary coarse:text-compact"
        />
        <button type="button" aria-label={tr('devices.saveName')} onClick={() => void save()} className={ICON_BUTTON}>
          <Check size={12} />
        </button>
      </div>
    );
  }

  const owner = people.length > 1 ? d.person ?? null : null;
  return (
    <div data-testid="device-row" data-connected={d.connected} className={ROW}>
      <Smartphone size={12} className="flex-shrink-0 text-app-text-muted" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          <span data-testid="device-name" className="truncate text-app-text">{d.name}</span>
          {d.role === 'guest' && (
            <span className="flex-shrink-0 rounded bg-app-hover px-1 text-micro text-app-text-secondary" title={tr('devices.guestTitle')}>
              {tr('devices.guest')}
            </span>
          )}
        </span>
        <span className="block truncate text-micro text-app-text-muted">
          <span data-testid="device-seen">{deviceSeenLine(d, tr, locale)}</span>
          {owner && <> · <span data-testid="device-owner">{tr('devices.ofPerson', { nome: owner.name })}</span></>}
        </span>
      </span>
      {d.current && <span className="flex-shrink-0 text-app-text-muted">{tr('devices.youAreHere')}</span>}
      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${d.connected ? PALLINO_OK : 'bg-app-text-muted/40'}`} />
      {people.length > 1 && (
        <>
          <button
            ref={whoseRef}
            type="button"
            data-testid="device-whose"
            aria-haspopup="menu"
            aria-expanded={whoseOpen}
            aria-label={tr('devices.whoseOf', { nome: d.name })}
            title={tr('devices.whose')}
            onClick={() => setWhoseOpen((v) => !v)}
            className={ICON_BUTTON}
          >
            <Users size={12} />
          </button>
          <Menu
            open={whoseOpen}
            anchorRef={whoseRef}
            onClose={() => setWhoseOpen(false)}
            side="right"
            exclusive={false}
            minWidth={200}
            ariaLabel={tr('devices.whose')}
            testId="device-whose-menu"
          >
            {people.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitemradio"
                aria-checked={d.person?.id === p.id}
                data-testid={`device-whose-${p.id}`}
                onClick={() => void move(p.id)}
                className={`${ROW} w-full text-left text-app-text hover:bg-app-hover`}
              >
                <Check size={12} className={`flex-shrink-0 ${d.person?.id === p.id ? 'text-primary' : 'invisible'}`} />
                <span className="min-w-0 flex-1 truncate">{p.name}{p.owner ? ` ${tr('devices.you')}` : ''}</span>
              </button>
            ))}
          </Menu>
        </>
      )}
      <button
        type="button"
        data-testid="device-rename"
        aria-label={tr('devices.renameName', { nome: d.name })}
        title={tr('devices.rename')}
        onClick={() => { setName(d.name); setMode('rename'); }}
        className={ICON_BUTTON}
      >
        <Pencil size={12} />
      </button>
      <button
        type="button"
        data-testid="device-revoke"
        aria-label={tr('devices.revokeName', { nome: d.name })}
        title={tr('devices.revokeTitle')}
        onClick={() => setMode('confirm')}
        className={`${ICON_BUTTON} hover:text-red-600`}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}
