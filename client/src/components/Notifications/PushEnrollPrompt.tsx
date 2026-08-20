/**
 * L'invito a iscriversi, al momento in cui ha senso.
 *
 * Compare DOPO che hai mandato un messaggio a un agente — cioè dopo aver creato
 * un'attesa — e dice cosa riceverai, non «Topics vorrebbe inviarti notifiche».
 * Non compare al primo avvio: lì si nega per riflesso, e su iOS un permesso
 * negato non si riapre più da dentro l'app.
 *
 * Si mostra solo dove premerlo non è una bugia: `canSubscribe` di
 * `describePushState` esclude il permesso già negato, l'iPhone senza PWA
 * installata, i browser senza push e il guscio desktop (che ha i suoi banner
 * nativi). Un «non ora» vale per sempre su questo dispositivo — chiedere due
 * volte è il modo più rapido di trasformarlo in un no di sistema.
 */
import { BellRing, X } from 'lucide-react';
import { useT } from '@/hooks/useT';
import { usePushAskStore, shouldOfferPush } from '../../state/pushAsk';
import { usePushNotifications } from '../../hooks/usePushNotifications';

export function PushEnrollPrompt() {
  const tr = useT();
  const armed = usePushAskStore((s) => s.armed);
  const declined = usePushAskStore((s) => s.declined);
  const decline = usePushAskStore((s) => s.declinePushAsk);
  const disarm = usePushAskStore((s) => s.disarmPushAsk);
  const { status, loading, subscribe } = usePushNotifications();

  if (!shouldOfferPush({ armed, declined, canSubscribe: status.canSubscribe })) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[9997] w-[320px] max-w-[calc(100vw-2rem)] rounded-xl border border-app-border bg-surface p-3 shadow-lg"
      data-testid="push-enroll-prompt"
    >
      <div className="flex items-start gap-2">
        <BellRing size={14} className="mt-0.5 shrink-0 text-app-text-secondary" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-app-text">{tr('push.prompt.title')}</div>
          <p className="mt-0.5 text-[11.5px] leading-snug text-app-text-secondary">
            {tr('push.prompt.blurb')}
          </p>
        </div>
        <button
          type="button"
          onClick={decline}
          title={tr('common.notNow')}
          className="shrink-0 rounded p-1 text-app-text-muted transition-colors hover:bg-app-hover hover:text-app-text"
        >
          <X size={13} />
        </button>
      </div>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={decline}
          className="flex-1 rounded-lg border border-app-border px-3 py-1.5 text-[12px] text-app-text hover:bg-app-bg"
        >
          {tr('common.notNow')}
        </button>
        <button
          type="button"
          disabled={loading}
          onClick={() => { void subscribe().then(() => disarm()); }}
          data-testid="push-enroll-accept"
          className="flex-1 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          Avvisami
        </button>
      </div>
    </div>
  );
}
