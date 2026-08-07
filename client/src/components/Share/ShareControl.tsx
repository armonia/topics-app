import { useCallback, useEffect, useState } from 'react';
import { Share2, X, UserPlus } from 'lucide-react';

/**
 * Il gesto: dare a un ospite una scheda, o una chat.
 *
 * Generico sul TIPO di risorsa perché il modello sotto lo è (una tabella
 * `grants`, non una per tipo). Un controllo per tipo sarebbe la stessa
 * divergenza che il modello unico serve a evitare: due pannelli che si
 * comportano diversamente sulla stessa domanda.
 *
 * Esiste perché senza, la condivisione è vera solo per chi sa usare `curl` — la
 * stessa critica che abbiamo già fatto due volte stasera, prima al pannello dei
 * dispositivi e poi alla revoca.
 *
 * Mostra la PROVENIENZA quando c'è: «da progetto X» invece di una riga muta.
 * Senza, alla domanda «perché costui vede questa cosa?» non c'è risposta, e un
 * permesso a cui non si sa rispondere è un permesso che non si toglie.
 */
type ResourceType = 'task' | 'topic';

/** Un destinatario possibile: un dispositivo ospite, una persona, un team.
 *  Arriva da `/api/auth/subjects` — che è una RUBRICA, non l'elenco dei
 *  dispositivi filtrato per ruolo. La differenza si vede su una persona che non
 *  ha ancora appaiato niente: con l'elenco dei dispositivi era invisibile,
 *  quindi «invitare qualcuno» voleva dire aspettare il suo telefono. */
interface Subject {
  subjectType: 'device' | 'person' | 'org';
  subjectId: string;
  name: string;
  /** Quanti dispositivi (persona) o membri (organizzazione) ci stanno dietro. */
  devices: number;
}

interface Share {
  subjectType: 'device' | 'person' | 'org';
  subjectId: string;
  /** Alias legacy: il server lo manda ancora per una release. */
  deviceId?: string;
  name: string;
  sharedAt: number;
  via: { type: string; id: string | null } | null;
}

const ETICHETTA: Record<Subject['subjectType'], string> = {
  device: 'dispositivo', person: 'persona', org: 'team',
};

export function ShareControl({ resourceType, resourceId }: { resourceType: ResourceType; resourceId: string }) {
  const [aperto, setAperto] = useState(false);
  const [shares, setShares] = useState<Share[]>([]);
  const [soggetti, setSoggetti] = useState<Subject[]>([]);
  const [errore, setErrore] = useState<string | null>(null);
  const [inCorso, setInCorso] = useState(false);

  const carica = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([
        fetch(`/api/auth/shares?resourceType=${resourceType}&resourceId=${encodeURIComponent(resourceId)}`, { credentials: 'same-origin' }).then((r) => r.json()),
        fetch('/api/auth/subjects', { credentials: 'same-origin' }).then((r) => r.json()),
      ]) as [{ shares: Share[] }, { subjects: Subject[] }];
      setShares(s.shares ?? []);
      setSoggetti(d.subjects ?? []);
      setErrore(null);
    } catch {
      setErrore('Non riesco a leggere le condivisioni.');
    }
  }, [resourceType, resourceId]);

  useEffect(() => { if (aperto) void carica(); }, [aperto, carica]);

  const condividi = async (sog: Subject) => {
    setInCorso(true);
    try {
      const r = await fetch('/api/auth/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          resourceType, resourceId,
          subjectType: sog.subjectType, subjectId: sog.subjectId,
        }),
      });
      if (!r.ok) setErrore(((await r.json()) as { error?: string }).error ?? 'Non riuscito.');
      await carica();
    } finally { setInCorso(false); }
  };

  const togli = async (s: Share) => {
    setInCorso(true);
    try {
      await fetch(`/api/auth/shares?resourceType=${resourceType}&resourceId=${encodeURIComponent(resourceId)}&subjectType=${s.subjectType}&subjectId=${encodeURIComponent(s.subjectId)}`, {
        method: 'DELETE', credentials: 'same-origin',
      });
      await carica();
    } finally { setInCorso(false); }
  };

  // La chiave è la COPPIA tipo+id: due soggetti di tipo diverso possono avere
  // lo stesso id senza essere la stessa cosa.
  const chiave = (t: string, i: string) => `${t}:${i}`;
  const giaCondiviso = new Set(shares.map((s) => chiave(s.subjectType, s.subjectId)));
  const disponibili = soggetti.filter((o) => !giaCondiviso.has(chiave(o.subjectType, o.subjectId)));

  return (
    <div className="relative">
      <button
        onClick={() => setAperto((v) => !v)}
        data-testid="share-control"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-app-text-secondary hover:bg-app-hover hover:text-app-text"
        title="Condividi con un ospite"
      >
        <Share2 size={12} />
        {shares.length > 0 ? `Condiviso con ${shares.length}` : 'Condividi'}
      </button>

      {aperto && (
        <div className="absolute right-0 z-50 mt-1 w-[280px] rounded-xl border border-app-border bg-surface p-2.5 shadow-lg">
          {errore && <p className="mb-2 text-[11px] text-red-500">{errore}</p>}

          {shares.length > 0 && (
            <ul className="mb-2 space-y-1">
              {shares.map((s) => (
                <li key={chiave(s.subjectType, s.subjectId)} className="flex items-center gap-2 rounded px-1.5 py-1 text-[12px]">
                  <span className="min-w-0 flex-1">
                    <span className="truncate text-app-text">{s.name}</span>
                    {/* La provenienza: senza, «perché costui vede questa cosa?»
                        non ha risposta, e un permesso a cui non si sa rispondere
                        è un permesso che non si toglie. E si dice QUALE: «da
                        progetto» senza dire quale non risponde alla domanda per
                        cui la colonna esiste. */}
                    {s.via && (
                      <span className="ml-1 text-[10px] text-app-text-muted">
                        da {s.via.type}{s.via.id ? ` ${s.via.id}` : ''}
                      </span>
                    )}
                  </span>
                  <button
                    aria-label={`Togli l'accesso a ${s.name}`}
                    disabled={inCorso}
                    onClick={() => void togli(s)}
                    className="rounded p-0.5 text-app-text-tertiary hover:bg-app-hover hover:text-red-500 disabled:opacity-50"
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {disponibili.length > 0 ? (
            <>
              <div className="mb-1 px-1.5 text-[10px] uppercase tracking-wide text-app-text-muted">Aggiungi</div>
              <ul className="space-y-0.5">
                {disponibili.map((o) => (
                  <li key={chiave(o.subjectType, o.subjectId)}>
                    <button
                      disabled={inCorso}
                      onClick={() => void condividi(o)}
                      className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] text-app-text hover:bg-app-hover disabled:opacity-50"
                    >
                      <UserPlus size={11} className="flex-shrink-0 text-app-text-tertiary" />
                      <span className="truncate">{o.name}</span>
                      {/* Un team dice quante persone tiene: «condiviso con
                          Armonia» senza un numero non fa capire con quanti. */}
                      {o.subjectType !== 'device' && (
                        <span className="ml-auto flex-shrink-0 text-[10px] text-app-text-muted">
                          {ETICHETTA[o.subjectType]}{o.devices > 1 ? ` · ${o.devices}` : ''}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="px-1.5 py-1 text-[11px] leading-relaxed text-app-text-secondary">
              {soggetti.length === 0
                ? 'Nessuno con cui condividere. Autorizza un dispositivo come ospite da Impostazioni → Dispositivi, e comparirà qui.'
                : 'Già condiviso con tutti.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
