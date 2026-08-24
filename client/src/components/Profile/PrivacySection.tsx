import { useCallback, useEffect, useState } from 'react';
import { peopleApi, type ProfilePrivacy } from '@/lib/api';
import { useT } from '@/hooks/useT';
import { useIo } from './useIo';

/**
 * WHAT YOUR PROFILE PUBLISHES, five switches, and none of them is decoration.
 *
 * -- THE SWITCH IS NOT A CSS RULE --------------------------------------------
 * Every one of these is enforced where the data leaves the machine: switch off
 * the figures and `/api/people/:id` stops carrying them, switch off the profile
 * and the route answers "not found" to everybody but you. A privacy control
 * that only stops a component from rendering is a promise the network tab
 * disproves in four seconds, and it is worse than no control, because somebody
 * believed it.
 *
 * -- WHY FIVE AND NOT ONE ----------------------------------------------------
 * A single "public / private" would have been simpler to build and useless to
 * use: the interesting cases are all in the middle. Somebody wants their face
 * and their followers visible and their token spend private; somebody else the
 * other way round. Each switch names WHAT DISAPPEARS, not the feature it
 * belongs to: "usage figures" you can decide about, "stats" you cannot.
 *
 * -- WHY THE EMAIL IS BORN OFF -----------------------------------------------
 * The other four default to on because they are what a profile is for. An
 * address cannot be un-published once it has been read, so the default that
 * costs the user a click is the safe one.
 *
 * -- IT SAVES ON THE FLIP ----------------------------------------------------
 * No Save button: the flip IS the decision, and a privacy page you can leave
 * with unsaved changes is a page that lies about the state of the world. If the
 * write fails the switch goes back, with a line saying so.
 */

const VOCI: ReadonlyArray<keyof ProfilePrivacy> = [
  'showProfile',
  'showStats',
  'showEmail',
  'showFollowers',
  'showPresence',
];

function Interruttore({ acceso, onCambia, etichetta, aiuto, testId, disabilitato }: {
  acceso: boolean;
  onCambia: () => void;
  etichetta: string;
  aiuto: string;
  testId: string;
  disabilitato: boolean;
}) {
  return (
    <li className="flex items-start gap-3 rounded-md border border-app-border px-3 py-2.5">
      <button
        type="button"
        role="switch"
        aria-checked={acceso}
        aria-label={etichetta}
        disabled={disabilitato}
        onClick={onCambia}
        data-testid={testId}
        className={`mt-0.5 h-5 w-9 flex-shrink-0 rounded-full border transition-colors disabled:opacity-50 ${
          acceso ? 'border-primary bg-primary/70' : 'border-app-border bg-app-hover'
        }`}
      >
        <span
          className={`block h-4 w-4 rounded-full bg-white shadow transition-transform ${
            acceso ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
      <div className="min-w-0">
        <div className="text-[13px] text-app-text">{etichetta}</div>
        <p className="text-[11.5px] leading-snug text-app-text-muted">{aiuto}</p>
      </div>
    </li>
  );
}

export function PrivacySection() {
  const t = useT();
  const { io, pronto } = useIo();
  const [privacy, setPrivacy] = useState<ProfilePrivacy | null>(null);
  const [errore, setErrore] = useState(false);
  const [inCorso, setInCorso] = useState(false);

  const ioId = io?.id ?? null;

  useEffect(() => {
    if (!ioId) return;
    let annullato = false;
    peopleApi.privacy(ioId).then(
      ({ privacy: p }) => { if (!annullato) setPrivacy(p); },
      () => { if (!annullato) setErrore(true); },
    );
    return () => { annullato = true; };
  }, [ioId]);

  const cambia = useCallback((chiave: keyof ProfilePrivacy) => async () => {
    if (!ioId || !privacy || inCorso) return;
    const prima = privacy;
    const dopo = { ...privacy, [chiave]: !privacy[chiave] };
    setPrivacy(dopo);
    setInCorso(true);
    setErrore(false);
    try {
      const r = await peopleApi.setPrivacy(ioId, { [chiave]: dopo[chiave] });
      setPrivacy(r.privacy);
    } catch {
      setPrivacy(prima);
      setErrore(true);
    } finally {
      setInCorso(false);
    }
  }, [ioId, privacy, inCorso]);

  if (!pronto) return null;
  if (!privacy) {
    return (
      <p data-testid="privacy-unavailable" className="text-[12px] text-app-text-muted">
        {t('profile.notFound')}
      </p>
    );
  }

  return (
    <div data-testid="privacy-section" className="space-y-2">
      <ul className="space-y-2">
        {VOCI.map((chiave) => (
          <Interruttore
            key={chiave}
            acceso={privacy[chiave]}
            onCambia={() => void cambia(chiave)()}
            etichetta={t(`privacy.${chiave}.label`)}
            aiuto={t(`privacy.${chiave}.help`)}
            testId={`privacy-${chiave}`}
            disabilitato={inCorso}
          />
        ))}
      </ul>
      {errore && <p className="text-[11px] text-red-500">{t('privacy.failed')}</p>}
    </div>
  );
}
