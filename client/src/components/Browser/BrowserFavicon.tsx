/**
 * Lo slot dell'icona a sinistra dell'indirizzo. Non è mai vuoto.
 *
 * Due proprietà, ed è per averle entrambe che è un componente invece di una
 * `<img>` condizionale nella toolbar:
 *
 *  1. LARGHEZZA FISSA. Lo slot occupa gli stessi 14px che il sito abbia
 *     un'icona o no, quindi la barra dell'indirizzo non si sposta quando la
 *     favicon arriva a caricamento finito (o non arriva mai).
 *  2. NIENTE QUADRATO VUOTO. Se l'icona manca, fallisce o è ancora in volo,
 *     al suo posto va il segnaposto di `faviconPlaceholder`: il monogramma del
 *     dominio su pastiglia in tinta deterministica, o il globo per gli
 *     indirizzi che un dominio non ce l'hanno.
 *
 * La `<img>` non viene smontata quando fallisce: viene NASCOSTA e il segnaposto
 * disegnato sotto. Smontarla vorrebbe dire che un `onError` tardivo (favicon
 * 404 servita lentamente) arriverebbe su un nodo che non c'è più.
 */
import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { faviconPlaceholder, faviconPlaceholderColor } from './faviconPlaceholder';

export function BrowserFavicon({
  url,
  faviconUrl,
  size = 14,
  className = '',
}: {
  /** L'indirizzo corrente: da qui esce il monogramma del segnaposto. */
  url: string;
  /** L'icona dichiarata dalla pagina. Vuota durante la navigazione. */
  faviconUrl?: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  // Indirizzo nuovo, icona nuova: l'errore si azzera. Converge subito (torna a
  // una costante) e non può rimbalzare, perché `faviconUrl` non deriva da qui.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- sincronizza il flag locale sulla prop; assegna una costante, quindi non può ciclare
  useEffect(() => { setFailed(false); }, [faviconUrl]);

  const showImg = !!faviconUrl && !failed;
  const ph = faviconPlaceholder(url);
  const box = { width: size, height: size };

  return (
    <span
      className={`relative inline-flex items-center justify-center flex-shrink-0 ${className}`}
      style={box}
      data-testid="browser-favicon-slot"
      aria-hidden
    >
      {!showImg && (ph.kind === 'monogram' ? (
        <span
          className="flex items-center justify-center rounded-[3px] font-semibold text-white select-none"
          style={{
            ...box,
            backgroundColor: faviconPlaceholderColor(ph.hue),
            fontSize: Math.round(size * 0.64),
            lineHeight: 1,
          }}
          data-testid="browser-favicon-monogram"
          title={ph.host}
        >
          {ph.letter}
        </span>
      ) : (
        <Globe size={size} className="text-app-text-faint" data-testid="browser-favicon-globe" />
      ))}
      {faviconUrl && (
        <img
          src={faviconUrl}
          alt=""
          className={`absolute inset-0 object-contain ${showImg ? '' : 'opacity-0'}`}
          style={box}
          onError={() => setFailed(true)}
          data-testid="browser-favicon"
        />
      )}
    </span>
  );
}
