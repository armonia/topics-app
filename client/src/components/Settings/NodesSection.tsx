/**
 * NODES: the machines this board spans, and the computers asking to use this one.
 *
 * What is left of the old «Devices» page once the device list moved to its
 * level in the user menu (USERMENU-04): the two forms that need something
 * typed or chosen per request, which a menu row cannot hold. Adding a node
 * asks for an address and shows a code to read on the other machine
 * (MACHINE-02); a request from another computer asks for a folder and an
 * identity (`RemoteNodeRequests`).
 */
import { useEffect, useState } from 'react';
import { Server } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { nodesOf, reloadMachines, useMachines } from '../../state/machinesStore';
import { RemoteNodeRequests } from './RemoteNodeRequests';
import { apiFetch } from '../../lib/shell/net';
import { useMachinesOverview } from '../../hooks/useMachinesOverview';

/**
 * WHERE THE PAIRING IS, in three states and no more: type the address, read the
 * code out loud on the other machine, wait for its verdict.
 */
type PairPhase = 'address' | 'code' | 'outcome';

/** Slow on purpose: the human on the other machine has to read a code and press
 *  a button, and a poll per second buys nothing but requests. */
const PAIR_POLL_MS = 1500;

/**
 * The declared reason a pairing failed, as a sentence.
 *
 * THREE OF THESE SEND A PERSON TO A DIFFERENT MACHINE, which is why one
 * "unreachable" for all of them is the defect MACHINE-02 names: a refused host
 * is fixed on the NODE, an untrusted certificate is fixed HERE, and "nothing
 * answered" is neither of the two.
 */
function pairErrorKey(reason: string | undefined): string {
  switch (reason) {
    case 'host_not_allowed': return 'settings.machines.pair.error.hostNotAllowed';
    case 'tls_untrusted': return 'settings.machines.pair.error.tlsUntrusted';
    case 'unreachable': return 'settings.machines.pair.error.unreachable';
    case 'unauthorized': return 'settings.machines.pair.error.unauthorized';
    case 'server_error': return 'settings.machines.pair.error.serverError';
    case 'bad_address': return 'settings.machines.pair.error.badAddress';
    default: return 'settings.machines.pair.error.generic';
  }
}

