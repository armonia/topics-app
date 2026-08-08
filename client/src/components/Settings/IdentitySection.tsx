import { useCallback, useEffect, useState } from 'react';
import { User, Pencil, Plus, X } from 'lucide-react';

/**
 * Chi sei, e con chi condividi. UN elenco solo.
 *
 * ── PERCHÉ NON DUE SEZIONI ──────────────────────────────────────────────────
 * Prima c'erano una scheda «Tu» e sotto l'elenco dei membri — e comparivi in
 * tutte e due. Due posti in cui modificare lo stesso nome sono due posti in cui
 * chiedersi quale sia quello vero. Qui c'è una riga per persona, la tua è la
 * prima, e si modificano tutte allo stesso modo.
 *
 * ── IL NOME DEL GRUPPO SI VEDE SEMPRE, LA PAROLA NO ─────────────────────────
 * ORG-07 dice di non usare la parola «organizzazione» con chi ne ha una di un
 * membro solo, ed è giusto: è un concetto che non serve a chi è da solo. Ma
 * nasconderla del tutto — com'era — vuol dire che il gruppo non si vede e non
 * si può rinominare, e chi lo cerca conclude che non esiste. Quindi il NOME fa
 * da intestazione all'elenco fin dal primo giorno; la PAROLA compare solo
 * quando c'è davvero più di una persona.
 *
 * ── PERCHÉ NON SI CREANO DA QUI ─────────────────────────────────────────────
 * La persona proprietaria e il gruppo li ha fatti la migration `084`, una volta.
 * Non è comodità: «proprietario dell'installazione» è una proprietà locale che
 * nessuna sincronizzazione può scrivere, e un bottone «crea una persona
 * proprietaria» aprirebbe una seconda strada per diventare padroni di questa
 * macchina — quella che un giorno arriverebbe da un servizio centrale, e che non
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

interface Membro {
  id: string;
  name: string;
  email: string | null;
  devices: number;
  owner: boolean;
  blocked: boolean;
}

/** Cosa si sta modificando: una persona (per id) o il nome del gruppo. */
type InModifica = { tipo: 'persona'; id: string } | { tipo: 'gruppo' } | null;

