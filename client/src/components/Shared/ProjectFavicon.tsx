import { useEffect, useState, type ReactNode } from 'react';
import { reportImgError, useProjectIcon } from './projectIconStore';

/**
 * ProjectFavicon — shows a project's real icon when its folder ships one
 * (favicon.*, public/icon.*, a web manifest's icons[], an index.html
 * <link rel="icon"> — file or inline data: URI — or a loosely-named logo),
 * resolved + served by GET /api/projects/icon.
 *
 * Projects WITHOUT a real icon render `fallback` (default: NOTHING — no
 * element, no reserved width, zero horizontal footprint). This is a hard
 * product decision (Attilio, 2026-07-16, reconfirmed after a monogram-tile
 * experiment was rejected): only a REAL shipped icon earns the space; no
 * letters, no generated tiles, no generic glyphs. Don't reintroduce synthetic
 * placeholders here.
 *
 * La risoluzione (cache, sonda single-flight, recupero via blob) vive in
 * `projectIconStore.ts`: una sola sonda per path, condivisa da ogni superficie.
 */
export function ProjectFavicon({
  path,
  size = 14,
  width,
  className = '',
  fallback = null,
}: {
  path: string;
  /** L'ALTEZZA della scatola. Quadrata se `width` non è dato. */
  size?: number;
  /**
   * Una scatola più LARGA che alta, per le superfici che devono poter mostrare
   * anche un logo-scritta.
   *
   * Serve perché `object-contain` in un quadrato scala per il lato vincolante:
   * un wordmark 3235×1224 in 12×12 diventa 12px di inchiostro alto **4,5**, cioè
   * una scheggia che si legge come «l'icona non c'è». In 20×12 lo stesso logo
   * rende 20×7,6, che si vede. Il prezzo lo pagano anche i loghi quadrati, che
   * restano 12×12 centrati in 20 con 4px di aria per lato: è il prezzo di una
   * scatola DICHIARATA, e l'alternativa — dedurre la larghezza dal rapporto
   * d'aspetto dell'immagine — farebbe dipendere il layout da una risposta di
   * rete, che in questo repo è la regola che si paga più cara.
   */
  width?: number;
  className?: string;
  /** Rendered when the project has no icon file. Default null = nothing at
   *  all (zero footprint); pass a custom node (e.g. a status dot) to opt in. */
  fallback?: ReactNode;
}) {
  const { status, src } = useProjectIcon(path);
  const [loaded, setLoaded] = useState(false);
  // Reset the decode gate whenever the effective src changes (endpoint → blob
  // recovery, or a recycled row pointing at a new project), so a stale
  // opacity:1 never paints a half-loaded frame.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot gate reset per src change; converges immediately (deps = [src])
  useEffect(() => { setLoaded(false); }, [src]);

  // No path, icon-less, or still probing → render the fallback (or, while
  // probing, nothing): no element, no reserved width, zero footprint. The
  // store flips every subscribed surface to 'has' the moment the probe lands.
  if (!path || status === 'none') return <>{fallback}</>;
  if (status === 'probing' || !src) return null;

  return (
    <img
      src={src}
      width={width ?? size}
      height={size}
      alt=""
      draggable={false}
      className={`rounded-[3px] object-contain flex-shrink-0 ${className}`}
      style={{
        // LA SCATOLA VA IMPOSTA DALLO STILE, non dagli attributi.
        //
        // Gli attributi `width`/`height` qui sopra dichiarano solo il rapporto
        // d'aspetto: il preflight di Tailwind mette `img { height: auto }`, che
        // li scavalca. Senza queste due righe la scatola COLLASSAVA sul rapporto
        // d'aspetto dell'immagine — misurato l'08/08: `edm-contratto`
        // (3235×1224) usciva 18 di larghezza per 6,8 di altezza.
        //
        // Attenzione, perché è una distinzione che mi sono già giocato una volta:
        // imporre la scatola risolve il LAYOUT (lo slot resta della misura
        // dichiarata, niente si sposta quando l'immagine atterra) e NON risolve
        // la leggibilità. `object-contain` scala per il lato vincolante, quindi
        // in un quadrato da 12 quello stesso logo resta 12×4,5 di inchiostro: la
        // scheggia è la stessa di prima, solo centrata. Per vederlo serve una
        // scatola più larga che alta — vedi `width`.
        width: width ?? size,
        height: size,
        // The probe already confirmed the icon exists, so the slot is
        // reserved up-front (no layout shift); opacity-until-decode hides the
        // broken-glyph frame an erroring <img> would paint.
        opacity: loaded ? 1 : 0,
      }}
      onLoad={() => setLoaded(true)}
      onError={() => { setLoaded(false); reportImgError(path, src); }}
    />
  );
}
