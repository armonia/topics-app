import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { Monitor, Smartphone, ShieldAlert } from 'lucide-react';
import { guestPairingPeople, pairingApprovalBody, type PairingIdentity, type PairingPerson } from './pairingPerson';
import { apiFetch } from '../../lib/shell/net';
import { getSession, subscribeSession } from '../../lib/auth/sessionState';

/**
 * Il cartello che compare sulla macchina GIÀ fidata quando un dispositivo nuovo
 * chiede accesso.
 *
 * Arriva via WebSocket e non da un pannello di impostazioni, perché la richiesta
 * deve raggiungere l'utente OVUNQUE stia guardando: chi arriva col telefono in
 * mano è fermo su una schermata d'attesa, e se la conferma vivesse dentro un
 * menù resterebbe lì a fissarla senza sapere dove andare.
 *
 * Il codice si MOSTRA, non si digita: serve a chi approva per essere certo di
 * autorizzare quel telefono e non una richiesta arrivata nello stesso istante da
 * qualcun altro sulla stessa rete.
 */
interface Richiesta {
  id: string;
  code: string;
  name: string;
  ip: string | null;
  /**
   * Where it knocks from, said in words.
   *
   * The card used to show the address alone: `192.168.1.7` and `95.253.69.40`
   * look the same, and telling them apart required knowing what `192.168.`
   * means. Whoever approves should read a fact, not deduce one.
   *
   * Optional: an older server does not send it, and then the address is shown
   * as it was.
   */
  from?: 'locale' | 'lan' | 'internet' | 'ignota';
  /**
   * Set only when a Topics server, not a phone or a browser, is asking to
   * pair as a NODE: approving it hands this node's channel to that machine.
   * `currentPrimaryMachineId` is who holds it today (null for nobody yet),
   * and `currentPrimaryMachineName` the name a person reads for it (the
   * machine's name or hostname); an older server sends no name.
   */
  machineId?: string | null;
  machineEpoch?: number | null;
  currentPrimaryMachineId?: string | null;
  currentPrimaryMachineName?: string | null;
}

/** Who loses the channel, in words: the machine's name, the short id only when there is none. */
function channelHolderLabel(r: Pick<Richiesta, 'currentPrimaryMachineId' | 'currentPrimaryMachineName'>): string | null {
  const name = r.currentPrimaryMachineName?.trim();
  if (name) return name;
  return r.currentPrimaryMachineId ? r.currentPrimaryMachineId.slice(0, 8) : null;
}

