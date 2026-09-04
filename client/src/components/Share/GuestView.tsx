import { useCallback, useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { MessageSquare, LayoutGrid, RefreshCw } from 'lucide-react';
import { MODAL_LAYER } from '../../lib/modalStyles';
import { STATUS_LABEL, isProjectlessId } from '../../lib/board';
import type { TaskStatus } from '../../../../shared/board';

/**
 * Cosa vede un OSPITE quando apre Topics.
 *
 * Prende il posto dell'app intera, non ne è una versione con meno voci di menu.
 * La differenza non è estetica: la board, i progetti e i terminali sono negati
 * dal server, quindi mostrarli produrrebbe una schermata di errori — e un ospite
 * che vede errori pensa che sia rotto, non che non sia roba sua.
 *
 * I dati arrivano da `/api/auth/shared`, che parte dalle CONCESSIONI invece di
 * filtrare un elenco. È l'unica forma che non può perdere niente: non ha niente
 * da filtrare. (La forma sbagliata l'abbiamo già provata: mettere `/api/topics`
 * in allowlist rispondeva 200 con tutte le chat.)
 */
interface SharedTask {
  id: string;
  text: string;
  status: string;
  project_id: string | null;
  preview_image: string | null;
}

interface SharedChat {
  id: string;
  name: string;
  updated_at: string | null;
}

export function GuestView({ deviceName }: { deviceName: string }) {
  const tr = useT();
  const [tasks, setTasks] = useState<SharedTask[]>([]);
  const [chats, setChats] = useState<SharedChat[]>([]);
  const [stato, setStato] = useState<'carico' | 'pronto' | 'errore'>('carico');

  const carica = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/shared', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(String(r.status));
      const b = await r.json() as { tasks: SharedTask[]; topics: SharedChat[] };
      setTasks(b.tasks ?? []);
      setChats(b.topics ?? []);
      setStato('pronto');
    } catch {
      setStato('errore');
    }
  }, []);

  useEffect(() => { void carica(); }, [carica]);

  // Il socket è aperto e filtrato lato server: un aggiornamento su una risorsa
  // concessa arriva, tutto il resto non parte proprio. Qui basta riprendere
  // l'elenco quando qualcosa si muove.
  //
  // `auth-shares-changed` è quello che conta, e prima mancava: l'unico segnale
  // era un evento di PAIRING, quindi una cosa appena condivisa — o appena tolta
  // — restava invisibile finché non si premeva Ricarica. Sembrava latenza, era
  // un canale che non esisteva.
  useEffect(() => {
    const onChange = () => { void carica(); };
    window.addEventListener('topics:auth-shares-changed', onChange);
    window.addEventListener('topics:auth-pair-resolved', onChange);
    return () => {
      window.removeEventListener('topics:auth-shares-changed', onChange);
      window.removeEventListener('topics:auth-pair-resolved', onChange);
    };
  }, [carica]);

  const vuoto = stato === 'pronto' && tasks.length === 0 && chats.length === 0;

  return (
    // Come il cancello di pairing: superficie a schermo intero, piano
    // dichiarato dalla costante. `z-[9990]` era un numero scelto a occhio, e
    // per giunta SOTTO i popover (9999) — una vista ospite che si fa coprire
    // da un menu dell'app che non dovrebbe nemmeno esserci.
    <div className={`fixed inset-0 ${MODAL_LAYER} overflow-y-auto bg-app-bg`}>
      <header className="sticky top-0 flex items-center gap-2 border-b border-app-border bg-app-bg px-4 py-3">
        <span className="text-[15px] font-semibold text-app-text">Topics</span>
        <span className="rounded bg-app-hover px-1.5 py-px text-[10px] text-app-text-secondary">
          ospite · {deviceName}
        </span>
        <button
          onClick={() => void carica()}
          className="ml-auto rounded p-1 text-app-text-tertiary hover:bg-app-hover hover:text-app-text"
          aria-label="Ricarica"
        >
          <RefreshCw size={13} />
        </button>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-5">
        {stato === 'carico' && <p className="text-[13px] text-app-text-muted">Carico…</p>}

        {stato === 'errore' && (
          <p className="text-[13px] text-app-text-secondary">
            {tr('guest.error')}
          </p>
        )}

        {vuoto && (
          // Un elenco vuoto senza spiegazione si legge come «rotto». Qui si dice
          // che è normale, e di chi è la mossa successiva.
          <div className="rounded-xl border border-app-border bg-app-hover/30 px-4 py-5 text-center">
            <p className="text-[13px] text-app-text">{tr('guest.empty.title')}</p>
            <p className="mt-1 text-[12px] text-app-text-secondary">
              {tr('guest.empty.blurb')}
            </p>
          </div>
        )}

        {tasks.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-app-text-muted">
              <LayoutGrid size={11} /> {tr('guest.cards')}
            </h2>
            <ul className="space-y-1.5" data-testid="guest-tasks">
              {tasks.map((t) => (
                <li key={t.id} className="rounded-lg border border-app-border px-3 py-2.5">
                  <div className="text-[13px] leading-snug text-app-text">{t.text}</div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-app-text-muted">
                    {/* The guest is the one person here who is NOT a Topics
                        user: `in_progress` and a project slug are our
                        internals, and this is the only screen where they were
                        printed raw. Same two helpers the board card uses. */}
                    <span>{STATUS_LABEL[t.status as TaskStatus] ?? t.status}</span>
                    {t.project_id && !isProjectlessId(t.project_id) && <span>· {t.project_id}</span>}
                  </div>
                  {t.preview_image && (
                    // L'anteprima passa dal gate solo se è quella di un task
                    // concesso: il percorso è aperto, il contenuto no.
                    <img
                      src={`/media${t.preview_image.replace(/^.*\/\.topics\/media/, '')}`}
                      alt=""
                      className="mt-2 max-h-64 w-full rounded-md object-contain"
                      loading="lazy"
                    />
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {chats.length > 0 && (
          <section>
            <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-app-text-muted">
              <MessageSquare size={11} /> Chat
            </h2>
            <ul className="space-y-1.5" data-testid="guest-chats">
              {chats.map((c) => (
                <li key={c.id} className="rounded-lg border border-app-border px-3 py-2.5 text-[13px] text-app-text">
                  {c.name}
                </li>
              ))}
            </ul>
          </section>
        )}

        {stato === 'pronto' && !vuoto && (
          <p className="mt-6 text-center text-[11px] text-app-text-muted">
            {tr('guest.readOnly')}
          </p>
        )}
      </main>
    </div>
  );
}
