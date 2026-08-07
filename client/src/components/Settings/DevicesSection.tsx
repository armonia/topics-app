import { useCallback, useEffect, useState } from 'react';
import { Smartphone, Trash2, Check, X as XIcon, Pencil, Monitor } from 'lucide-react';

/**
 * I dispositivi autorizzati, e il gesto per toglierne uno.
 *
 * Esiste perché senza di lui la frase scritta in SECURITY.md — «authorization is
 * per device and can be revoked at any time» — sarebbe vera solo per chi sa
 * usare `curl`. Un'impostazione di sicurezza che non ha una superficie è una
 * promessa che il prodotto non mantiene.
 *
 * Le righe revocate NON spariscono: una riga cancellata non racconta niente,
 * una revocata dice che quel dispositivo c'è stato e quando gli è stata tolta
 * la fiducia. È ciò che rende questo elenco una cronologia invece di un
 * inventario — e l'unico posto in cui accorgersi di un accesso che non
 * riconosci.
 */
interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  firstIp: string | null;
  revokedAt: number | null;
  /** Ha una socket viva ADESSO. Non è «autorizzato»: un dispositivo può essere
   *  autorizzato da settimane e spento da ieri. */
  connected: boolean;
  /** Quello da cui stai guardando. Senza, con tre iPhone in elenco non sai
   *  quale stai per revocare — e ti tagli fuori da solo. */
  current: boolean;
  /** `owner` vede tutto, `guest` vede solo ciò che gli è stato condiviso.
   *  Si mostra perché è la differenza più grossa fra due righe di questo
   *  elenco, e perché è l'unico modo di accorgersi di averla scelta male al
   *  momento dell'approvazione: senza, un dispositivo autorizzato per sbaglio
   *  come proprietario è indistinguibile da uno voluto. */
  role?: 'owner' | 'guest';
  /** Di chi è. Assegnata dalla migration 084 con un'euristica — al momento
   *  dell'appaiamento nessuno lo chiedeva — quindi può essere sbagliata, ed è
   *  il motivo per cui esiste il gesto per spostarla. */
  person?: { id: string; name: string } | null;
}

interface Persona {
  id: string;
  name: string;
  /** Proprietaria dell'installazione: vede tutto, e non è un destinatario di
   *  condivisioni. */
  owner: boolean;
}

function quando(ms: number | null): string {
  if (!ms) return 'mai';
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'adesso';
  if (min < 60) return `${min} min fa`;
  const ore = Math.floor(min / 60);
  if (ore < 24) return `${ore} h fa`;
  const giorni = Math.floor(ore / 24);
  if (giorni < 30) return `${giorni} g fa`;
  return new Date(ms).toLocaleDateString('it-IT');
}

