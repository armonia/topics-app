import { useCallback, useEffect, useState } from 'react';
import { User, Pencil, Plus, X, Trash2, Lock } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { chiaveErroreAuth } from '../../lib/authErrors';
import { useConfirm } from '../../hooks/useConfirm';
import { membriDaRisposta, splitMembri, type Membro, type Ruolo } from './membri';
import { Select } from '../Shared/Select';

/**
 * Chi sei, e con chi condividi. UN elenco solo.
 *
 * ── PERCHÉ NON DUE SEZIONI ──────────────────────────────────────────────────
 * Prima c'erano una scheda «Tu» e sotto l'elenco dei membri — e comparivi in
 * tutte e due. Due posti in cui modificare lo stesso nome sono due posti in cui
 * chiedersi quale sia quello vero. Qui c'è una riga per persona, la tua è la
 * prima, e si modificano tutte allo stesso modo.
 *
 * ── I GRUPPI SONO PIÙ DI UNO ────────────────────────────────────────────────
 * Questa schermata assumeva che ce ne fosse UNO — l'unico che la migration 084
 * crea — e con quell'assunzione dentro non c'era modo di crearne un secondo né
 * di cancellarne uno. Adesso l'elenco viene da `GET /api/auth/orgs`, e la
 * riga di intestazione diventa un selettore appena i gruppi sono due: sotto
 * i due, mostrare delle schede sarebbe un meccanismo esibito per una scelta
 * che non c'è.
 *
 * Il gruppo di QUESTA installazione è marcato e non si cancella: è quello a cui
 * risponde `/api/auth/me`, ed è l'ancora dell'identità della macchina. Senza
 * quel divieto l'installazione può restare senza gruppo, e «qual è il mio»
 * diventa «uno qualunque, forse».
 *
 * ── IL NOME DEL GRUPPO SI VEDE SEMPRE, LA PAROLA NO ─────────────────────────
 * ORG-07 dice di non usare la parola «organizzazione» con chi ne ha una di un
 * membro solo, ed è giusto: è un concetto che non serve a chi è da solo. Ma
 * nasconderla del tutto — com'era — vuol dire che il gruppo non si vede e non
 * si può rinominare, e chi lo cerca conclude che non esiste. Quindi il NOME fa
 * da intestazione all'elenco fin dal primo giorno; la PAROLA compare solo
 * quando c'è davvero più di una persona.
 *
 * ── IL RUOLO SI VEDE SOLO QUANDO DECIDE QUALCOSA ────────────────────────────
 * `org_members.role` governa una cosa sola: chi può invitare, togliere e
 * promuovere DENTRO un gruppo. Non è il ruolo d'accesso a questa macchina —
 * quello lo decide `installation_owners` e nient'altro. Quindi il selettore
 * compare solo dove quella distinzione esiste davvero, cioè da due membri in
 * su, e chi non amministra lo legge invece di poterlo cambiare: offrire un
 * gesto che il server rifiuterà è peggio che non offrirlo.
 *
 * ── PERCHÉ LE PERSONE NON SI CREANO DA QUI ──────────────────────────────────
 * La persona proprietaria la fa la migration `084`, una volta. Non è comodità:
 * «proprietario dell'installazione» è una proprietà locale che nessuna
 * sincronizzazione può scrivere, e un bottone «crea una persona proprietaria»
 * aprirebbe una seconda strada per diventare padroni di questa macchina —
 * quella che un giorno arriverebbe da un servizio centrale, e che non
 * controlleresti tu.
 *
 * ── L'EMAIL NON È UN LOGIN ──────────────────────────────────────────────────
 * È un'etichetta, e serve a due cose vere: farsi riconoscere in un elenco, e —
 * quando ci sarà un servizio di account — essere l'indirizzo a cui un invito
 * arriva. Oggi non autentica niente: a far entrare qualcuno resta
 * l'autorizzazione del suo dispositivo. La schermata lo dice invece di lasciarlo
 * credere.
 */
interface Io {
  person: { id: string; name: string; email: string | null } | null;
  org: { id: string; name: string; members: number } | null;
}

interface Gruppo {
  id: string;
  name: string;
  members: number;
  /** Il ruolo di CHI GUARDA, non un ruolo assoluto. `null` = non ne fa parte. */
  role: Ruolo | null;
  /** Il gruppo di questa installazione: si rinomina, non si cancella. */
  installation: boolean;
}

