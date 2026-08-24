import { useCallback, useState } from 'react';
import { Building2, Github, Link as LinkIcon, Mail, MapPin } from 'lucide-react';
import { useT } from '@/hooks/useT';
import { peopleApi, type PersonaConProfilo } from '@/lib/api';
import { PersonAvatar } from './PersonAvatar';

/**
 * THE HEADER OF A PROFILE, in the shape everybody already knows.
 *
 * -- WHY GITHUB'S SHAPE AND NOT ONE OF OUR OWN -------------------------------
 * The previous profile was a list of boxes: statistics, Discord, the group, the
 * people. It answered "what is configured", never "who is this". A profile is
 * read in one second and the second is spent on four things, always the same
 * four: the face, the name, one line about them, and how many people follow
 * them. That layout is not GitHub's taste, it is the order in which a human
 * reads a person, and copying it costs nothing and saves the explanation.
 *
 * -- WHAT WE ADD THAT GITHUB CANNOT HAVE -------------------------------------
 * Underneath, the Topics figures: prompts written, tokens spent, the last time
 * this person asked something. GitHub knows about repositories; this knows
 * about work that went through here, which is the only thing a profile in this
 * app can say that is not a copy of a page one click away.
 *
 * -- NULL IS NOT ZERO --------------------------------------------------------
 * `stats` and `counts` arrive `null` when their owner switched that facet off
 * in Privacy. Null is drawn as a SENTENCE ("this person does not publish their
 * figures"), never as a zero: a zero is a measurement, and inventing one about
 * somebody who asked not to be measured is the exact thing the switch was for.
 *
 * -- THE FOLLOW BUTTON IS OPTIMISTIC, AND SAYS SO WHEN IT IS WRONG ------------
 * Following is one tap and a round trip. Waiting for the server before moving
 * the label makes a button that feels broken; so the label moves at once and
 * the counters come back from the response, which is the authority. If the
 * request fails the previous state is put back: nothing is left claiming a
 * relationship that does not exist.
 */

function compattoNum(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(n));
}