export function PairingApproval() {
  const tr = useT();
  const [richieste, setRichieste] = useState<Richiesta[]>([]);
  const [people, setPeople] = useState<PairingPerson[]>([]);
  const [inCorso, setInCorso] = useState<string | null>(null);
  /** Chi sta scrivendo il nome di un'altra persona, e cosa ha scritto. */
  const [altrui, setAltrui] = useState<{ id: string; personId: string; create: boolean; name: string } | null>(null);
  // A machine takeover is approved only from a LOCAL human session (the
  // computer's own UI): server/routes/auth.ts rejects the call itself, this
  // just spares the person a click that the server would refuse anyway.
  const [loopback, setLoopback] = useState(() => {
    const s = getSession();
    return s.status === 'paired' && s.as === 'loopback';
  });
  useEffect(() => subscribeSession((s) => setLoopback(s.status === 'paired' && s.as === 'loopback')), []);

  useEffect(() => {
    // Stato iniziale: una richiesta può essere arrivata mentre questa finestra
    // era chiusa o ricaricata.
    void apiFetch('/api/auth/pair/pending', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { requests: [] }))
      .then((b: { requests?: Richiesta[] }) => setRichieste(b.requests ?? []))
      .catch(() => { /* nessuna identità o rete giù: niente da mostrare */ });
    void apiFetch('/api/auth/devices', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : { people: [] }))
      .then((body: { people?: PairingPerson[] }) => setPeople(guestPairingPeople(body.people ?? [])))
      .catch(() => setPeople([]));

    const onRequested = (e: Event) => {
      const d = (e as CustomEvent).detail as Richiesta & { purpose?: string };
      if (d.purpose === 'delegated-node') return;
      setRichieste((prev) => (prev.some((r) => r.id === d.id) ? prev : [...prev, d]));
    };
    const onResolved = (e: Event) => {
      const d = (e as CustomEvent).detail as { requestId: string };
      setRichieste((prev) => prev.filter((r) => r.id !== d.requestId));
    };
    window.addEventListener('topics:auth-pair-requested', onRequested);
    window.addEventListener('topics:auth-pair-resolved', onResolved);
    return () => {
      window.removeEventListener('topics:auth-pair-requested', onRequested);
      window.removeEventListener('topics:auth-pair-resolved', onResolved);
    };
  }, []);

  /**
   * DI CHI È il dispositivo, ed è l'unico momento in cui ha senso chiederlo: è
   * la stessa occhiata in cui si confronta il codice.
   *
   * Il ruolo NON si manda più. Discende dall'essere proprietari
   * dell'installazione, e chiederlo a parte inviterebbe a contraddire il
   * modello: si potrebbe dire «proprietario» di un dispositivo attribuito a un
   * estraneo, e a quel punto quale delle due frasi sarebbe quella vera?
   *
   * Il passaggio precedente resta utile da ricordare. Finché questo cartello
   * mandava il solo `requestId`, ogni dispositivo autorizzato dall'app nasceva
   * proprietario e un ospite era raggiungibile solo con `curl`: la condivisione
   * era irraggiungibile a cascata, perché `ShareControl` diceva per sempre
   * «Nessun ospite».
   */
  const rispondi = async (
    id: string,
    approva: boolean,
    chi?: PairingIdentity,
  ) => {
    setInCorso(id);
    try {
      // Si manda DI CHI È, non che ruolo ha: il ruolo discende dall'essere
      // proprietari dell'installazione, e chiederlo a parte inviterebbe a
      // contraddire il modello — si potrebbe dire «proprietario» di un
      // dispositivo attribuito a un estraneo, e allora quale delle due frasi
      // sarebbe quella vera?
      const corpo = !approva || !chi ? { requestId: id } : pairingApprovalBody(id, chi);
      await apiFetch(`/api/auth/pair/${approva ? 'approve' : 'deny'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(corpo),
      });
      setRichieste((prev) => prev.filter((r) => r.id !== id));
    } finally {
      setInCorso(null);
    }
  };

  if (richieste.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[9998] flex w-80 flex-col gap-2">
      {richieste.map((r) => (
        <div key={r.id} data-testid="pair-request-card" className="rounded-xl border border-app-border bg-surface p-3 shadow-lg">
          <div className="flex items-center gap-2">
            <Smartphone size={14} className="text-app-text-secondary" />
            <span className="text-prose font-medium text-app-text">{tr('pair.requestsAccess', { name: r.name })}</span>
          </div>
          {/* WHERE FROM, in words, with the address behind it.

              Something arriving from outside stands out at a glance: it is the
              only case where this card genuinely asks for attention, and a
              colour saying so spares the reading to whoever is about to
              approve in a hurry. An older server sends no `from`, and then the
              previous line remains. */}
          {(r.from || r.ip) && (
            <div
              className={`mt-0.5 text-mini ${
                r.from === 'internet' ? 'text-amber-600 dark:text-amber-500' : 'text-app-text-muted'
              }`}
            >
              {r.from && r.from !== 'ignota' ? tr(`pair.origin.${r.from}`) : null}
              {r.from && r.from !== 'ignota' && r.ip ? ' · ' : null}
              {r.ip ? r.ip.replace(/^::ffff:/, '') : null}
            </div>
          )}

          {/* A Topics server declaring a machine id is not asking for a device
              slot, it is asking for this NODE'S CHANNEL — which primary it
              obeys from now on. Say that in plain words, with who loses it,
              so approving is an informed act and not a reflex on a familiar
              card (MACHINE-01). */}
          {r.machineId && (
            <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-500/10 p-2 text-mini leading-snug text-amber-700 dark:text-amber-400">
              <ShieldAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                {tr('pair.machineTakeover', {
                  epoch: String(r.machineEpoch ?? 0),
                  from: channelHolderLabel(r) ?? tr('pair.machineTakeover.none'),
                })}
              </span>
            </div>
          )}

          <div className="mt-3 rounded-lg bg-app-bg py-2 text-center font-mono text-display font-semibold tracking-[0.1em] text-app-text">
            {r.code}
          </div>
          <p className="mt-2 text-mini leading-snug text-app-text-secondary">
            {tr('pair.verifyCode')}
          </p>

          {/* La domanda è «di chi è», e ha DUE risposte distinte invece di un
              interruttore: la differenza fra il proprio telefono e quello di un
              altro è la cosa più importante che questo cartello dice, e un
              interruttore la renderebbe una preferenza da notare invece di una
              scelta da fare. Il pieno resta «È mio», che è il caso normale.
              Il ruolo non compare: una persona nuova non è proprietaria, e da
              lì discende che veda solo ciò che le si condivide. */}
          <div className="mt-3 flex gap-2">
            <button
              disabled={inCorso === r.id}
              onClick={() => void rispondi(r.id, false)}
              className="flex-1 rounded-lg border border-app-border px-3 py-1.5 text-compact text-app-text hover:bg-app-bg disabled:opacity-50"
            >
              {tr('pair.deny')}
            </button>
            <button
              disabled={inCorso === r.id || (!!r.machineId && !loopback)}
              onClick={() => void rispondi(r.id, true, { mine: true })}
              className="flex-1 rounded-lg bg-primary px-3 py-1.5 text-compact font-medium text-white hover:opacity-90 disabled:opacity-50"
              data-testid="pair-approve-owner"
            >
              {tr('pair.mine')}
            </button>
          </div>

          {/* The channel this card is about to hand over can only change hands
              from a human sitting at THIS computer — the server itself
              refuses the call otherwise (MACHINE-01). Say so instead of
              letting the person tap a button that does nothing. */}
          {r.machineId && !loopback && (
            <p className="mt-1.5 text-mini leading-snug text-app-text-muted">
              {tr('pair.machineLocalOnly')}
            </p>
          )}

          {/* A SCREEN is the third answer, and an explicit one: the monitor of a machine
              that takes the load shows the load page, read-only, with no person behind it.
              Never the default, never inferred: only this button writes it. */}
          {/* A node pairing is always owner-or-nothing (the channel transfer
              only fires for that role): the screen and "someone else" paths
              below answer a question — whose device, or what kind — that a
              server asking for a channel never raises. */}
          {!r.machineId && (
            <>
              <button
                disabled={inCorso === r.id}
                onClick={() => void rispondi(r.id, true, { screen: true })}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-app-border px-3 py-1.5 text-compact text-app-text-secondary hover:bg-app-bg disabled:opacity-50"
                title={tr('pair.screenBlurb')}
                data-testid="pair-approve-screen"
              >
                <Monitor size={13} aria-hidden="true" />{tr('pair.screen')}
              </button>

              {/* The exact twin of the defect in `DevicesSection`: with the state
                  at null and a missing `r.id` the comparison is true and the line
                  below dereferences it. Check the object first, then the id. */}
              {altrui && altrui.id === r.id ? (
                <div className="mt-2 space-y-1.5">
                  {altrui.create ? (
                    <input
                      autoFocus
                      value={altrui.name}
                      onChange={(event) => setAltrui({ ...altrui, name: event.target.value })}
                      onKeyDown={(event) => { if (event.key === 'Escape') setAltrui(null); }}
                      placeholder={tr('pair.newPersonName')}
                      aria-label={tr('pair.personName')}
                      className="w-full rounded-lg border border-app-border bg-app-bg px-2 py-1.5 text-compact text-app-text outline-none focus:border-primary"
                    />
                  ) : (
                    <select
                      autoFocus
                      value={altrui.personId}
                      onChange={(event) => setAltrui({ ...altrui, personId: event.target.value })}
                      aria-label={tr('pair.choosePerson')}
                      className="w-full rounded-lg border border-app-border bg-app-bg px-2 py-1.5 text-compact text-app-text outline-none focus:border-primary"
                    >
                      {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                    </select>
                  )}
                  <div className="flex flex-wrap justify-between gap-1.5">
                    <button
                      type="button"
                      onClick={() => setAltrui({ ...altrui, create: !altrui.create, name: '' })}
                      className="rounded px-2 py-1 text-mini text-app-text-secondary hover:bg-app-bg"
                    >
                      {altrui.create ? tr('pair.chooseExisting') : tr('pair.createPerson')}
                    </button>
                    <button
                      disabled={inCorso === r.id || (altrui.create ? !altrui.name.trim() : !altrui.personId)}
                      onClick={() => {
                        void rispondi(r.id, true, altrui.create ? { personName: altrui.name } : { personId: altrui.personId });
                        setAltrui(null);
                      }}
                      className="rounded-lg border border-app-border px-2.5 py-1.5 text-compact text-app-text hover:bg-app-bg disabled:opacity-50"
                      data-testid="pair-approve-guest"
                    >
                      {tr('pair.approve')}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  disabled={inCorso === r.id}
                  onClick={() => setAltrui({ id: r.id, personId: people[0]?.id ?? '', create: people.length === 0, name: '' })}
                  className="mt-2 w-full rounded-lg border border-app-border px-3 py-1.5 text-compact text-app-text-secondary hover:bg-app-bg disabled:opacity-50"
                >
                  {tr('pair.someoneElse')}
                </button>
              )}
              <p className="mt-1.5 text-mini leading-snug text-app-text-muted">
                {tr('pair.guestBlurb')}
              </p>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
