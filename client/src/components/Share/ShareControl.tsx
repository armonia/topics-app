import { useCallback, useEffect, useRef, useState } from 'react';
import { componiLink } from '../../../../shared/relay-crypto';
import { Share2, X, UserPlus, Globe, Copy, Check, Link2 } from 'lucide-react';
import { useT } from '../../hooks/useT';
import { chiaveErroreAuth } from '../../lib/authErrors';
import { copyText } from '../../lib/clipboard';
import { Menu } from '../Shared/Menu';
import { POPOVER_DIVIDER, POPOVER_ITEM } from '../../lib/popoverStyles';

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
type ResourceType = 'task' | 'topic' | 'project';

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

interface LinkOutsideNetwork {
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

/** Il titolo dice COSA si sta condividendo. «Condividi con un ospite» su una
 *  chat e su una scheda è la stessa frase per due gesti diversi: chi la legge
 *  non sa quale delle due cose sta per uscire di casa. */
const KEY_TITLE: Record<ResourceType, string> = {
  task: 'share.title.task',
  topic: 'share.title.topic',
  // `Record` e non un indice parziale: aggiungere un tipo di risorsa e
  // dimenticare il titolo qui e' un errore di compilazione, non una schermata
  // con una chiave grezza al posto della frase.
  project: 'share.title.project',
};

/** Cosa vedrà chi apre il link, detto per la risorsa giusta. */
const KEY_OBJECT: Record<ResourceType, string> = {
  task: 'share.object.task',
  topic: 'share.object.topic',
  project: 'share.object.project',
};

export function ShareControl({ resourceType, resourceId, deepLink }: {
  resourceType: ResourceType;
  resourceId: string;
  /**
   * Il link INTERNO alla risorsa — quello che riapre questa scheda in questa
   * app, non l'invito cifrato per un ospite.
   *
   * Sta qui perché «dammi il link» è una domanda sola con due risposte, e prima
   * viveva in due posti: un'icona a catena nella testata del drawer e un
   * pannello di condivisione accanto. Chi cercava «il link» ne trovava uno dei
   * due a caso. Quando il chiamante non ne ha uno la riga non si disegna.
   *
   * È una FUNZIONE, non una stringa, e non è pignoleria: comporre il permalink
   * legge `window.location`, quindi un chiamante che lo calcolasse al proprio
   * render obbligherebbe ogni suo test a montare un DOM per una riga che si
   * disegna comunque. Qui si chiama solo quando qualcuno preme.
   */
  deepLink?: () => string | null;
}) {
  const t = useT();
  const [aperto, setAperto] = useState(false);
  const [shares, setShares] = useState<Share[]>([]);
  const [soggetti, setSoggetti] = useState<Subject[]>([]);
  /** Il relay: dove vive e come si chiama questa installazione. `null` = spento,
   *  e allora il gesto «fuori rete» non si offre affatto — un bottone che non
   *  può funzionare è peggio di un bottone che non c'è. */
  const [relay, setRelay] = useState<{ baseUrl: string; relayId: string; connected: boolean } | null>(null);
  const [links, setLinks] = useState<LinkOutsideNetwork[]>([]);
  /** Il link appena creato, con la chiave. Vive SOLO qui, in memoria: il server
   *  non lo ripropone mai più. Chiudere il pannello lo perde, ed è giusto —
   *  se serve di nuovo se ne fa un altro. */
  const [appenaCreato, setAppenaCreato] = useState<string | null>(null);
  const [copiato, setCopiato] = useState(false);
  /** Il link INTERNO appena copiato: spia sua, separata da quella dell'invito
   *  cifrato — due gesti diversi non possono accendere la stessa spunta. */
  const [copiatoDeep, setCopiatoDeep] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  const [inCorso, setInCorso] = useState(false);
  const ancoraRef = useRef<HTMLButtonElement>(null);
  const timerCopy = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerCopy.current) clearTimeout(timerCopy.current); }, []);

  const copyDeepLink = useCallback(async () => {
    const url = deepLink?.();
    if (!url) return;
    if (!(await copyText(url))) return;
    setCopiatoDeep(true);
    if (timerCopy.current) clearTimeout(timerCopy.current);
    timerCopy.current = setTimeout(() => setCopiatoDeep(false), 1400);
  }, [deepLink]);

  const carica = useCallback(async () => {
    try {
      const [s, d, r, l] = await Promise.all([
        fetch(`/api/auth/shares?resourceType=${resourceType}&resourceId=${encodeURIComponent(resourceId)}`, { credentials: 'same-origin' }).then((r) => r.json()),
        fetch('/api/auth/subjects', { credentials: 'same-origin' }).then((r) => r.json()),
        fetch('/api/auth/relay', { credentials: 'same-origin' }).then((r) => r.json()),
        fetch(`/api/auth/share-links?resourceType=${resourceType}&resourceId=${encodeURIComponent(resourceId)}`, { credentials: 'same-origin' }).then((r) => r.json()),
      ]) as [
        { shares: Share[] }, { subjects: Subject[] },
        { enabled: boolean; baseUrl: string | null; relayId: string | null; connected: boolean },
        { links: LinkOutsideNetwork[] },
      ];
      setShares(s.shares ?? []);
      setSoggetti(d.subjects ?? []);
      setRelay(r.enabled && r.baseUrl && r.relayId
        ? { baseUrl: r.baseUrl, relayId: r.relayId, connected: r.connected }
        : null);
      setLinks((l.links ?? []).filter((x) => x.revokedAt === null && !x.scaduto));
      setErrore(null);
    } catch {
      setErrore(t('share.loadFailed'));
    }
  }, [resourceType, resourceId, t]);

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
      // Il server manda un CODICE (`shared/auth-codes.ts`), non una frase: qui
      // c'era `setErrore(body.error)`, che stampava la prosa italiana del
      // server sotto un titolo inglese.
      if (!r.ok) setErrore(t(chiaveErroreAuth(((await r.json()) as { error?: string }).error)));
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
      if (!r.ok) { setErrore(t(chiaveErroreAuth(((await r.json()) as { error?: string }).error))); return; }
      const { ref, key } = await r.json() as { ref: string; key: string };
      setAppenaCreato(componiLink(relay.baseUrl, relay.relayId, ref, key));
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
  const alreadyShared = new Set(shares.map((s) => chiave(s.subjectType, s.subjectId)));
  const disponibili = soggetti.filter((o) => !alreadyShared.has(chiave(o.subjectType, o.subjectId)));

  return (
    <div className="relative">
      <button
        ref={ancoraRef}
        onClick={() => setAperto((v) => !v)}
        data-testid="share-control"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-app-text-secondary hover:bg-app-hover hover:text-app-text"
        title={t(KEY_TITLE[resourceType])}
      >
        <Share2 size={12} />
        {shares.length > 0 ? t('share.sharedWith', { n: shares.length }) : t('share.button')}
      </button>

      {/* PORTALE, e non è un dettaglio di stile: il pannello era un
          `absolute` dentro la testata del drawer, che è un flex con
          `overflow-hidden`. Un antenato che ritaglia ritaglia anche un figlio
          posizionato, quindi il pannello usciva alto quanto la riga della
          testata — 41px — e di lui si vedeva una fetta. È il «share non
          funziona»: funzionava, non si vedeva. Passando dalla primitiva `Menu`
          eredita il portale, il posizionamento che rimbalza dentro la finestra,
          la chiusura con Escape e l'esclusività fra popover, che sono le
          quattro cose che un pannello scritto a mano non ha mai. */}
      <Menu
        open={aperto}
        anchorRef={ancoraRef}
        onClose={() => setAperto(false)}
        align="right"
        minWidth={280}
        unmanagedFocus
        ariaLabel={t(KEY_TITLE[resourceType])}
        testId="share-panel"
        className="w-[280px]"
      >
        <>
          {errore && <p className="mb-2 px-2.5 text-[11px] text-red-500">{errore}</p>}

          {/* IL LINK DI CASA, primo. «Dammi il link» è la domanda più comune di
              questo pannello e finora non c'era: qui si condividevano permessi,
              e il link per riaprire la scheda stava in un'icona a parte. */}
          {deepLink && (
            <>
              <button
                onClick={() => { void copyDeepLink(); }}
                data-testid="share-copy-link"
                title={t('share.copyLinkTitle')}
                className={POPOVER_ITEM}
              >
                {copiatoDeep
                  ? <Check size={12} className="flex-shrink-0 text-green-500" />
                  : <Link2 size={12} className="flex-shrink-0 text-app-text-tertiary" />}
                <span className="min-w-0 flex-1 text-left">{copiatoDeep ? t('share.copyLinkDone') : t('share.copyLink')}</span>
              </button>
              <div className={POPOVER_DIVIDER} />
            </>
          )}

          {shares.length > 0 && (
            <ul className="mb-2 space-y-1 px-1">
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
                    aria-label={t('share.removeAccess', { name: s.name })}
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
            <div className="mx-2.5 mb-2 border-b border-app-border pb-2">
              {appenaCreato ? (
                <>
                  <div className="flex items-center gap-1">
                    <input
                      readOnly
                      value={appenaCreato}
                      onFocus={(e) => e.currentTarget.select()}
                      aria-label={t('share.linkToShare')}
                      className="min-w-0 flex-1 rounded border border-app-border bg-app-bg px-1.5 py-1 font-mono text-[10px] text-app-text outline-none"
                    />
                    <button
                      onClick={() => { void navigator.clipboard?.writeText(appenaCreato); setCopiato(true); }}
                      aria-label={t('share.copyGuestLink')}
                      className="flex-shrink-0 rounded p-1 text-app-text-tertiary hover:bg-app-hover hover:text-app-text"
                    >
                      {copiato ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                    </button>
                  </div>
                  {/* Le due cose che chi crea un link deve leggere ADESSO, non
                      scoprire dopo: che il link È la credenziale, e che scade. */}
                  <p className="mt-1.5 text-[10px] leading-snug text-app-text-muted">
                    {t('share.linkWarning', { object: t(KEY_OBJECT[resourceType]) })}
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
                  <span className="flex-1">{t('share.createOffNetwork')}</span>
                  {/* Collegato o no: un link creato mentre il relay è giù è
                      valido lo stesso, ma non si apre finché non torna. Dirlo
                      prima è meglio che farlo scoprire a chi lo riceve. */}
                  {!relay.connected && (
                    <span className="flex-shrink-0 text-[10px] text-amber-500">{t('share.notConnected')}</span>
                  )}
                </button>
              )}

              {links.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {links.map((l) => (
                    <li key={l.ref} className="flex items-center gap-2 px-1.5 text-[11px] text-app-text-muted">
                      <span className="min-w-0 flex-1 truncate">
                        {t('share.linkExpires', { date: new Date(l.expiresAt).toLocaleDateString() })}
                        {l.openedCount > 0 && t('share.linkOpened', { n: l.openedCount })}
                      </span>
                      <button
                        aria-label={t('share.revokeLink')}
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
              <div className="mb-1 px-3 text-[10px] uppercase tracking-wide text-app-text-muted">{t('share.add')}</div>
              <ul className="space-y-0.5 px-1">
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
            <p className="px-2.5 py-1 text-[11px] leading-relaxed text-app-text-secondary">
              {soggetti.length === 0 ? t('share.nobodyYet') : t('share.alreadyAll')}
            </p>
          )}
        </>
      </Menu>
    </div>
  );
}
