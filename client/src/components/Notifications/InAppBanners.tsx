/**
 * Il banner in pagina — la seconda delle due voci possibili ad app aperta.
 *
 * Lo alimenta SOLO il service worker (`lib/push/swBridge.ts`), quando la
 * preferenza del dispositivo è `in-app` e la finestra è visibile: in quel caso
 * la notifica di sistema non viene mostrata affatto, quindi questo è l'unico
 * posto in cui il segnale compare. Con la preferenza `native` questa lista resta
 * vuota per costruzione — non c'è nessun ramo che la riempie.
 */
import { useEffect } from 'react';
import { useT } from '../../hooks/useT';
import { Bell, X } from 'lucide-react';
import { useInAppBannerStore, IN_APP_BANNER_TTL_MS } from '../../state/inAppBanner';
import { openTaskInApp, openTopicInApp, selfTaskLinkTarget, selfTopicLinkTarget } from '../../lib/openTaskLink';
import { runNotificationAction } from '../../lib/notify/notificationAction';
import { boardNotificationDeps } from '../../lib/notify/boardActionDeps';

function openBannerTarget(url: string | undefined): void {
  if (!url) return;
  const absolute = url.startsWith('http') ? url : `${window.location.origin}${url}`;
  const task = selfTaskLinkTarget(absolute);
  if (task) { openTaskInApp(task); return; }
  const topic = selfTopicLinkTarget(absolute);
  if (topic) openTopicInApp(topic);
}

/**
 * Il task a cui appartiene questo banner, o null.
 *
 * È il pezzo che rende premibili i tasti: l'id del tasto codifica il VERBO
 * (`answer:<testo>`, `approve`, `requeue`), il task lo dice il deep-link. Senza
 * task non c'è nessuna chiamata da comporre, e i tasti non si disegnano proprio
 * — meglio nessun bottone che un bottone che non fa niente.
 */
function bannerTaskId(url: string | undefined): string | null {
  if (!url) return null;
  const absolute = url.startsWith('http') ? url : `${window.location.origin}${url}`;
  return selfTaskLinkTarget(absolute)?.taskId ?? null;
}

export function InAppBanners() {
  const tr = useT();
  const banners = useInAppBannerStore((s) => s.banners);
  const dismiss = useInAppBannerStore((s) => s.dismissInAppBanner);

  // Un timer PER banner, non uno globale: due segnali arrivati a mezzo secondo
  // di distanza devono sparire a mezzo secondo di distanza, non insieme.
  useEffect(() => {
    if (banners.length === 0) return;
    const timers = banners.map((b) => setTimeout(() => dismiss(b.id), IN_APP_BANNER_TTL_MS));
    return () => timers.forEach(clearTimeout);
  }, [banners, dismiss]);

  if (banners.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[9998] flex w-[320px] max-w-[calc(100vw-2rem)] flex-col gap-2"
      data-testid="in-app-banners"
    >
      {banners.map((b) => (
        <div
          key={b.id}
          data-testid="in-app-banner"
          className="rounded-xl border border-app-border bg-surface p-3 shadow-lg"
        >
          <div className="flex items-start gap-2">
            <Bell size={14} className="mt-0.5 shrink-0 text-app-text-secondary" />
            <button
              type="button"
              onClick={() => { openBannerTarget(b.url); dismiss(b.id); }}
              className="min-w-0 flex-1 text-left"
            >
              <div className="truncate text-[13px] font-medium text-app-text">{b.title}</div>
              {b.body && (
                <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-app-text-secondary">{b.body}</div>
              )}
            </button>
            <button
              type="button"
              onClick={() => dismiss(b.id)}
              title={tr('common.close')}
              className="shrink-0 rounded p-1 text-app-text-muted transition-colors hover:bg-app-hover hover:text-app-text"
            >
              <X size={13} />
            </button>
          </div>
          {(() => {
            // I tasti, quando la push ne porta. Come sulla notifica di sistema:
            // premerne uno ESEGUE e chiude — non apre il task, altrimenti
            // avresti fatto due gesti per uno. Il ripiego quando il server
            // rifiuta (offline, task uscito da review nel frattempo) è dentro
            // `runNotificationAction`, che apre il task: è lo stesso identico
            // esecutore del banner nativo, non un suo gemello.
            const taskId = bannerTaskId(b.url);
            if (!taskId || !b.actions?.length) return null;
            return (
              <div className="mt-2 flex flex-wrap gap-1.5 pl-[22px]" data-testid="in-app-banner-actions">
                {b.actions.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    data-action-id={a.id}
                    onClick={() => {
                      void runNotificationAction(taskId, a.id, boardNotificationDeps());
                      dismiss(b.id);
                    }}
                    className="rounded-md border border-app-border px-2 py-1 text-[11.5px] font-medium text-app-text transition-colors hover:bg-app-hover"
                  >
                    {a.title}
                  </button>
                ))}
              </div>
            );
          })()}
        </div>
      ))}
    </div>
  );
}
