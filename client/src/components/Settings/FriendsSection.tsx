import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/hooks/useT';
import { Github, User } from 'lucide-react';
import { ApiError, peopleApi, type PersonaConProfilo } from '../../lib/api';

/**
 * I PROFILI DEGLI AMICI: la faccia da GitHub, e quanto lavorano.
 *
 * ── PERCHÉ LA FACCIA VIENE DA GITHUB E NON DA UN CARICAMENTO ────────────────
 * Chiedere a ognuno di caricarsi una foto significa un elenco di iniziali
 * grigie per sempre: nessuno lo fa. Il login GitHub è una riga di testo che chi
 * scrive codice ha già, e da lì l'avatar, il nome vero e la bio arrivano da
 * soli — e restano aggiornati senza che nessuno ci torni sopra.
 *
 * ── L'ELENCO NON VA SULLA RETE ──────────────────────────────────────────────
 * `GET /api/people` serve solo la cache del server: la quota pubblica di GitHub
 * è di 60 richieste all'ora, e una lista che ne fa una per riga a ogni apertura
 * la finisce. Il profilo fresco si scarica aprendo UNA persona — che è ciò che
 * fa il click qui sotto — e da quel momento la faccia c'è per tutti.
 *
 * ── I NUMERI SONO DUE, E DICONO COSE DIVERSE ────────────────────────────────
 * «Prompt» sono i messaggi attribuiti a quella persona (migration 095).
 * «Token» sono quelli delle RISPOSTE appese ai suoi prompt: non è «quanto costa
 * all'azienda» — un turno agentico lungo lavora molto oltre la risposta che si
 * vede — è quanto pesa il suo turno. Chi non ha mai scritto niente mostra un
 * trattino e non uno zero: zero è una misura, il trattino è «non risulta».
 */

const compatto = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
};

function Avatar({ p }: { p: PersonaConProfilo }) {
  if (p.github?.avatarUrl) {
    return (
      <img
        src={p.github.avatarUrl}
        alt=""
        className="h-9 w-9 flex-shrink-0 rounded-full object-cover"
        loading="lazy"
      />
    );
  }
  return (
    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-app-hover">
      <User size={16} className="text-app-text-tertiary" />
    </div>
  );
}