export function NodesSection() {
  const t = useT();
  // The node pairing (MACHINE-02), in its three states.
  const [pairPhase, setPairPhase] = useState<PairPhase>('address');
  const [nodeAddress, setNodeAddress] = useState('');
  const [pairing, setPairing] = useState<{ id: string; code: string } | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairOutcome, setPairOutcome] = useState<{ state: 'approved' | 'denied' | 'expired'; name?: string } | null>(null);
  const [pairBusy, setPairBusy] = useState(false);

  const startPairing = async () => {
    const baseUrl = nodeAddress.trim();
    if (!baseUrl || pairBusy) return;
    setPairBusy(true);
    setPairError(null);
    try {
      const r = await apiFetch('/api/machines/pair', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl }),
      });
      // `code` means two different things on the two branches: the six
      // characters to read out loud when it worked, the declared reason when it
      // did not. `r.ok` is what tells them apart, never the field's presence.
      const body = await r.json().catch(() => null) as { pairingId?: string; code?: string; error?: string } | null;
      if (!r.ok) {
        setPairError(t(pairErrorKey(body?.code ?? (r.status === 400 ? 'bad_address' : undefined))));
        return;
      }
      if (!body?.pairingId || !body.code) { setPairError(t(pairErrorKey(undefined))); return; }
      setPairing({ id: body.pairingId, code: body.code });
      setPairPhase('code');
    } catch {
      // No answer from OUR server: not the node refusing anything, so it does
      // not get one of the node's three sentences.
      setPairError(t(pairErrorKey(undefined)));
    } finally {
      setPairBusy(false);
    }
  };

  // The wait for the other machine. One poll in flight at a time (a timer
  // chained after each answer, not an interval): on a node that answers slowly
  // an interval stacks requests that all decide the same thing.
  useEffect(() => {
    if (pairPhase !== 'code' || !pairing) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await apiFetch(`/api/machines/pair/${encodeURIComponent(pairing.id)}`, { credentials: 'same-origin' });
        const body = await r.json().catch(() => null) as {
          state?: string; machine?: { name?: string }; code?: string;
        } | null;
        if (stopped) return;
        if (!r.ok) {
          setPairError(t(pairErrorKey(body?.code)));
          setPairPhase('address');
          return;
        }
        if (body?.state === 'approved') {
          setPairOutcome({ state: 'approved', name: body.machine?.name });
          setPairPhase('outcome');
          // The row also arrives as a `machine:upserted` frame, but a client
          // whose socket is down would never see the node it just paired.
          reloadMachines();
          return;
        }
        if (body?.state === 'denied' || body?.state === 'expired') {
          setPairOutcome({ state: body.state });
          setPairPhase('outcome');
          return;
        }
      } catch {
        // A poll that did not answer is not a verdict: the next one decides.
      }
      if (!stopped) timer = setTimeout(() => { void tick(); }, PAIR_POLL_MS);
    };
    timer = setTimeout(() => { void tick(); }, PAIR_POLL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [pairPhase, pairing, t]);

  const restartPairing = () => {
    setPairPhase('address');
    setPairing(null);
    setPairOutcome(null);
    setPairError(null);
  };

  return (
    <div className="space-y-6" data-testid="settings-page-nodes">
      {/* ADD A NODE: a second machine that can run this board's cards
          (MACHINE-02). The handshake is the device pairing the node already
          has, and the token this machine keeps is a device token issued by the
          node. */}
      <div data-testid="settings-node-pair">
        <h4 className="flex items-center gap-1.5 text-compact font-semibold text-app-text">
          <Server size={13} className="flex-shrink-0 text-app-text-secondary" />
          {t('settings.machines.pair.title')}
        </h4>
        <p className="mt-1 text-compact leading-relaxed text-app-text-secondary">
          {t('settings.machines.pair.blurb')}
        </p>

        {pairPhase === 'address' && (
          <div className="mt-2 space-y-1.5" data-testid="node-pair-address">
            <label className="block text-mini text-app-text-muted" htmlFor="node-pair-url">
              {t('settings.machines.pair.address')}
            </label>
            <div className="flex items-center gap-1.5">
              <input
                id="node-pair-url"
                value={nodeAddress}
                onChange={(e) => setNodeAddress(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void startPairing(); }}
                placeholder={t('settings.machines.pair.addressPlaceholder')}
                className="min-w-0 flex-1 rounded border border-app-border bg-app-bg px-2 py-1 text-prose text-app-text outline-none focus:border-primary coarse:min-h-11"
              />
              <button
                onClick={() => void startPairing()}
                disabled={pairBusy || !nodeAddress.trim()}
                className="flex-shrink-0 rounded-md border border-app-border px-2 py-1 text-mini text-app-text hover:bg-app-hover disabled:opacity-50 coarse:min-h-11 coarse:px-3"
              >
                {t('settings.machines.pair.add')}
              </button>
            </div>
            {pairError && (
              <p data-testid="node-pair-error" className="text-mini leading-relaxed text-red-400">{pairError}</p>
            )}
          </div>
        )}

        {pairPhase === 'code' && pairing && (
          <div className="mt-2 space-y-1.5" data-testid="node-pair-code">
            <p className="text-compact text-app-text-secondary">{t('settings.machines.pair.codeIntro')}</p>
            <p className="font-mono text-headline tracking-[0.3em] text-app-text">{pairing.code}</p>
            <p className="text-mini text-app-text-muted">{t('settings.machines.pair.codeWait')}</p>
            <button
              onClick={restartPairing}
              className="rounded-md border border-app-border px-2 py-1 text-mini text-app-text hover:bg-app-hover"
            >
              {t('settings.machines.pair.cancel')}
            </button>
          </div>
        )}

        {pairPhase === 'outcome' && pairOutcome && (
          <div className="mt-2 space-y-1.5" data-testid="node-pair-outcome">
            <p className={`text-compact leading-relaxed ${pairOutcome.state === 'approved' ? 'text-app-text' : 'text-app-text-secondary'}`}>
              {pairOutcome.state === 'approved'
                ? t('settings.machines.pair.approved', { name: pairOutcome.name ?? nodeAddress.trim() })
                : pairOutcome.state === 'denied'
                  ? t('settings.machines.pair.denied')
                  : t('settings.machines.pair.expired')}
            </p>
            <button
              onClick={restartPairing}
              className="rounded-md border border-app-border px-2 py-1 text-mini text-app-text hover:bg-app-hover"
            >
              {pairOutcome.state === 'approved' ? t('settings.machines.pair.close') : t('settings.machines.pair.again')}
            </button>
          </div>
        )}
      </div>
      <NodeSlots />
      <ProviderTokens />
      <RemoteNodeRequests />
    </div>
  );
}

