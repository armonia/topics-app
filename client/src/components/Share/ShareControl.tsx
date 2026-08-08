import { useCallback, useEffect, useState } from 'react';
import { componiLink } from '../../../../shared/relay-crypto';
import { Share2, X, UserPlus, Globe, Copy, Check } from 'lucide-react';

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
 * Alla domanda «perché costui vede questa cosa?» risponde il SOGGETTO della
 * riga — questo dispositivo, questa persona, questo team — che è l'unica
 * provenienza che esiste: nessuna concessione è derivata da un contenitore
 * (vedi `GrantRow` in server/lib/grants-query.ts).
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

interface LinkFuoriRete {
  ref: string;
  expiresAt: number;
  revokedAt: number | null;
  openedCount: number;
  scaduto: boolean;
}

interface Share {
  subjectType: 'device' | 'person' | 'org';
  subjectId: string;
  /** Alias legacy: il server lo manda ancora per una release. */
  deviceId?: string;
  name: string;
  sharedAt: number;
}

const ETICHETTA: Record<Subject['subjectType'], string> = {
  device: 'device', person: 'person', org: 'team',
};

/** Il titolo dice COSA si sta condividendo. «Share with a guest» su una chat e
 *  su una scheda è la stessa frase per due gesti diversi: chi la legge non sa
 *  quale delle due cose sta per uscire di casa. */
const TITOLO_BOTTONE: Record<ResourceType, string> = {
  task: 'Share this card with a guest',
  topic: 'Share this chat with a guest',
};

/** Cosa vedrà chi apre il link, detto per la risorsa giusta. */
const OGGETTO_LINK: Record<ResourceType, string> = {
  task: 'this card',
  topic: 'this chat',
};