/** Cosa si sta modificando: una persona (per id) o il nome del gruppo. */
type InModifica = { tipo: 'persona'; id: string } | { tipo: 'gruppo' } | null;

const RUOLI: Ruolo[] = ['owner', 'admin', 'member'];

/** `t()` passato come dato: è ciò che rende `TolliQueue` una funzione di props. */
type Traduci = (key: string, vars?: Record<string, string | number>) => string;

/**
 * La coda dei TOLTI, e il gesto che li cancella davvero.
 *
 * Coda separata e in sordina, come i «Revocati» dei dispositivi: sono usciti dal
 * gruppo, non dalla schermata. Esiste perché senza di lei `people.revoked_at`
 * resta una colonna letta in cinque punti e scrivibile da nessuno.
 *
 * Niente hook e niente accesso al documento — `t` arriva come prop — così la si
 * chiama e si guarda l'albero che restituisce, senza un renderer DOM che il
 * progetto non ha.
 */
export function TolliQueue({ tolti, onDelete, inCorso, rifiuto, t }: {
  tolti: Membro[];
  onDelete: (m: Membro) => void;
  inCorso: boolean;
  /** La chiave della frase se l'ultima cancellazione è stata rifiutata. */
  rifiuto: string | null;
  t: Traduci;
}) {
  if (tolti.length === 0) return null;
  return (
    <div>
      <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-app-text-muted">
        {t('identity.removedHeading')}
      </h4>
      <ul className="space-y-1" data-testid="identity-removed">
        {tolti.map((m) => (
          <li key={m.id} className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-app-text-muted">
            <User size={12} className="flex-shrink-0 opacity-50" />
            <span className="min-w-0 flex-1 truncate line-through">{m.name}</span>
            <button
              disabled={inCorso}
              onClick={() => onDelete(m)}
              title={t('identity.deletePerson', { nome: m.name })}
              aria-label={t('identity.deletePerson', { nome: m.name })}
              className="flex-shrink-0 rounded p-0.5 text-app-text-tertiary hover:bg-app-hover hover:text-red-500 disabled:opacity-50"
            >
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ul>
      {/* Il rifiuto DICE cosa fare prima: «ha ancora un dispositivo» è una
          condizione da sciogliere, non un divieto. */}
      {rifiuto && (
        <p className="mt-1 px-3 text-[11px] leading-snug text-app-text-secondary">{t(rifiuto)}</p>
      )}
    </div>
  );
}

export function IdentitySection() {
  const t = useT();
  const conferma = useConfirm();
  const [io, setIo] = useState<Io | null>(null);
  const [gruppi, setGruppi] = useState<Gruppo[]>([]);
  const [scelto, setScelto] = useState<string | null>(null);
  const [membri, setMembri] = useState<Membro[]>([]);
  const [modifica, setModifica] = useState<InModifica>(null);
  const [bozzaNome, setBozzaNome] = useState('');
  const [bozzaEmail, setBozzaEmail] = useState('');
  const [nuovo, setNuovo] = useState<{ nome: string; email: string } | null>(null);
  /** Perché l'ultimo tentativo non è passato. `null` = nessun tentativo fallito. */
  const [rifiuto, setRifiuto] = useState<'noSeats' | 'generico' | null>(null);
  const [nuovoGruppo, setNuovoGruppo] = useState<string | null>(null);
  const [inCorso, setInCorso] = useState(false);
  /** La chiave della frase se l'ultima cancellazione è stata rifiutata. */
  const [rifiutoCancella, setRifiutoCancella] = useState<string | null>(null);

  const carica = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      setIo(r.ok ? (await r.json()) as Io : { person: null, org: null });
    } catch {
      setIo({ person: null, org: null });
    }
  }, []);

  const caricaGruppi = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/orgs', { credentials: 'same-origin' });
      const b = r.ok ? (await r.json()) as { orgs?: Gruppo[] } : null;
      setGruppi(b?.orgs ?? []);
      return b?.orgs ?? [];
    } catch { setGruppi([]); return []; }
  }, []);

  const caricaMembri = useCallback(async (orgId: string) => {
    try {
      const r = await fetch(`/api/auth/orgs/${encodeURIComponent(orgId)}/members`, { credentials: 'same-origin' });
      const b = r.ok ? (await r.json()) as { members?: Membro[] } : null;
      // I TOLTI restano nell'array: si separano sotto, con `splitMembri`.
      setMembri(membriDaRisposta(b));
    } catch { setMembri([]); }
  }, []);

  useEffect(() => { void carica(); void caricaGruppi(); }, [carica, caricaGruppi]);

  // La selezione parte dal gruppo dell'INSTALLAZIONE — quello che
  // `/api/auth/me` dichiara — e si sposta solo se quello scelto sparisce
  // (cancellato qui, o revocato da una sincronizzazione).
  useEffect(() => {
    setScelto((corrente) => {
      if (corrente && gruppi.some((g) => g.id === corrente)) return corrente;
      return io?.org?.id ?? gruppi.find((g) => g.installation)?.id ?? gruppi[0]?.id ?? null;
    });
  }, [gruppi, io?.org?.id]);

  useEffect(() => { if (scelto) void caricaMembri(scelto); else setMembri([]); }, [scelto, caricaMembri]);

  const ricarica = async (orgId?: string | null) => {
    await carica();
    await caricaGruppi();
    const id = orgId ?? scelto;
    if (id) await caricaMembri(id);
  };

  const gruppo = gruppi.find((g) => g.id === scelto) ?? null;
  // Chi non amministra LEGGE: il server rifiuta con 403, e offrire un bottone
  // che porta a un rifiuto è un'interfaccia che mente.
  const amministra = gruppo?.role === 'owner' || gruppo?.role === 'admin';

  const salva = async () => {
    if (!modifica) return;
    const nome = bozzaNome.trim();
    if (!nome) { setModifica(null); return; }
    setInCorso(true);
    try {
      const rotta = modifica.tipo === 'gruppo'
        ? `/api/auth/orgs/${encodeURIComponent(scelto ?? '')}`
        : `/api/auth/people/${encodeURIComponent(modifica.id)}`;
      await fetch(rotta, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        // Stringa vuota = togli l'email. È diverso da «non l'ho toccata», e il
        // server distingue le due cose.
        body: JSON.stringify(
          modifica.tipo === 'gruppo' ? { name: nome } : { name: nome, email: bozzaEmail.trim() || null },
        ),
      });
      await ricarica();
    } finally {
      setInCorso(false);
      setModifica(null);
    }
  };

  const aggiungi = async () => {
    const nome = (nuovo?.nome ?? '').trim();
    if (!scelto || !nome) { setNuovo(null); return; }
    setInCorso(true);
    setRifiuto(null);
    try {
      const r = await fetch(`/api/auth/orgs/${encodeURIComponent(scelto)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name: nome, email: (nuovo?.email ?? '').trim() || null }),
      });
      // La risposta si LEGGE. Prima non si guardava: il tetto dei posti
      // rispondeva 403, il modulo si chiudeva, e non compariva niente — un
      // fallimento muto, che è il peggiore perché somiglia a un guasto invece
      // che a un limite.
      if (!r.ok) {
        const corpo = await r.json().catch(() => null) as { error?: string } | null;
        setRifiuto(corpo?.error === 'no_seats_left' ? 'noSeats' : 'generico');
        return; // il modulo resta aperto: il nome digitato non si butta via
      }
      await ricarica();
      setNuovo(null);
    } finally { setInCorso(false); }
  };

  const togli = async (m: Membro) => {
    if (!scelto) return;
    await fetch(`/api/auth/orgs/${encodeURIComponent(scelto)}/members?personId=${encodeURIComponent(m.id)}`, {
      method: 'DELETE', credentials: 'same-origin',
    });
    await ricarica();
  };

  /**
   * Cancellare una persona dalla RUBRICA, che non è toglierla dal gruppo.
   *
   * Sono due gesti e restano due: togliere è reversibile — la si rimette
   * dentro — cancellare no. Prima questo secondo gesto non esisteva affatto, e
   * `people.revoked_at` era una colonna letta in otto punti che nessuna
   * schermata poteva scrivere: una persona invitata per sbaglio restava lì per
   * sempre.
   */
  const cancellaPersona = async (m: Membro) => {
    if (!await conferma({
      title: t('identity.deletePerson', { nome: m.name }),
      body: t('identity.deletePersonConfirm', { nome: m.name }),
      confirmLabel: t('identity.deletePerson', { nome: m.name }),
    })) return;
    setInCorso(true);
    try {
      const r = await fetch(`/api/auth/people/${encodeURIComponent(m.id)}`, {
        method: 'DELETE', credentials: 'same-origin',
      });
      // Il server manda un CODICE: la frase la sceglie qui l'interfaccia.
      if (!r.ok) {
        const corpo = await r.json().catch(() => null) as { error?: string } | null;
        setRifiutoCancella(chiaveErroreAuth(corpo?.error));
        return;
      }
      setRifiutoCancella(null);
      await ricarica();
    } finally { setInCorso(false); }
  };

  const cambiaRuolo = async (m: Membro, ruolo: Ruolo) => {
    if (!scelto || ruolo === m.role) return;
    setInCorso(true);
    try {
      await fetch(`/api/auth/orgs/${encodeURIComponent(scelto)}/members`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ personId: m.id, role: ruolo }),
      });
      await ricarica();
    } finally { setInCorso(false); }
  };

  const creaGruppo = async () => {
    const nome = (nuovoGruppo ?? '').trim();
    if (!nome) { setNuovoGruppo(null); return; }
    setInCorso(true);
    try {
      const r = await fetch('/api/auth/orgs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name: nome }),
      });
      const b = r.ok ? (await r.json()) as { id?: string } : null;
      if (b?.id) setScelto(b.id);
      await ricarica(b?.id ?? null);
    } finally { setInCorso(false); setNuovoGruppo(null); }
  };

  const cancellaGruppo = async (g: Gruppo) => {
    // Cancellare un gruppo toglie in un colpo ciò che gli era stato condiviso a
    // tutti i suoi membri: è la conseguenza che va detta PRIMA, non scoperta
    // dopo da chi non vede più niente.
    if (!await conferma({
      title: t('identity.deleteGroup', { nome: g.name }),
      body: t('identity.deleteGroupConfirm', { nome: g.name }),
      confirmLabel: t('identity.deleteGroup', { nome: g.name }),
    })) return;
    setInCorso(true);
    try {
      await fetch(`/api/auth/orgs/${encodeURIComponent(g.id)}`, { method: 'DELETE', credentials: 'same-origin' });
      setScelto(null);
      await ricarica(null);
    } finally { setInCorso(false); }
  };

  // Niente persone = schema più vecchio della 084. Si tace invece di mostrare
  // una sezione vuota che sembra rotta.
  if (!io?.person) return null;

  // I due elenchi. `tolti` esiste per un gesto solo: cancellare davvero.
  const { presenti, tolti } = splitMembri(membri);
  const soloTu = presenti.length <= 1;
  const campo = 'w-full rounded border border-app-border bg-app-bg px-2 py-1 text-[12.5px] text-app-text outline-none focus:border-primary';

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-[13px] font-semibold text-app-text">{t('identity.title')}</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-app-text-secondary">
          {/* A chi è solo non si spiega un concetto che non gli serve ancora:
              gli si dice a cosa servirà, in una riga. */}
          {soloTu ? t('identity.blurb.solo') : t('identity.blurb.group')}
        </p>
      </div>

      {/* Le schede dei gruppi compaiono solo quando la scelta esiste davvero. */}
      {gruppi.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {gruppi.map((g) => (
            <button
              key={g.id}
              onClick={() => setScelto(g.id)}
              className={`max-w-[14rem] truncate rounded border px-2 py-1 text-[11.5px] ${
                g.id === scelto
                  ? 'border-primary bg-app-hover text-app-text'
                  : 'border-app-border text-app-text-secondary hover:bg-app-hover'
              }`}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-app-border" data-testid="identity-orgs">
        {/* Il nome del gruppo: sempre visibile, rinominabile da chi amministra. */}
        {gruppo && (
          <div className="border-b border-app-border bg-app-hover/40 px-3 py-1.5">
            {modifica?.tipo === 'gruppo' ? (
              <div className="flex gap-1.5">
                <input
                  autoFocus
                  value={bozzaNome}
                  onChange={(e) => setBozzaNome(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void salva(); if (e.key === 'Escape') setModifica(null); }}
                  aria-label={t('identity.groupNameLabel')}
                  className={campo}
                />
                <button
                  disabled={inCorso}
                  onClick={() => void salva()}
                  className="flex-shrink-0 rounded border border-app-border px-2 py-1 text-[11px] text-app-text hover:bg-app-hover disabled:opacity-50"
                >
                  {t('identity.save')}
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { if (!amministra) return; setBozzaNome(gruppo.name); setModifica({ tipo: 'gruppo' }); }}
                  disabled={!amministra}
                  className="group flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default coarse:min-h-11"
                  title={amministra ? t('identity.renameGroup') : t('identity.notAdmin')}
                >
                  <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-app-text-secondary">
                    {gruppo.name}
                  </span>
                  {amministra && (
                    <Pencil size={10} className="flex-shrink-0 text-app-text-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
                  )}
                </button>
                {gruppo.installation ? (
                  <Lock size={10} className="flex-shrink-0 text-app-text-tertiary" aria-label={t('identity.installationGroup')} />
                ) : amministra ? (
                  <button
                    onClick={() => void cancellaGruppo(gruppo)}
                    disabled={inCorso}
                    title={t('identity.deleteGroup', { nome: gruppo.name })}
                    aria-label={t('identity.deleteGroup', { nome: gruppo.name })}
                    className="flex-shrink-0 rounded p-0.5 text-app-text-tertiary hover:bg-app-hover hover:text-app-text disabled:opacity-50"
                  >
                    <Trash2 size={11} />
                  </button>
                ) : null}
              </div>
            )}
          </div>
        )}

        {presenti.map((m) => (
          <div key={m.id} className="group border-b border-app-border px-3 py-2 last:border-b-0">
            {modifica?.tipo === 'persona' && modifica.id === m.id ? (
              <div className="space-y-1.5">
                <input
                  autoFocus
                  value={bozzaNome}
                  onChange={(e) => setBozzaNome(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void salva(); if (e.key === 'Escape') setModifica(null); }}
                  aria-label={t('identity.nameLabel')}
                  placeholder={t('identity.nameLabel')}
                  className={campo}
                />
                <input
                  value={bozzaEmail}
                  onChange={(e) => setBozzaEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void salva(); if (e.key === 'Escape') setModifica(null); }}
                  aria-label={t('identity.emailLabel')}
                  placeholder={t('identity.emailPlaceholder')}
                  className={campo}
                />
                <div className="flex gap-1.5">
                  <button
                    disabled={inCorso}
                    onClick={() => void salva()}
                    className="rounded border border-app-border px-2 py-0.5 text-[11px] text-app-text hover:bg-app-hover disabled:opacity-50"
                  >
                    {t('identity.save')}
                  </button>
                  <button
                    onClick={() => setModifica(null)}
                    className="rounded px-2 py-0.5 text-[11px] text-app-text-tertiary hover:bg-app-hover"
                  >
                    {t('identity.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <User size={13} className="flex-shrink-0 text-app-text-tertiary" />
                <button
                  onClick={() => {
                    setBozzaNome(m.name);
                    setBozzaEmail(m.email ?? '');
                    setModifica({ tipo: 'persona', id: m.id });
                  }}
                  className="min-w-0 flex-1 text-left coarse:min-h-11"
                  title={t('identity.editPerson')}
                >
                  <span className="block truncate text-[12.5px] text-app-text">{m.name}</span>
                  {m.email && <span className="block truncate text-[11px] text-app-text-muted">{m.email}</span>}
                </button>
                {/* Il ruolo dice qualcosa solo da due membri in su: in un gruppo
                    di uno «proprietario» è rumore. */}
                {!soloTu && (amministra ? (
                  <Select<Ruolo>
                    value={m.role}
                    disabled={inCorso}
                    align="right"
                    onChange={(r) => void cambiaRuolo(m, r)}
                    ariaLabel={t('identity.roleOf', { nome: m.name })}
                    className="flex-shrink-0"
                    options={RUOLI.map((r) => ({ value: r, label: t(`identity.role.${r}`) }))}
                  />
                ) : (
                  <span className="flex-shrink-0 text-[11px] text-app-text-muted">{t(`identity.role.${m.role}`)}</span>
                ))}
                <span className="flex-shrink-0 text-[11px] text-app-text-muted">
                  {/* Zero dispositivi non è un errore: è il caso normale di chi
                      è stato aggiunto e non si è ancora collegato. Detto qui,
                      perché un contatore a zero senza spiegazione sembra un
                      guasto. */}
                  {m.owner
                    ? t('identity.you')
                    : m.devices === 0
                      ? t('identity.notConnectedYet')
                      : t(m.devices === 1 ? 'identity.devices.one' : 'identity.devices.many', { n: m.devices })}
                </span>
                {!m.owner && amministra && (
                  <button
                    onClick={() => void togli(m)}
                    title={t('identity.removePerson', { nome: m.name })}
                    aria-label={t('identity.removePerson', { nome: m.name })}
                    className="flex-shrink-0 rounded p-0.5 text-app-text-tertiary opacity-0 transition-opacity hover:bg-app-hover hover:text-app-text group-hover:opacity-100"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            )}
          </div>
        ))}

        {!amministra ? (
          <div className="border-t border-app-border px-3 py-2 text-[11px] text-app-text-muted">
            {t('identity.notAdmin')}
          </div>
        ) : nuovo === null ? (
          <button
            onClick={() => { setNuovo({ nome: '', email: '' }); setRifiuto(null); }}
            className="flex w-full items-center gap-2 border-t border-app-border px-3 py-2 text-left text-[12.5px] text-app-text-secondary hover:bg-app-hover coarse:min-h-11"
          >
            <Plus size={13} className="flex-shrink-0 text-app-text-tertiary" />
            {t('identity.addPerson')}
          </button>
        ) : (
          <div className="space-y-1.5 border-t border-app-border px-3 py-2">
            <input
              autoFocus
              value={nuovo.nome}
              onChange={(e) => setNuovo({ ...nuovo, nome: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') void aggiungi(); if (e.key === 'Escape') setNuovo(null); }}
              aria-label={t('identity.personName')}
              placeholder={t('identity.nameLabel')}
              className={campo}
            />
            <input
              value={nuovo.email}
              onChange={(e) => setNuovo({ ...nuovo, email: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') void aggiungi(); if (e.key === 'Escape') setNuovo(null); }}
              aria-label={t('identity.personEmail')}
              placeholder={t('identity.emailPlaceholder')}
              className={campo}
            />
            <div className="flex gap-1.5">
              <button
                disabled={inCorso}
                onClick={() => void aggiungi()}
                className="rounded border border-app-border px-2 py-0.5 text-[11px] text-app-text hover:bg-app-hover disabled:opacity-50"
              >
                {t('identity.add')}
              </button>
              <button
                onClick={() => { setNuovo(null); setRifiuto(null); }}
                className="rounded px-2 py-0.5 text-[11px] text-app-text-tertiary hover:bg-app-hover"
              >
                {t('identity.cancel')}
              </button>
            </div>
            {/* Il motivo sta ATTACCATO al modulo, non altrove: chi ha appena
                premuto guarda qui, e un avviso in fondo alla pagina non lo
                vedrebbe. Il nome digitato resta, così riprovare non vuol dire
                riscrivere. */}
            {rifiuto && (
              <p className="text-[11px] leading-snug text-app-text-secondary">
                {t(rifiuto === 'noSeats' ? 'identity.noSeats' : 'identity.addFailed')}
              </p>
            )}
          </div>
        )}
      </div>

      {/* I TOLTI: solo chi amministra li vede, perché solo lui può cancellarli. */}
      {amministra && (
        <TolliQueue
          tolti={tolti}
          onDelete={(m) => void cancellaPersona(m)}
          inCorso={inCorso}
          rifiuto={rifiutoCancella}
          t={t}
        />
      )}

      {nuovoGruppo === null ? (
        <button
          onClick={() => setNuovoGruppo('')}
          className="flex items-center gap-1.5 text-[11.5px] text-app-text-secondary hover:text-app-text coarse:min-h-11"
        >
          <Plus size={12} className="flex-shrink-0 text-app-text-tertiary" />
          {t('identity.newGroup')}
        </button>
      ) : (
        <div className="flex gap-1.5">
          <input
            autoFocus
            value={nuovoGruppo}
            onChange={(e) => setNuovoGruppo(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void creaGruppo(); if (e.key === 'Escape') setNuovoGruppo(null); }}
            aria-label={t('identity.newGroupNameLabel')}
            placeholder={t('identity.newGroupNameLabel')}
            className={campo}
          />
          <button
            disabled={inCorso}
            onClick={() => void creaGruppo()}
            className="flex-shrink-0 rounded border border-app-border px-2 py-1 text-[11px] text-app-text hover:bg-app-hover disabled:opacity-50"
          >
            {t('identity.create')}
          </button>
          <button
            onClick={() => setNuovoGruppo(null)}
            className="flex-shrink-0 rounded px-2 py-1 text-[11px] text-app-text-tertiary hover:bg-app-hover"
          >
            {t('identity.cancel')}
          </button>
        </div>
      )}

      <p className="text-[10px] leading-snug text-app-text-muted">
        {t('identity.footnote')}
      </p>
    </div>
  );
}