export function DevicesSection() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [computer, setComputer] = useState<{ name: string; current: boolean } | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [conferma, setConferma] = useState<string | null>(null);
  const [inCorso, setInCorso] = useState<string | null>(null);
  const [rinomina, setRinomina] = useState<{ id: string; valore: string } | null>(null);
  const [persone, setPersone] = useState<Persona[]>([]);
  const [sposta, setSposta] = useState<string | null>(null);

  const carica = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/devices', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(String(r.status));
      const b = await r.json() as {
        devices: Device[]; thisComputer?: { name: string; current: boolean }; people?: Persona[];
      };
      setDevices(b.devices);
      setComputer(b.thisComputer ?? null);
      setPersone(b.people ?? []);
      setErrore(null);
    } catch {
      // Un errore qui è quasi sempre TRANSITORIO: il server si ricarica in un
      // paio di secondi a ogni salvataggio, e una richiesta partita in quella
      // finestra non trova nessuno. Prima questo lasciava il pannello bloccato
      // sul messaggio per sempre, perché `carica` girava una volta sola al
      // montaggio: un guasto di due secondi diventava permanente, e l'unico
      // rimedio era riavviare l'app. Ora si riprova da soli, e comunque c'è un
      // bottone: un errore senza un gesto per uscirne è un vicolo cieco.
      setErrore('Non riesco a leggere l’elenco dei dispositivi.');
      setDevices([]);
    }
  }, []);

  useEffect(() => { void carica(); }, [carica]);

  // Ritenta da solo finché non riesce, con attese crescenti (1s, 2s, 4s, 8s) e
  // poi si ferma: insistere all'infinito su un server spento è rumore.
  useEffect(() => {
    if (!errore) return;
    let n = 0;
    let t: ReturnType<typeof setTimeout>;
    const riprova = () => {
      n += 1;
      void carica();
      if (n < 4) t = setTimeout(riprova, 1000 * 2 ** n);
    };
    t = setTimeout(riprova, 1000);
    return () => clearTimeout(t);
  }, [errore, carica]);

  // Un dispositivo appaiato o revocato da un'altra finestra deve comparire qui
  // senza che si debba riaprire il pannello.
  useEffect(() => {
    const onChange = () => { void carica(); };
    window.addEventListener('topics:auth-pair-resolved', onChange);
    window.addEventListener('topics:auth-device-revoked', onChange);
    return () => {
      window.removeEventListener('topics:auth-pair-resolved', onChange);
      window.removeEventListener('topics:auth-device-revoked', onChange);
    };
  }, [carica]);

  const salvaNome = async () => {
    if (!rinomina) return;
    const nome = rinomina.valore.trim();
    if (!nome) { setRinomina(null); return; }
    setInCorso(rinomina.id);
    try {
      await fetch(`/api/auth/devices/${encodeURIComponent(rinomina.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name: nome }),
      });
      await carica();
    } finally {
      setInCorso(null);
      setRinomina(null);
    }
  };

  /**
   * Sposta un dispositivo su un'altra persona.
   *
   * È la correzione dell'euristica con cui la migration 084 ha attribuito i
   * dispositivi esistenti: al momento dell'appaiamento nessuno chiedeva di chi
   * fossero, quindi il telefono di un collega approvato una volta è finito
   * sulla stessa persona dei tuoi. Senza questo gesto quell'errore sarebbe per
   * sempre — e siccome «di chi è» decide se uno vede tutto, non è un dettaglio
   * anagrafico.
   *
   * NON tocca le concessioni: quelle puntano a una persona, e spostare il ferro
   * non vuol dire spostare ciò che le è stato condiviso.
   */
  const spostaSu = async (id: string, personId: string | null) => {
    setInCorso(id);
    try {
      const r = await fetch(`/api/auth/devices/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ personId }),
      });
      if (!r.ok) setErrore(((await r.json()) as { error?: string }).error ?? 'Non riuscito.');
      await carica();
    } finally {
      setInCorso(null);
      setSposta(null);
    }
  };

  const revoca = async (id: string) => {
    setInCorso(id);
    try {
      await fetch(`/api/auth/devices/${encodeURIComponent(id)}`, {
        method: 'DELETE', credentials: 'same-origin',
      });
      await carica();
    } finally {
      setInCorso(null);
      setConferma(null);
    }
  };

  const attivi = (devices ?? []).filter((d) => d.revokedAt === null);
  const revocati = (devices ?? []).filter((d) => d.revokedAt !== null);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[13px] font-semibold text-app-text">Dispositivi autorizzati</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-app-text-secondary">
          Ogni dispositivo diverso da questo computer deve essere autorizzato una volta.
          Il pallino verde segna chi è connesso adesso.
        </p>
      </div>

      {errore && (
        <div className="flex items-center gap-2 rounded-lg border border-app-border bg-app-hover/30 px-3 py-2">
          <p className="flex-1 text-[12px] text-app-text-secondary">{errore}</p>
          <button
            onClick={() => { setErrore(null); void carica(); }}
            className="rounded-md border border-app-border px-2 py-1 text-[11px] text-app-text hover:bg-app-hover"
          >
            Riprova
          </button>
        </div>
      )}

      {devices === null && <p className="text-[12px] text-app-text-muted">Carico…</p>}

      {devices !== null && attivi.length === 0 && !errore && (
        <p className="rounded-lg border border-app-border bg-app-hover/30 px-3 py-2.5 text-[12px] text-app-text-secondary">
          Nessun altro dispositivo autorizzato. Apri Topics dal telefono sulla stessa rete
          e comparirà qui una richiesta da approvare.
        </p>
      )}

      <ul className="space-y-1.5" data-testid="devices-active">
        {computer && (
          // Il computer È un dispositivo, e chiedere «i miei dispositivi» per
          // vedere solo gli altri è una lista che mente per omissione. Non è
          // revocabile: revocare la macchina da cui gira il server non vuol dire
          // niente, e offrire il gesto inviterebbe a un errore senza rimedio.
          <li className="flex items-center gap-2.5 rounded-lg border border-app-border bg-app-hover/30 px-3 py-2">
            <Monitor size={14} className="flex-shrink-0 text-app-text-secondary" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[12.5px] text-app-text">{computer.name}</span>
                {computer.current && (
                  <span className="flex-shrink-0 rounded bg-primary/10 px-1.5 py-px text-[10px] text-primary">
                    stai qui
                  </span>
                )}
              </div>
              <div className="text-[11px] text-app-text-muted">
                l’accesso non passa da una sessione
              </div>
            </div>
          </li>
        )}
        {attivi.map((d) => (
            <li key={d.id} className="flex items-center gap-2.5 rounded-lg border border-app-border px-3 py-2">
              <span className="relative flex-shrink-0">
                <Smartphone size={14} className="text-app-text-secondary" />
                {d.connected && (
                  <span
                    className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-green-500"
                    aria-label="connesso adesso"
                  />
                )}
              </span>
              <div className="min-w-0 flex-1">
                {rinomina?.id === d.id ? (
                  <input
                    autoFocus
                    value={rinomina.valore}
                    maxLength={60}
                    onChange={(e) => setRinomina({ id: d.id, valore: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void salvaNome();
                      if (e.key === 'Escape') setRinomina(null);
                    }}
                    onBlur={() => void salvaNome()}
                    aria-label={`Nuovo nome per ${d.name}`}
                    className="w-full rounded border border-app-border bg-app-bg px-1.5 py-0.5 text-[12.5px] text-app-text outline-none focus:border-primary"
                  />
                ) : (
                  <button
                    onClick={() => setRinomina({ id: d.id, valore: d.name })}
                    className="group flex max-w-full items-center gap-1 text-left"
                    title="Rinomina"
                  >
                    <span className="truncate text-[12.5px] text-app-text">{d.name}</span>
                    {d.current && (
                      <span className="flex-shrink-0 rounded bg-primary/10 px-1.5 py-px text-[10px] text-primary">
                        stai qui
                      </span>
                    )}
                    {/* Solo l'ospite si marca. Un'etichetta su ogni riga
                        peserebbe come rumore, e «proprietario» è il caso
                        normale: quello da vedere a colpo d'occhio è l'altro. */}
                    {d.role === 'guest' && (
                      <span
                        className="flex-shrink-0 rounded bg-app-hover px-1.5 py-px text-[10px] text-app-text-secondary"
                        title="Vede solo ciò che gli è stato condiviso, in sola lettura"
                        data-testid="device-role-guest"
                      >
                        ospite
                      </span>
                    )}
                    <Pencil size={10} className="flex-shrink-0 text-app-text-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                )}
                <div className="text-[11px] text-app-text-muted">
                  {d.connected ? 'connesso adesso' : `visto ${quando(d.lastSeenAt)}`}
                  {d.firstIp && ` · da ${d.firstIp.replace(/^::ffff:/, '')}`}
                  {/* DI CHI è. Si mostra solo se ci sono davvero più persone:
                      a un utente solo, «di Proprietario» su ogni riga è rumore
                      che non distingue niente. */}
                  {persone.length > 1 && d.person && ` · di ${d.person.name}`}
                </div>

                {/* Spostare il dispositivo su un'altra persona: la correzione
                    dell'euristica con cui la 084 li ha attribuiti. Compare solo
                    dove c'è una scelta da fare. */}
                {persone.length > 1 && (
                  sposta === d.id ? (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <span className="text-[11px] text-app-text-secondary">Di chi è?</span>
                      {persone.map((p) => (
                        <button
                          key={p.id}
                          disabled={inCorso === d.id}
                          onClick={() => void spostaSu(d.id, p.id)}
                          className={`rounded border px-1.5 py-0.5 text-[11px] disabled:opacity-50 ${
                            d.person?.id === p.id
                              ? 'border-primary/40 bg-primary/10 text-primary'
                              : 'border-app-border text-app-text hover:bg-app-hover'
                          }`}
                        >
                          {p.name}{p.owner ? ' (tu)' : ''}
                        </button>
                      ))}
                      <button
                        onClick={() => setSposta(null)}
                        className="rounded px-1.5 py-0.5 text-[11px] text-app-text-tertiary hover:bg-app-hover"
                      >
                        annulla
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setSposta(d.id)}
                      data-testid="device-move-person"
                      className="mt-0.5 text-[11px] text-app-text-tertiary underline decoration-dotted underline-offset-2 hover:text-app-text"
                    >
                      è di un'altra persona
                    </button>
                  )
                )}
              </div>

              {conferma === d.id ? (
                <div className="flex flex-shrink-0 items-center gap-1">
                  <span className="mr-1 text-[11px] text-app-text-secondary">Revocare?</span>
                  <button
                    aria-label="Conferma revoca"
                    disabled={inCorso === d.id}
                    onClick={() => void revoca(d.id)}
                    className="rounded p-1 text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                  >
                    <Check size={13} />
                  </button>
                  <button
                    aria-label="Annulla"
                    onClick={() => setConferma(null)}
                    className="rounded p-1 text-app-text-tertiary hover:bg-app-hover"
                  >
                    <XIcon size={13} />
                  </button>
                </div>
              ) : (
                <button
                  aria-label={`Revoca ${d.name}`}
                  onClick={() => setConferma(d.id)}
                  className="flex-shrink-0 rounded p-1 text-app-text-tertiary hover:bg-app-hover hover:text-red-500"
                  title="Revoca l'accesso a questo dispositivo"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </li>
          ))}
      </ul>

      {revocati.length > 0 && (
        <div>
          <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-app-text-muted">
            Revocati
          </h4>
          <ul className="space-y-1" data-testid="devices-revoked">
            {revocati.map((d) => (
              <li key={d.id} className="flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-app-text-muted">
                <Smartphone size={12} className="flex-shrink-0 opacity-50" />
                <span className="truncate line-through">{d.name}</span>
                <span className="ml-auto flex-shrink-0 text-[11px]">revocato {quando(d.revokedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
