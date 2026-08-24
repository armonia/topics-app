import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { peopleApi, type PersonaConProfilo, type PersonaSommaria } from '@/lib/api';
import { useT } from '@/hooks/useT';
import { ProfileHeader, ProfileTopicsStats } from './ProfileHeader';
import { PeopleList } from './PeopleList';

/**
 * SOMEBODY ELSE'S PROFILE: the same page as yours, minus what is yours alone.
 *
 * It is deliberately the SAME component pair as your own profile (the header
 * and the Topics figures), because the day the two drift is the day nobody can
 * tell what other people actually see of them. What changes is only what is
 * missing: no privacy switches, no GitHub login editor, and a Follow button
 * where your own page has nothing.
 *
 * "NOT AVAILABLE" IS A REAL ANSWER. A person who switched their profile off
 * gives a 404 here, and the page says so in one line instead of spinning: the
 * request will not succeed later either, and a spinner that never ends is how a
 * deliberate refusal gets reported as a bug.
 */
export function PersonProfile({ personId, onIndietro }: { personId: string; onIndietro: () => void }) {
  const t = useT();
  // ONE STATE CARRYING ITS OWN ID, instead of three that get cleared by hand.
  // Resetting them at the top of the effect is a synchronous setState in an
  // effect body, which is the cascade `react-hooks/set-state-in-effect` stops,
  // and it was also a real defect: between the reset and the answer the page
  // showed the PREVIOUS person for one frame. Here the record carries the id it
  // is about, so a record for somebody else is simply not drawn.
  const [caricato, setCaricato] = useState<{ id: string; persona: PersonaConProfilo | null }>(
    { id: '', persona: null },
  );
  const [assente, setAssente] = useState<string | null>(null);
  const [scheda, setScheda] = useState<'followers' | 'following' | null>(null);
  const [gente, setGente] = useState<{ scheda: string; persone: PersonaSommaria[] } | null>(null);

  useEffect(() => {
    let annullato = false;
    peopleApi.get(personId).then(
      (p) => { if (!annullato) setCaricato({ id: personId, persona: p }); },
      () => { if (!annullato) setAssente(personId); },
    );
    return () => { annullato = true; };
  }, [personId]);

  useEffect(() => {
    if (!scheda) return;
    let annullato = false;
    const chiedi = scheda === 'followers' ? peopleApi.followers(personId) : peopleApi.following(personId);
    chiedi.then(
      ({ people }) => { if (!annullato) setGente({ scheda, persone: people }); },
      () => { if (!annullato) setGente({ scheda, persone: [] }); },
    );
    return () => { annullato = true; };
  }, [scheda, personId]);

  const apri = useCallback((s: 'followers' | 'following') => () => {
    setScheda((cur) => (cur === s ? null : s));
  }, []);

  const persona = caricato.id === personId ? caricato.persona : null;
  const elenco = gente?.scheda === scheda ? gente.persone : null;

  return (
    <div data-testid="person-profile" className="space-y-5">
      <button
        type="button"
        onClick={onIndietro}
        data-testid="person-profile-back"
        className="inline-flex items-center gap-1.5 text-[12px] text-app-text-muted hover:text-primary coarse:min-h-11"
      >
        <ArrowLeft size={13} />
        {t('profile.back')}
      </button>

      {assente === personId && (
        <p data-testid="person-profile-missing" className="text-[13px] text-app-text-muted">
          {t('profile.notFound')}
        </p>
      )}

      {persona && (
        <>
          <ProfileHeader
            persona={persona}
            onCambiata={(p) => setCaricato({ id: personId, persona: p })}
            onApriFollower={persona.counts ? apri('followers') : undefined}
            onApriSeguiti={persona.counts ? apri('following') : undefined}
          />
          <ProfileTopicsStats persona={persona} />
          {scheda && elenco && (
            <PeopleList
              persone={elenco}
              vuoto={t('profile.followers.private')}
              testId={`person-list-${scheda}`}
            />
          )}
        </>
      )}
    </div>
  );
}