/** A blog URL as GitHub prints it: no scheme, no trailing slash, still a link. */
function etichettaLink(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function hrefLink(url: string): string {
  return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

function Meta({ icon: Icon, children }: { icon: typeof MapPin; children: React.ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-app-text-secondary">
      <Icon size={13} className="flex-shrink-0 text-app-text-tertiary" />
      <span className="truncate">{children}</span>
    </span>
  );
}

function Contatore({ n, etichetta, onClick, testId }: {
  n: number; etichetta: string; onClick?: () => void; testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      data-testid={testId}
      className="inline-flex items-baseline gap-1 rounded px-1 py-0.5 text-[12.5px] text-app-text-secondary hover:bg-app-hover hover:text-app-text disabled:pointer-events-none coarse:min-h-11"
    >
      <span className="font-semibold text-app-text tabular-nums">{compattoNum(n)}</span>
      {etichetta}
    </button>
  );
}

export interface ProfileHeaderProps {
  persona: PersonaConProfilo;
  /** Called with the person as the server just returned it, counters included. */
  onCambiata: (p: PersonaConProfilo) => void;
  onApriFollower?: () => void;
  onApriSeguiti?: () => void;
}

export function ProfileHeader({ persona, onCambiata, onApriFollower, onApriSeguiti }: ProfileHeaderProps) {
  const t = useT();
  const [inCorso, setInCorso] = useState(false);
  const [modificaLogin, setModificaLogin] = useState(false);
  const [bozza, setBozza] = useState(persona.githubLogin ?? '');
  const [errore, setErrore] = useState<string | null>(null);

  const g = persona.github;
  const nome = g?.name || persona.displayName;

  const cambiaFollow = useCallback(async () => {
    if (inCorso) return;
    setInCorso(true);
    const prima = persona;
    // Optimistic: the label moves now, the counters are corrected by the answer.
    onCambiata({ ...persona, viewerFollows: !persona.viewerFollows });
    try {
      const r = persona.viewerFollows
        ? await peopleApi.unfollow(persona.id)
        : await peopleApi.follow(persona.id);
      onCambiata({ ...prima, viewerFollows: r.following, counts: prima.counts ? r.counts : null });
    } catch {
      onCambiata(prima);
    } finally {
      setInCorso(false);
    }
  }, [inCorso, persona, onCambiata]);

  const salvaLogin = useCallback(async () => {
    const valore = bozza.trim();
    try {
      await peopleApi.setGithubLogin(persona.id, valore === '' ? null : valore);
      onCambiata(await peopleApi.get(persona.id));
      setModificaLogin(false);
      setErrore(null);
    } catch {
      setErrore(t('privacy.failed'));
    }
  }, [bozza, persona.id, onCambiata, t]);

  return (
    <div data-testid="profile-header" className="flex flex-col gap-4 sm:flex-row sm:items-start">
      <PersonAvatar github={g} size={80} className="sm:mt-0.5" />

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 data-testid="profile-name" className="truncate text-[20px] font-semibold leading-tight text-app-text">
              {nome}
            </h1>
            {persona.githubLogin && (
              <a
                href={g?.htmlUrl ?? `https://github.com/${persona.githubLogin}`}
                target="_blank"
                rel="noreferrer"
                data-testid="profile-login"
                className="text-[14px] leading-tight text-app-text-muted hover:text-primary"
              >
                @{persona.githubLogin}
              </a>
            )}
            {persona.followsViewer && !persona.isMe && (
              <span className="ml-2 rounded border border-app-border px-1.5 py-0.5 align-middle text-[10.5px] text-app-text-muted">
                {t('profile.followsYou')}
              </span>
            )}
          </div>

          {!persona.isMe && (
            <button
              type="button"
              onClick={() => void cambiaFollow()}
              data-testid="profile-follow"
              aria-pressed={persona.viewerFollows}
              className={`flex-shrink-0 rounded-md border px-3 py-1.5 text-[12.5px] font-medium coarse:min-h-11 ${
                persona.viewerFollows
                  ? 'border-app-border text-app-text hover:bg-app-hover'
                  : 'border-primary bg-primary/10 text-primary hover:bg-primary/20'
              }`}
            >
              {persona.viewerFollows ? t('profile.unfollow') : t('profile.follow')}
            </button>
          )}
        </div>

        {g?.bio && <p className="text-[13px] leading-snug text-app-text-secondary">{g.bio}</p>}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {g?.company && <Meta icon={Building2}>{g.company}</Meta>}
          {g?.location && <Meta icon={MapPin}>{g.location}</Meta>}
          {g?.blog && (
            <Meta icon={LinkIcon}>
              <a href={hrefLink(g.blog)} target="_blank" rel="noreferrer" className="hover:text-primary">
                {etichettaLink(g.blog)}
              </a>
            </Meta>
          )}
          {/* The email is here only when its owner publishes it: the server
              sends `null` otherwise, so there is nothing to hide client side. */}
          {persona.email && (
            <Meta icon={Mail}>
              <a href={`mailto:${persona.email}`} className="hover:text-primary">{persona.email}</a>
            </Meta>
          )}
        </div>

        {persona.counts && (
          <div className="flex flex-wrap items-center gap-2">
            <Contatore
              n={persona.counts.followers}
              etichetta={t('profile.followers')}
              onClick={onApriFollower}
              testId="profile-count-followers"
            />
            <span className="text-app-text-tertiary">·</span>
            <Contatore
              n={persona.counts.following}
              etichetta={t('profile.following')}
              onClick={onApriSeguiti}
              testId="profile-count-following"
            />
          </div>
        )}

        {/* CONNECTING GITHUB IS PART OF THE HEADER, not a settings box three
            pages away: the empty space where the face should be is exactly
            where you realise you never set the login. Only on your own. */}
        {persona.isMe && (
          modificaLogin ? (
            <div className="flex items-center gap-2">
              <Github size={13} className="flex-shrink-0 text-app-text-tertiary" />
              <input
                autoFocus
                value={bozza}
                onChange={(e) => setBozza(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void salvaLogin();
                  if (e.key === 'Escape') setModificaLogin(false);
                }}
                placeholder="github login"
                spellCheck={false}
                data-testid="profile-github-input"
                className="min-w-0 flex-1 rounded border border-app-border bg-app-surface px-2 py-1 text-[12px] text-app-text"
              />
              <button
                type="button"
                onClick={() => void salvaLogin()}
                className="flex-shrink-0 rounded border border-app-border px-2 py-1 text-[12px] text-app-text hover:bg-app-hover"
              >
                {t('common.save')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => { setBozza(persona.githubLogin ?? ''); setModificaLogin(true); }}
              data-testid="profile-github-edit"
              className="inline-flex items-center gap-1.5 text-[12px] text-app-text-muted hover:text-primary coarse:min-h-11"
            >
              <Github size={13} />
              {persona.githubLogin ?? t('profile.noGithub')}
            </button>
          )
        )}
        {errore && <p className="text-[11px] text-red-500">{errore}</p>}
      </div>
    </div>
  );
}

/** The Topics half of the header: the part GitHub has no way of knowing. */
export function ProfileTopicsStats({ persona }: { persona: PersonaConProfilo }) {
  const t = useT();
  if (!persona.stats) {
    return (
      <p data-testid="profile-stats-hidden" className="text-[12px] text-app-text-muted">
        {t('profile.topics.hidden')}
      </p>
    );
  }
  const s = persona.stats;
  const voci: Array<[string, string]> = [
    [compattoNum(s.prompts), t('profile.topics.prompts')],
    [compattoNum(s.inputTokens), t('profile.topics.tokensIn')],
    [compattoNum(s.outputTokens), t('profile.topics.tokensOut')],
  ];
  return (
    <div data-testid="profile-topics-stats">
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-app-text-muted">
        {t('profile.topics.title')}
      </h3>
      <dl className="grid grid-cols-3 gap-3">
        {voci.map(([valore, etichetta]) => (
          <div key={etichetta} className="min-w-0 rounded-md border border-app-border px-3 py-2">
            <dd className="text-[17px] font-semibold leading-tight text-app-text tabular-nums">{valore}</dd>
            <dt className="truncate text-[10.5px] uppercase tracking-wide text-app-text-tertiary">{etichetta}</dt>
          </div>
        ))}
      </dl>
      {s.ultimoPrompt && (
        <p className="mt-2 text-[11px] text-app-text-muted">
          {t('profile.topics.lastPrompt')}: {new Date(s.ultimoPrompt).toLocaleString()}
        </p>
      )}
    </div>
  );
}
