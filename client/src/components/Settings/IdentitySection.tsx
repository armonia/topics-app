import { useCallback, useEffect, useState } from 'react';
import { User, Building2, Pencil, Plus, X } from 'lucide-react';

/**
 * Chi sei, e come si chiama la tua organizzazione.
 *
 * ── PERCHÉ ESISTONO GIÀ, E NON SI CREANO ────────────────────────────────────
 * La persona e l'organizzazione non si creano da qui: le ha fatte la migration
 * `084`, una volta, con nomi segnaposto. Da qui si dice solo COME SI CHIAMANO.
 *
 * La differenza non è di comodo. «Proprietario dell'installazione» è una
 * proprietà locale che nessuna sincronizzazione può scrivere: se ci fosse un
 * bottone «crea una persona proprietaria», il giorno che le organizzazioni
 * arrivano da un servizio centrale ci sarebbero due strade per diventare
 * padroni di questa macchina, e la seconda non la controlleresti tu.
 *
 * ── L'EMAIL NON È UN LOGIN ──────────────────────────────────────────────────
 * È un'etichetta, e serve a due cose vere: farsi riconoscere in un elenco di
 * membri, e — quando arriverà il piano di controllo — essere la chiave con cui
 * un invito ti trova. Non autentica niente adesso, e la schermata non lo lascia
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

export function IdentitySection() {
  const [io, setIo] = useState<Io | null>(null);
  const [modifica, setModifica] = useState<'persona' | 'org' | null>(null);
  const [bozza, setBozza] = useState('');
  const [bozzaEmail, setBozzaEmail] = useState('');
  const [inCorso, setInCorso] = useState(false);
  const [membri, setMembri] = useState<Membro[]>([]);
  const [nuovo, setNuovo] = useState<string | null>(null);

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

  const aggiungi = async () => {
    const nome = (nuovo ?? '').trim();
    if (!io?.org || !nome) { setNuovo(null); return; }
    setInCorso(true);
    try {
      await fetch(`/api/auth/orgs/${encodeURIComponent(io.org.id)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ name: nome }),
      });
      await Promise.all([carica(), caricaMembri(io.org.id)]);
    } finally { setInCorso(false); setNuovo(null); }
  };

  const togli = async (m: Membro) => {
    if (!io?.org) return;
    await fetch(`/api/auth/orgs/${encodeURIComponent(io.org.id)}/members?personId=${encodeURIComponent(m.id)}`, {
      method: 'DELETE', credentials: 'same-origin',
    });
    await Promise.all([carica(), caricaMembri(io.org.id)]);
  };

  const salva = async () => {
    if (!io || !modifica) return;
    const nome = bozza.trim();
    if (!nome) { setModifica(null); return; }
    const id = modifica === 'persona' ? io.person?.id : io.org?.id;
    if (!id) return;
    setInCorso(true);
    try {
      await fetch(`/api/auth/${modifica === 'persona' ? 'people' : 'orgs'}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(
          modifica === 'persona'
            // Stringa vuota = togli l'email. È diverso da «non l'ho toccata»,
            // e il server distingue le due cose.
            ? { name: nome, email: bozzaEmail.trim() || null }
            : { name: nome },
        ),
      });
      await carica();
    } finally {
      setInCorso(false);
      setModifica(null);
    }
  };

  // Niente persone = schema più vecchio della 084. Si tace invece di mostrare
  // una sezione vuota che sembra rotta.
  if (!io?.person) return null;

  const soloTu = (io.org?.members ?? 1) <= 1;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-[13px] font-semibold text-app-text">Tu</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-app-text-secondary">
          Il nome con cui compari quando condividi qualcosa. I tuoi dispositivi
          fanno capo a questa persona: è per questo che una cosa condivisa con te
          si vede da tutti, e non solo da quello che avevi in mano.
        </p>
      </div>

      <div className="rounded-lg border border-app-border px-3 py-2.5">
        {modifica === 'persona' ? (
          <div className="space-y-1.5">
            <input
              autoFocus
              value={bozza}
              onChange={(e) => setBozza(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void salva(); if (e.key === 'Escape') setModifica(null); }}
              aria-label="Il tuo nome"
              placeholder="Il tuo nome"
              className="w-full rounded border border-app-border bg-app-bg px-2 py-1 text-[12.5px] text-app-text outline-none focus:border-primary"
            />
            <input
              value={bozzaEmail}
              onChange={(e) => setBozzaEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void salva(); if (e.key === 'Escape') setModifica(null); }}
              aria-label="La tua email"
              placeholder="Email (facoltativa)"
              className="w-full rounded border border-app-border bg-app-bg px-2 py-1 text-[12px] text-app-text outline-none focus:border-primary"
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
            {/* Detto qui e non in una guida: un'email in questo campo non ti fa
                entrare da nessuna parte. */}
            <p className="text-[10px] leading-snug text-app-text-muted">
              L'email è solo un'etichetta per farti riconoscere. Non è un accesso:
              a farti entrare resta l'autorizzazione dei dispositivi.
            </p>
          </div>
        ) : (
          <button
            onClick={() => {
              setBozza(io.person!.name);
              setBozzaEmail(io.person!.email ?? '');
              setModifica('persona');
            }}
            className="group flex w-full items-center gap-2 text-left"
            title="Cambia nome"
          >
            <User size={13} className="flex-shrink-0 text-app-text-tertiary" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] text-app-text">{io.person.name}</span>
              {io.person.email && (
                <span className="block truncate text-[11px] text-app-text-muted">{io.person.email}</span>
              )}
            </span>
            <Pencil size={10} className="flex-shrink-0 text-app-text-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        )}
      </div>

      {io.org && (
        <>
          <div>
            {/* ORG-07: a chi è solo non si nomina un concetto che non gli
                serve. La parola compare quando c'è davvero più di una persona
                — prima è un elenco di persone, e basta. */}
            <h3 className="text-[13px] font-semibold text-app-text">
              {soloTu ? 'Persone' : 'La tua organizzazione'}
            </h3>
            <p className="mt-1 text-[12px] leading-relaxed text-app-text-secondary">
              {soloTu
                ? 'Per adesso ci sei solo tu. Aggiungi qualcuno per poter condividere con lui, anche prima che colleghi un suo dispositivo.'
                : 'Condividere con l’organizzazione vale per tutti i suoi membri, senza rifarlo uno per uno.'}
            </p>
          </div>

          {!soloTu && (
            <div className="rounded-lg border border-app-border px-3 py-2.5">
              {modifica === 'org' ? (
                <div className="flex gap-1.5">
                  <input
                    autoFocus
                    value={bozza}
                    onChange={(e) => setBozza(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void salva(); if (e.key === 'Escape') setModifica(null); }}
                    aria-label="Nome dell'organizzazione"
                    className="min-w-0 flex-1 rounded border border-app-border bg-app-bg px-2 py-1 text-[12.5px] text-app-text outline-none focus:border-primary"
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
                  onClick={() => { setBozza(io.org!.name); setModifica('org'); }}
                  className="group flex w-full items-center gap-2 text-left"
                  title="Cambia nome"
                >
                  <Building2 size={13} className="flex-shrink-0 text-app-text-tertiary" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-app-text">{io.org.name}</span>
                  <Pencil size={10} className="flex-shrink-0 text-app-text-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              )}
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-app-border">
            {membri.map((m) => (
              <div
                key={m.id}
                className="group flex items-center gap-2 border-b border-app-border px-3 py-2 last:border-b-0"
              >
                <User size={13} className="flex-shrink-0 text-app-text-tertiary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-app-text">{m.name}</span>
                  {m.email && <span className="block truncate text-[11px] text-app-text-muted">{m.email}</span>}
                </span>
                <span className="flex-shrink-0 text-[11px] text-app-text-muted">
                  {/* Zero dispositivi non è un errore: è il caso normale di chi
                      è stato invitato e non si è ancora collegato. Detto qui,
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
            ))}

            {nuovo === null ? (
              <button
                onClick={() => setNuovo('')}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] text-app-text-secondary hover:bg-app-hover"
              >
                <Plus size={13} className="flex-shrink-0 text-app-text-tertiary" />
                Aggiungi una persona
              </button>
            ) : (
              <div className="flex gap-1.5 px-3 py-2">
                <input
                  autoFocus
                  value={nuovo}
                  onChange={(e) => setNuovo(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void aggiungi(); if (e.key === 'Escape') setNuovo(null); }}
                  aria-label="Nome della persona"
                  placeholder="Nome"
                  className="min-w-0 flex-1 rounded border border-app-border bg-app-bg px-2 py-1 text-[12.5px] text-app-text outline-none focus:border-primary"
                />
                <button
                  disabled={inCorso}
                  onClick={() => void aggiungi()}
                  className="flex-shrink-0 rounded border border-app-border px-2 py-1 text-[11px] text-app-text hover:bg-app-hover disabled:opacity-50"
                >
                  Aggiungi
                </button>
              </div>
            )}
          </div>

          <p className="text-[10px] leading-snug text-app-text-muted">
            Aggiungere una persona non le dà accesso a questa macchina: le dà un
            nome con cui condividere. Per entrare le serve comunque autorizzare
            un suo dispositivo, e resterà un ospite — vedrà solo ciò che le hai
            condiviso.
          </p>
        </>
      )}

    </div>
  );
}
