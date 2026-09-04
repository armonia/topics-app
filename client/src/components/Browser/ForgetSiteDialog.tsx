import { useEffect, useState } from 'react';
import { useT } from '../../hooks/useT';
import { Cookie, Database, HardDrive } from 'lucide-react';
import { ConfirmDialog } from '../Shared/ConfirmDialog';
import { planForgetSite, forgetSite, type ForgetSitePlan, type SiteDataBackend, type SiteDataGroup } from '../../lib/browserForgetSite';

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
 *
 * Lo stesso componente serve la pane NATIVA e quella CONDIVISA: cambia solo il
 * `backend` che gli passa i silo. La differenza si vede da sé nell'elenco (sul
 * condiviso la riga «Cache» non compare mai, perché lì la cache non è per-sito
 * e non la si cancella), e non va scritta due volte in due dialoghi gemelli.
 */
export interface ForgetSiteDialogProps {
  contextId: string;
  /** L'url aperto. Da qui esce l'host, e senza host non c'è niente da fare. */
  url: string;
  /** Chi tiene i dati di QUESTA pane: `nativeSiteData()` o `sharedSiteData()`. */
  backend: SiteDataBackend;
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

export function ForgetSiteDialog({ contextId, url, backend, onClose, onForgotten }: ForgetSiteDialogProps) {
  const tr = useT();
  const [plan, setPlan] = useState<ForgetSitePlan | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void planForgetSite(contextId, url, backend).then((p) => {
      if (!alive) return;
      // Niente host = niente sito da dimenticare: si chiude invece di aprire un
      // dialogo su nulla.
      if (!p) onClose();
      else setPlan(p);
    });
    return () => { alive = false; };
  }, [contextId, url, backend, onClose]);

  const unsupported = !!plan && !plan.supported;
  const nothing = !!plan && plan.supported && plan.displayNames.length === 0;
  const blocked = !plan || nothing || unsupported || busy;

  const confirm = () => {
    if (blocked || !plan) return;
    setBusy(true);
    void forgetSite(contextId, plan.displayNames, backend)
      .catch(() => 0)
      .then(() => { onForgotten(); onClose(); });
  };

  return (
    <ConfirmDialog
      title={plan ? tr('forget.titleHost', { host: plan.host }) : tr('forget.title')}
      confirmLabel={busy ? tr('forget.working') : tr('forget.action')}
      cancelLabel={nothing || unsupported ? tr('common.close') : tr('common.cancel')}
      confirmDisabled={blocked}
      onConfirm={confirm}
      onCancel={busy ? () => {} : onClose}
    >
      <div data-testid="forget-site-dialog">
        {!plan && <p>{tr('forget.loading')}</p>}
        {/* Motore esterno: i dati stanno nel profilo di quel Chromium, e da qui
            non si toccano. Dirlo è l'unica risposta onesta; elencare zero
            record farebbe credere che il sito non abbia salvato niente. */}
        {unsupported && (
          <p data-testid="forget-site-unsupported">
            {tr('forget.unsupported')}
          </p>
        )}
        {nothing && <p>{tr('forget.nothing')}</p>}
        {plan && !nothing && !unsupported && (
          <>
            <p className="mb-2">{tr('forget.listIntro')}</p>
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
              {tr('forget.scopePrefix')}{' '}
              <span className="font-mono text-app-text-body">{plan.displayNames.join(', ')}</span>{tr('forget.scopeSuffix')}
            </p>
            <p className="text-app-text-muted mt-1">{tr('forget.noUndo')}</p>
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}
