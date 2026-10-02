import { useCallback, useEffect, useState } from 'react';
import { peopleApi, type ProfilePrivacy } from '@/lib/api';
import { useT } from '@/hooks/useT';
import { useSelf } from './useSelf';
import { Switch } from '../Shared/Switch';

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

const SWITCHES: ReadonlyArray<keyof ProfilePrivacy> = [
  'showProfile',
  'showStats',
  'showEmail',
  'showFollowers',
  'showPresence',
];

/** One privacy switch: the app's `Shared/Switch` beside its name and gloss,
 *  instead of the private copy this file used to draw. */
function PrivacyRow({ on, onToggle, label, help, testId, disabled }: {
  on: boolean;
  onToggle: () => void;
  label: string;
  help: string;
  testId: string;
  disabled: boolean;
}) {
  return (
    <li className="flex items-start gap-3 rounded-md border border-app-border px-3 py-2.5">
      <Switch checked={on} onChange={onToggle} label={label} disabled={disabled} testId={testId} className="mt-0.5" />
      <div className="min-w-0">
        <div className="text-prose text-app-text">{label}</div>
        <p className="text-compact leading-snug text-app-text-muted">{help}</p>
      </div>
    </li>
  );
}

export function PrivacySection() {
  const t = useT();
  const { me, ready } = useSelf();
  const [privacy, setPrivacy] = useState<ProfilePrivacy | null>(null);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);

  const meId = me?.id ?? null;

  useEffect(() => {
    if (!meId) return;
    let canceled = false;
    peopleApi.privacy(meId).then(
      ({ privacy: p }) => { if (!canceled) setPrivacy(p); },
      () => { if (!canceled) setError(true); },
    );
    return () => { canceled = true; };
  }, [meId]);

  const toggle = useCallback((field: keyof ProfilePrivacy) => async () => {
    if (!meId || !privacy || saving) return;
    const before = privacy;
    const after = { ...privacy, [field]: !privacy[field] };
    setPrivacy(after);
    setSaving(true);
    setError(false);
    try {
      const r = await peopleApi.setPrivacy(meId, { [field]: after[field] });
      setPrivacy(r.privacy);
    } catch {
      setPrivacy(before);
      setError(true);
    } finally {
      setSaving(false);
    }
  }, [meId, privacy, saving]);

  if (!ready) return null;
  if (!privacy) {
    return (
      <p data-testid="privacy-unavailable" className="text-compact text-app-text-muted">
        {t('profile.notFound')}
      </p>
    );
  }

  return (
    <div data-testid="privacy-section" className="space-y-2">
      <ul className="space-y-2">
        {SWITCHES.map((field) => (
          <PrivacyRow
            key={field}
            on={privacy[field]}
            onToggle={() => void toggle(field)()}
            label={t(`privacy.${field}.label`)}
            help={t(`privacy.${field}.help`)}
            testId={`privacy-${field}`}
            disabled={saving}
          />
        ))}
      </ul>
      {error && <p className="text-mini text-red-500">{t('privacy.failed')}</p>}
    </div>
  );
}
