import { useEffect, useState } from 'react';
import { Cookie, Database, HardDrive } from 'lucide-react';
import { ConfirmDialog } from '../Shared/ConfirmDialog';
import { planForgetSite, forgetSite, type ForgetSitePlan, type SiteDataGroup } from '../../lib/browserForgetSite';

/**
 * Il dialogo di «Dimentica questo sito»: prima l'elenco, poi il tasto.
 *
 * Il vincolo che questo componente esiste per rispettare è uno solo, e viene
 * dall'umano: il comando dice COSA cancella prima di farlo. Quindi il tasto
 * rosso resta spento finché la lista non è arrivata dal nativo, e la lista non
 * è una promessa generica ma i nomi veri dei silo WebKit che spariranno.
 *
 * I nomi contano perché non coincidono con la barra degli indirizzi: WebKit
 * tiene un silo per dominio registrabile, quindi «dimentica mail.google.com»
 * porta via tutto google.com. Detto prima è una scelta informata; scoperto
 * dopo è un dato perso.
 *
 * Vive nella pane e non nel menu: il popover si chiude al clic, e un dialogo
 * figlio di un popover si chiuderebbe con lui.
 */
export interface ForgetSiteDialogProps {
  contextId: string;
  /** L'url aperto. Da qui esce l'host, e senza host non c'è niente da fare. */
  url: string;
  onClose: () => void;
  /** Dopo la cancellazione: la pagina va ricaricata, o mostra uno stato che
   *  sul disco non esiste più (loggato in una tab che non ha più cookie). */
  onForgotten: () => void;
}

const GROUP_ICON: Record<SiteDataGroup, typeof Cookie> = {
  session: Cookie,
  storage: Database,
  cache: HardDrive,
};

export function ForgetSiteDialog({ contextId, url, onClose, onForgotten }: ForgetSiteDialogProps) {
  const [plan, setPlan] = useState<ForgetSitePlan | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void planForgetSite(contextId, url).then((p) => {
      if (!alive) return;
      // Niente host = niente sito da dimenticare: si chiude invece di aprire un
      // dialogo su nulla.
      if (!p) onClose();
      else setPlan(p);
    });
    return () => { alive = false; };
  }, [contextId, url, onClose]);

  const nothing = !!plan && plan.displayNames.length === 0;

  const confirm = () => {
    if (!plan || nothing || busy) return;
    setBusy(true);
    void forgetSite(contextId, plan.displayNames)
      .catch(() => 0)
      .then(() => { onForgotten(); onClose(); });
  };

  return (
    <ConfirmDialog
      title={plan ? `Dimentica ${plan.host}?` : 'Dimentica questo sito?'}
      confirmLabel={busy ? 'Cancello…' : 'Dimentica'}
      cancelLabel={nothing ? 'Chiudi' : 'Annulla'}
      confirmDisabled={!plan || nothing || busy}
      onConfirm={confirm}
      onCancel={busy ? () => {} : onClose}
    >
      <div data-testid="forget-site-dialog">
        {!plan && <p>Leggo cosa c'è salvato per questo sito…</p>}
        {nothing && <p>Per questo sito non c'è niente di salvato in questa tab.</p>}
        {plan && !nothing && (
          <>
            <p className="mb-2">Da questa tab del browser vengono cancellati:</p>
            <ul className="space-y-1.5 mb-3">
              {plan.items.map((item) => {
                const Icon = GROUP_ICON[item.group];
                return (
                  <li key={item.group} className="flex items-start gap-2" data-testid={`forget-site-item-${item.group}`}>
                    <Icon size={13} className="shrink-0 mt-0.5 text-app-text-tertiary" aria-hidden />
                    <span>
                      <span className="text-app-text-heading">{item.label}</span>{' '}
                      <span className="text-app-text-muted">{item.detail}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
            {/* I nomi dei silo, non l'host: è qui che si vede che dimenticare
                la posta dimentica anche il resto del dominio. */}
            <p className="text-app-text-muted">
              Vale per i dati salvati sotto{' '}
              <span className="font-mono text-app-text-body">{plan.displayNames.join(', ')}</span>, sottodomini
              compresi. Le altre tab e gli altri siti non si toccano.
            </p>
            <p className="text-app-text-muted mt-1">Non si può annullare.</p>
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}