export function FriendsSection() {
  const tr = useT();
  const [persone, setPersone] = useState<PersonaConProfilo[] | null>(null);
  const [aperta, setAperta] = useState<string | null>(null);
  const [bozza, setBozza] = useState<string>('');
  const [errore, setErrore] = useState<string | null>(null);

  /**
   * L'elenco si carica una volta, all'apertura.
   *
   * La richiesta sta DENTRO l'effetto e lo stato si posa nella callback, non nel
   * corpo: chiamare qui una funzione che fa `setState` — anche dietro un `await`
   * — è una catena di render che React sconsiglia, ed è ciò che
   * `react-hooks/set-state-in-effect` ferma. `annullato` chiude l'altra metà
   * dello stesso problema: se il pannello si smonta mentre la fetch è in volo,
   * la risposta non deve scrivere su un componente che non c'è più.
   */
  useEffect(() => {
    let annullato = false;
    peopleApi.list().then(
      ({ people }) => { if (!annullato) setPersone(people); },
      () => { if (!annullato) setPersone([]); },
    );
    return () => { annullato = true; };
  }, []);

  /** Aprire una persona è ciò che autorizza la richiesta a GitHub: un gesto
   *  umano, uno alla volta. Il risultato rientra nella riga già disegnata. */
  const apri = useCallback(async (p: PersonaConProfilo) => {
    const prossima = aperta === p.id ? null : p.id;
    setAperta(prossima);
    setErrore(null);
    setBozza(p.githubLogin ?? '');
    if (prossima === null) return;
    try {
      const fresca = await peopleApi.get(p.id);
      setPersone((cur) => (cur ?? []).map((x) => (x.id === p.id ? fresca : x)));
    } catch { /* la riga resta com'era: una faccia che manca non è un errore */ }
  }, [aperta]);

  const salvaLogin = useCallback(async (p: PersonaConProfilo) => {
    const valore = bozza.trim();
    try {
      await peopleApi.setGithubLogin(p.id, valore === '' ? null : valore);
      setErrore(null);
      const fresca = await peopleApi.get(p.id);
      setPersone((cur) => (cur ?? []).map((x) => (x.id === p.id ? fresca : x)));
    } catch (e) {
      // Il server distingue «non puoi» da «è già di un altro» da «non è un
      // login», e lo dice con lo STATO — non con una frase da cui indovinarlo.
      // È la differenza fra riprovare e riprovare uguale.
      const stato = e instanceof ApiError ? e.status : 0;
      setErrore(
        stato === 409 ? 'Quel login è già di un\'altra persona.'
        : stato === 403 ? 'Solo la persona stessa o chi amministra il gruppo può cambiarlo.'
        : stato === 400 ? 'Non sembra un login GitHub.'
        : 'Non è riuscito.',
      );
    }
  }, [bozza]);

  if (persone === null) return null;

  return (
    <div data-testid="friends-section">
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-app-text-muted">
        Profili
      </h3>
      <ul className="space-y-1">
        {persone.map((p) => {
          const nome = p.github?.name || p.displayName;
          const aperto = aperta === p.id;
          return (
            <li key={p.id} className="rounded-md border border-app-border">
              <button
                onClick={() => void apri(p)}
                className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-app-hover coarse:min-h-11"
                data-testid={`friend-row-${p.id}`}
              >
                <Avatar p={p} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-app-text">{nome}</span>
                  <span className="block truncate text-[11px] text-app-text-muted">
                    {p.githubLogin ? `@${p.githubLogin}` : p.email || 'nessun profilo GitHub'}
                  </span>
                </span>
                <span className="flex-shrink-0 text-right text-[11px] leading-tight text-app-text-muted">
                  <span className="block">
                    {p.stats.prompts > 0 ? `${compatto(p.stats.prompts)} prompt` : '-'}
                  </span>
                  <span className="block">
                    {p.stats.prompts > 0
                      ? `${compatto(p.stats.inputTokens + p.stats.outputTokens)} token`
                      : ''}
                  </span>
                </span>
              </button>

              {aperto && (
                <div className="space-y-2 border-t border-app-border px-3 py-2">
                  {p.github?.bio && (
                    <p className="text-[12px] leading-snug text-app-text-secondary">{p.github.bio}</p>
                  )}
                  {p.github && (p.github.company || p.github.location) && (
                    <p className="text-[11px] text-app-text-muted">
                      {[p.github.company, p.github.location].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  <div className="flex items-center gap-2">
                    <Github size={13} className="flex-shrink-0 text-app-text-tertiary" />
                    <input
                      value={bozza}
                      onChange={(e) => setBozza(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void salvaLogin(p); }}
                      placeholder="login GitHub"
                      spellCheck={false}
                      className="min-w-0 flex-1 rounded border border-app-border bg-app-surface px-2 py-1 text-[12px] text-app-text"
                      data-testid={`friend-login-${p.id}`}
                    />
                    <button
                      onClick={() => void salvaLogin(p)}
                      className="flex-shrink-0 rounded border border-app-border px-2 py-1 text-[12px] text-app-text hover:bg-app-hover"
                    >
                      {tr('common.save')}
                    </button>
                  </div>
                  {errore && <p className="text-[11px] text-red-500">{errore}</p>}
                  <dl className="grid grid-cols-3 gap-2 text-[11px]">
                    <div>
                      <dt className="text-app-text-muted">Prompt</dt>
                      <dd className="text-app-text">{compatto(p.stats.prompts)}</dd>
                    </div>
                    <div>
                      <dt className="text-app-text-muted">Token in</dt>
                      <dd className="text-app-text">{compatto(p.stats.inputTokens)}</dd>
                    </div>
                    <div>
                      <dt className="text-app-text-muted">Token out</dt>
                      <dd className="text-app-text">{compatto(p.stats.outputTokens)}</dd>
                    </div>
                  </dl>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