export function IdentitySection() {
  const [io, setIo] = useState<Io | null>(null);
  const [membri, setMembri] = useState<Membro[]>([]);
  const [modifica, setModifica] = useState<InModifica>(null);
  const [bozzaNome, setBozzaNome] = useState('');
  const [bozzaEmail, setBozzaEmail] = useState('');
  const [nuovo, setNuovo] = useState<{ nome: string; email: string } | null>(null);
  const [inCorso, setInCorso] = useState(false);

  const carica = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
      setIo(r.ok ? (await r.json()) as Io : { person: null, org: null });
    } catch {
      setIo({ person: null, org: null });
    }
  }, []);

  const caricaMembri = useCallback(async (orgId: string) => {
    try {
      const r = await fetch(`/api/auth/orgs/${encodeURIComponent(orgId)}/members`, { credentials: 'same-origin' });
      const b = r.ok ? (await r.json()) as { members?: Membro[] } : null;
      // Chi è stato tolto resta nel database — serve perché il blocco locale
      // sopravviva a una sincronizzazione — ma non ha motivo di stare in un
      // elenco di chi c'è.
      setMembri((b?.members ?? []).filter((m) => !m.blocked));
    } catch { setMembri([]); }
  }, []);

  useEffect(() => { void carica(); }, [carica]);
  useEffect(() => { if (io?.org) void caricaMembri(io.org.id); }, [io?.org, caricaMembri]);

  const ricarica = async (orgId?: string) => {
    await carica();
    const id = orgId ?? io?.org?.id;
    if (id) await caricaMembri(id);
  };

  const salva = async () => {
    if (!modifica) return;
    const nome = bozzaNome.trim();
    if (!nome) { setModifica(null); return; }
    const orgId = io?.org?.id;
    setInCorso(true);
    try {
      const rotta = modifica.tipo === 'gruppo'
        ? `/api/auth/orgs/${encodeURIComponent(orgId ?? '')}`
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
      await ricarica(orgId);
    } finally {
      setInCorso(false);
      setModifica(null);
    }
  };

  const aggiungi = async () => {
    const nome = (nuovo?.nome ?? '').trim();
    const orgId = io?.org?.id;
    if (!orgId || !nome) { setNuovo(null); return; }
    setInCorso(true);
    try {
      await fetch(`/api/auth/orgs/${encodeURIComponent(orgId)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name: nome, email: (nuovo?.email ?? '').trim() || null }),
      });
      await ricarica(orgId);
    } finally { setInCorso(false); setNuovo(null); }
  };

  const togli = async (m: Membro) => {
    const orgId = io?.org?.id;
    if (!orgId) return;
    await fetch(`/api/auth/orgs/${encodeURIComponent(orgId)}/members?personId=${encodeURIComponent(m.id)}`, {
      method: 'DELETE', credentials: 'same-origin',
    });
    await ricarica(orgId);
  };

  // Niente persone = schema più vecchio della 084. Si tace invece di mostrare
  // una sezione vuota che sembra rotta.
  if (!io?.person) return null;

  const soloTu = membri.length <= 1;
  const campo = 'w-full rounded border border-app-border bg-app-bg px-2 py-1 text-[12.5px] text-app-text outline-none focus:border-primary';

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-[13px] font-semibold text-app-text">Persone</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-app-text-secondary">
          {soloTu
            // A chi è solo non si spiega un concetto che non gli serve ancora:
            // gli si dice a cosa servirà, in una riga.
            ? 'Per adesso ci sei solo tu. Aggiungi qualcuno per poter condividere con lui, anche prima che colleghi un suo dispositivo.'
            : 'Condividere con l’organizzazione vale per tutti i suoi membri, senza rifarlo uno per uno.'}
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-app-border">
        {/* Il nome del gruppo: sempre visibile, sempre rinominabile. */}
        {io.org && (
          <div className="border-b border-app-border bg-app-hover/40 px-3 py-1.5">
            {modifica?.tipo === 'gruppo' ? (
              <div className="flex gap-1.5">
                <input
                  autoFocus
                  value={bozzaNome}
                  onChange={(e) => setBozzaNome(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void salva(); if (e.key === 'Escape') setModifica(null); }}
                  aria-label="Nome del gruppo"
                  className={campo}
                />
                <button
                  disabled={inCorso}
                  onClick={() => void salva()}
                  className="flex-shrink-0 rounded border border-app-border px-2 py-1 text-[11px] text-app-text hover:bg-app-hover disabled:opacity-50"
                >
                  Salva
                </button>
              </div>
            ) : (
              <button
                onClick={() => { setBozzaNome(io.org!.name); setModifica({ tipo: 'gruppo' }); }}
                className="group flex w-full items-center gap-2 text-left"
                title="Cambia nome"
              >
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-app-text-secondary">
                  {io.org.name}
                </span>
                <Pencil size={10} className="flex-shrink-0 text-app-text-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            )}
          </div>
        )}

        {membri.map((m) => (
          <div key={m.id} className="group border-b border-app-border px-3 py-2 last:border-b-0">
            {modifica?.tipo === 'persona' && modifica.id === m.id ? (
              <div className="space-y-1.5">
                <input
                  autoFocus
                  value={bozzaNome}
                  onChange={(e) => setBozzaNome(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void salva(); if (e.key === 'Escape') setModifica(null); }}
                  aria-label="Nome"
                  placeholder="Nome"
                  className={campo}
                />
                <input
                  value={bozzaEmail}
                  onChange={(e) => setBozzaEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void salva(); if (e.key === 'Escape') setModifica(null); }}
                  aria-label="Email"
                  placeholder="Email (facoltativa)"
                  className={campo}
                />
                <div className="flex gap-1.5">
                  <button
                    disabled={inCorso}
                    onClick={() => void salva()}
                    className="rounded border border-app-border px-2 py-0.5 text-[11px] text-app-text hover:bg-app-hover disabled:opacity-50"
                  >
                    Salva
                  </button>
                  <button
                    onClick={() => setModifica(null)}
                    className="rounded px-2 py-0.5 text-[11px] text-app-text-tertiary hover:bg-app-hover"
                  >
                    Annulla
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
                  className="min-w-0 flex-1 text-left"
                  title="Cambia nome o email"
                >
                  <span className="block truncate text-[12.5px] text-app-text">{m.name}</span>
                  {m.email && <span className="block truncate text-[11px] text-app-text-muted">{m.email}</span>}
                </button>
                <span className="flex-shrink-0 text-[11px] text-app-text-muted">
                  {/* Zero dispositivi non è un errore: è il caso normale di chi
                      è stato aggiunto e non si è ancora collegato. Detto qui,
                      perché un contatore a zero senza spiegazione sembra un
                      guasto. */}
                  {m.owner ? 'tu' : m.devices === 0 ? 'da collegare' : `${m.devices} dispositiv${m.devices === 1 ? 'o' : 'i'}`}
                </span>
                {!m.owner && (
                  <button
                    onClick={() => void togli(m)}
                    title={`Togli ${m.name}`}
                    aria-label={`Togli ${m.name}`}
                    className="flex-shrink-0 rounded p-0.5 text-app-text-tertiary opacity-0 transition-opacity hover:bg-app-hover hover:text-app-text group-hover:opacity-100"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            )}
          </div>
        ))}

        {nuovo === null ? (
          <button
            onClick={() => setNuovo({ nome: '', email: '' })}
            className="flex w-full items-center gap-2 border-t border-app-border px-3 py-2 text-left text-[12.5px] text-app-text-secondary hover:bg-app-hover"
          >
            <Plus size={13} className="flex-shrink-0 text-app-text-tertiary" />
            Aggiungi una persona
          </button>
        ) : (
          <div className="space-y-1.5 border-t border-app-border px-3 py-2">
            <input
              autoFocus
              value={nuovo.nome}
              onChange={(e) => setNuovo({ ...nuovo, nome: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') void aggiungi(); if (e.key === 'Escape') setNuovo(null); }}
              aria-label="Nome della persona"
              placeholder="Nome"
              className={campo}
            />
            <input
              value={nuovo.email}
              onChange={(e) => setNuovo({ ...nuovo, email: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') void aggiungi(); if (e.key === 'Escape') setNuovo(null); }}
              aria-label="Email della persona"
              placeholder="Email (facoltativa)"
              className={campo}
            />
            <div className="flex gap-1.5">
              <button
                disabled={inCorso}
                onClick={() => void aggiungi()}
                className="rounded border border-app-border px-2 py-0.5 text-[11px] text-app-text hover:bg-app-hover disabled:opacity-50"
              >
                Aggiungi
              </button>
              <button
                onClick={() => setNuovo(null)}
                className="rounded px-2 py-0.5 text-[11px] text-app-text-tertiary hover:bg-app-hover"
              >
                Annulla
              </button>
            </div>
          </div>
        )}
      </div>

      <p className="text-[10px] leading-snug text-app-text-muted">
        Aggiungere una persona non le dà accesso a questa macchina: le dà un nome
        con cui condividere. Per entrare deve comunque collegare un suo
        dispositivo e tu approvarlo, e resterà un ospite — vedrà solo ciò che le
        hai condiviso. L’email è un’etichetta, non un accesso.
      </p>
    </div>
  );
}