/** One field per paired node: how many cards it may run at once (1-8). */
function NodeSlots() {
  const t = useT();
  const nodes = nodesOf(useMachines());
  if (nodes.length === 0) return null;
  const save = async (id: string, value: string) => {
    const slots = Number(value);
    if (!Number.isInteger(slots) || slots < 0 || slots > 8) { reloadMachines(); return; }
    await apiFetch(`/api/machines/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots }),
      credentials: 'same-origin',
    });
    reloadMachines();
  };
  return (
    <div className="space-y-2" data-testid="node-slots">
      {nodes.map((m) => (
        <label key={`${m.id}:${m.slots ?? ''}`} className="flex items-center justify-between gap-3 text-compact text-app-text">
          <span>{m.name}: {t('settings.machines.slots.label')}{m.slots === 0 ? ` (${t('settings.machines.slots.paused')})` : ''}</span>
          <input
            type="number"
            min={0}
            max={8}
            defaultValue={m.slots ?? ''}
            placeholder="2"
            data-testid={`node-slots-${m.id}`}
            onBlur={(e) => { void save(m.id, e.target.value); }}
            className="w-16 rounded-md border border-app-border bg-app-surface px-2 py-1 text-right"
          />
        </label>
      ))}
    </div>
  );
}

/** One token field per hosting provider adapter: the token goes to the server's 0600 file and never comes back. */
function ProviderTokens() {
  const t = useT();
  const overview = useMachinesOverview();
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  if (!overview || overview.providers.length === 0) return null;
  const send = async (id: string, token: string | null) => {
    const res = await apiFetch(`/api/machines/providers/${encodeURIComponent(id)}/token`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      credentials: 'same-origin',
    });
    setSaved((prev) => ({ ...prev, [id]: res.ok && token !== null }));
  };
  return (
    <div className="space-y-2" data-testid="provider-tokens">
      <p className="text-mini text-app-text-muted">{t('settings.machines.provider.blurb')}</p>
      {overview.providers.map((p) => (
        <form
          key={p.id}
          className="flex items-center justify-between gap-3 text-compact text-app-text"
          onSubmit={(e) => {
            e.preventDefault();
            const input = e.currentTarget.elements.namedItem('token') as HTMLInputElement;
            void send(p.id, input.value.trim() === '' ? null : input.value).then(() => { input.value = ''; });
          }}
        >
          <span>{p.label}{(p.configured || saved[p.id]) && <span className="ml-2 text-mini text-app-text-muted" data-testid={`provider-token-set-${p.id}`}>{t('settings.machines.provider.set')}</span>}</span>
          <input
            name="token"
            type="password"
            autoComplete="off"
            placeholder={t('settings.machines.provider.placeholder')}
            data-testid={`provider-token-${p.id}`}
            className="w-56 min-w-0 rounded-md border border-app-border bg-app-surface px-2 py-1 coarse:min-h-11"
          />
          <button type="submit" className="rounded-md border border-app-border px-2 py-1 text-mini hover:bg-app-hover coarse:min-h-11 coarse:px-3">{t('settings.machines.provider.save')}</button>
        </form>
      ))}
    </div>
  );
}