export function ShareControl({ resourceType, resourceId }: { resourceType: ResourceType; resourceId: string }) {
  const [aperto, setAperto] = useState(false);
  const [shares, setShares] = useState<Share[]>([]);
  const [soggetti, setSoggetti] = useState<Subject[]>([]);
  /** Il relay: dove vive e come si chiama questa installazione. `null` = spento,
   *  e allora il gesto «fuori rete» non si offre affatto — un bottone che non
   *  può funzionare è peggio di un bottone che non c'è. */
  const [relay, setRelay] = useState<{ baseUrl: string; installationId: string; connected: boolean } | null>(null);
  const [links, setLinks] = useState<LinkFuoriRete[]>([]);
  /** Il link appena creato, con la chiave. Vive SOLO qui, in memoria: il server
   *  non lo ripropone mai più. Chiudere il pannello lo perde, ed è giusto —
   *  se serve di nuovo se ne fa un altro. */
  const [appenaCreato, setAppenaCreato] = useState<string | null>(null);
  const [copiato, setCopiato] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  const [inCorso, setInCorso] = useState(false);

  const carica = useCallback(async () => {
    try {
      const [s, d, r, l] = await Promise.all([
        fetch(`/api/auth/shares?resourceType=${resourceType}&resourceId=${encodeURIComponent(resourceId)}`, { credentials: 'same-origin' }).then((r) => r.json()),
        fetch('/api/auth/subjects', { credentials: 'same-origin' }).then((r) => r.json()),
        fetch('/api/auth/relay', { credentials: 'same-origin' }).then((r) => r.json()),
        fetch(`/api/auth/share-links?resourceType=${resourceType}&resourceId=${encodeURIComponent(resourceId)}`, { credentials: 'same-origin' }).then((r) => r.json()),
      ]) as [
        { shares: Share[] }, { subjects: Subject[] },
        { enabled: boolean; baseUrl: string | null; installationId: string | null; connected: boolean },
        { links: LinkFuoriRete[] },
      ];
      setShares(s.shares ?? []);
      setSoggetti(d.subjects ?? []);
      setRelay(r.enabled && r.baseUrl && r.installationId
        ? { baseUrl: r.baseUrl, installationId: r.installationId, connected: r.connected }
        : null);
      setLinks((l.links ?? []).filter((x) => x.revokedAt === null && !x.scaduto));
      setErrore(null);
    } catch {
      setErrore('Could not load sharing.');
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
      if (!r.ok) setErrore(((await r.json()) as { error?: string }).error ?? 'Failed.');
      await carica();
    } finally { setInCorso(false); }
  };

  /**
   * Crea un link per chi NON è sulla tua rete.
   *
   * La chiave torna UNA volta sola, da questa risposta: si compone il link e la
   * si dimentica. Il server non la ripropone mai più — un endpoint che lo
   * facesse trasformerebbe ogni lettura dell'elenco in una copia del segreto.
   */
  const creaLink = async () => {
    if (!relay) return;
    setInCorso(true);
    try {
      const r = await fetch('/api/auth/share-links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ resourceType, resourceId }),
      });
      if (!r.ok) { setErrore(((await r.json()) as { error?: string }).error ?? 'Failed.'); return; }
      const { ref, key } = await r.json() as { ref: string; key: string };
      setAppenaCreato(componiLink(relay.baseUrl, relay.installationId, ref, key));
      setCopiato(false);
      await carica();
    } finally { setInCorso(false); }
  };

  const revocaLink = async (ref: string) => {
    setInCorso(true);
    try {
      await fetch(`/api/auth/share-links?ref=${encodeURIComponent(ref)}`, { method: 'DELETE', credentials: 'same-origin' });
      setAppenaCreato(null);
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
        title={TITOLO_BOTTONE[resourceType]}
      >
        <Share2 size={12} />
        {shares.length > 0 ? `Shared with ${shares.length}` : 'Share'}
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
                    {/* CHI, e di che natura: «Anna · person» e «Anna · device»
                        sono due permessi diversi — il primo segue la persona su
                        ogni suo dispositivo, il secondo muore con quel ferro.
                        Il nome da solo non lo dice, e la revoca è la stessa
                        riga per due significati diversi. */}
                    <span className="ml-1 text-[10px] text-app-text-muted">
                      {ETICHETTA[s.subjectType]}
                    </span>
                  </span>
                  <button
                    aria-label={`Remove access for ${s.name}`}
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

          {/* ── FUORI RETE. Compare solo se il relay c'è: un bottone che non può
                 funzionare è peggio di un bottone che non c'è.

                 La parola «tunnel» non si legge da nessuna parte, ed è
                 deliberato — chi condivide non deve sapere cos'è. Quello che
                 DEVE sapere sta scritto sotto il link: che chi ce l'ha entra, e
                 quando smette di valere. */}
          {relay && (
            <div className="mb-2 border-b border-app-border pb-2">
              {appenaCreato ? (
                <>
                  <div className="flex items-center gap-1">
                    <input
                      readOnly
                      value={appenaCreato}
                      onFocus={(e) => e.currentTarget.select()}
                      aria-label="Link to share"
                      className="min-w-0 flex-1 rounded border border-app-border bg-app-bg px-1.5 py-1 font-mono text-[10px] text-app-text outline-none"
                    />
                    <button
                      onClick={() => { void navigator.clipboard?.writeText(appenaCreato); setCopiato(true); }}
                      aria-label="Copy link"
                      className="flex-shrink-0 rounded p-1 text-app-text-tertiary hover:bg-app-hover hover:text-app-text"
                    >
                      {copiato ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                    </button>
                  </div>
                  {/* Le due cose che chi crea un link deve leggere ADESSO, non
                      scoprire dopo: che il link È la credenziale, e che scade. */}
                  <p className="mt-1.5 text-[10px] leading-snug text-app-text-muted">
                    Anyone with this link can read {OGGETTO_LINK[resourceType]}. It expires in 7 days,
                    and you can revoke it whenever you want. The content travels encrypted: whoever
                    carries it cannot read it.
                  </p>
                </>
              ) : (
                <button
                  disabled={inCorso}
                  onClick={() => void creaLink()}
                  data-testid="share-fuori-rete"
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] text-app-text hover:bg-app-hover disabled:opacity-50"
                >
                  <Globe size={11} className="flex-shrink-0 text-app-text-tertiary" />
                  <span className="flex-1">Create a link for someone off your network</span>
                  {/* Collegato o no: un link creato mentre il relay è giù è
                      valido lo stesso, ma non si apre finché non torna. Dirlo
                      prima è meglio che farlo scoprire a chi lo riceve. */}
                  {!relay.connected && (
                    <span className="flex-shrink-0 text-[10px] text-amber-500">not connected</span>
                  )}
                </button>
              )}

              {links.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {links.map((l) => (
                    <li key={l.ref} className="flex items-center gap-2 px-1.5 text-[11px] text-app-text-muted">
                      <span className="min-w-0 flex-1 truncate">
                        link · expires {new Date(l.expiresAt).toLocaleDateString()}
                        {l.openedCount > 0 && ` · opened ${l.openedCount}×`}
                      </span>
                      <button
                        aria-label="Revoke this link"
                        disabled={inCorso}
                        onClick={() => void revocaLink(l.ref)}
                        className="rounded p-0.5 text-app-text-tertiary hover:bg-app-hover hover:text-red-500 disabled:opacity-50"
                      >
                        <X size={11} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {disponibili.length > 0 ? (
            <>
              <div className="mb-1 px-1.5 text-[10px] uppercase tracking-wide text-app-text-muted">Add</div>
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
                ? 'Nobody to share with yet. Approve a device as a guest from Settings → Account, and it will show up here.'
                : 'Already shared with everyone.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
