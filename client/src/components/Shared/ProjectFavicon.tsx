import { useCallback, useState, type ReactNode } from 'react';
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

  /**
   * IL CANCELLO DELL'OPACITÀ NON PUÒ ESSERE UN EVENTO.
   *
   * Era `loaded: boolean` acceso da `onLoad` e rimesso a `false` da un effetto a
   * ogni cambio di `src`. Due difetti che si sommano, e insieme fanno
   * un'immagine SCARICATA e INVISIBILE:
   *
   *  1. un `<img>` servito dalla cache può essere già `complete` quando React
   *     attacca il gestore: `load` è **già stato emesso**, non tornerà, e
   *     l'opacità resta a 0 per sempre;
   *  2. l'effetto di reset è PASSIVO, quindi gira DOPO l'aggancio delle ref e
   *     dopo il commit — richiudeva anche i casi in cui il punto 1 non era
   *     scattato.
   *
   * Misurato il 08/08 sul server vivo, tre ricarichi di fila: in WebKit al
   * secondo giro `topics-app` aveva `complete: true`, `naturalWidth: 512` e
   * `opacity: 0`; in Chromium succedeva al terzo, su ENTRAMBE le pastiglie. È il
   * «da app desktop le vedo ma da PWA no… tutte, e a volte tornano»: non è un
   * browser, è una corsa, e il telefono la perde più spesso perché la sua cache
   * è più calda.
   *
   * Adesso non c'è nessun booleano da rimettere a posto: si ricorda QUALE src è
   * atterrato, e `loaded` è una derivazione. Cambiare src rende `loaded` falso
   * da sé — nessun effetto, nessuna finestra in cui lo stato contraddice il DOM.
   */
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const loaded = !!src && loadedSrc === src;

  /**
   * `decode()` invece di aspettare `load`: la promessa si risolve anche per
   * un'immagine GIÀ completa (è la domanda «sei disegnabile?», non «sei appena
   * arrivata?»), e copre pure gli SVG con il solo `viewBox`, per cui
   * `naturalWidth` vale 0 e un controllo su quello non basterebbe. Un rifiuto si
   * ignora: a quel caso pensa `onError`, che è anche l'unico che sa avviare il
   * recupero via blob.
   *
   * Sta in una ref-funzione con `src` fra le dipendenze, non in un effetto: così
   * React la richiama a ogni aggancio E a ogni cambio di sorgente, e la domanda
   * viene fatta quando il nodo esiste davvero. `onLoad` resta come corsia
   * normale — costa niente e arriva prima nel caso freddo.
   */
  const measure = useCallback((el: HTMLImageElement | null) => {
    if (!el || !src) return;
    el.decode().then(() => setLoadedSrc(src)).catch(() => {});
  }, [src]);

  // No path, icon-less, or still probing → render the fallback (or, while
  // probing, nothing): no element, no reserved width, zero footprint. The
  // store flips every subscribed surface to 'has' the moment the probe lands.
  if (!path || status === 'none') return <>{fallback}</>;
  if (status === 'probing' || !src) return null;

  return (
    <img
      ref={measure}
      src={src}
      width={width ?? size}
      height={size}
      alt=""
      draggable={false}
      // A project icon never decides a layout (the slot is reserved before it
      // lands): it must not take a connection from the chat history at boot.
      fetchPriority="low"
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
        // La sonda ha già confermato che l'icona esiste, quindi lo slot è
        // prenotato da subito (niente salto di layout); l'opacità nasconde il
        // fotogramma col glifo rotto che un <img> in errore dipingerebbe.
        // Chi la accende è `measure`/`onLoad` qui sopra — MAI il solo `onLoad`.
        opacity: loaded ? 1 : 0,
      }}
      onLoad={() => setLoadedSrc(src)}
      onError={() => { setLoadedSrc(null); reportImgError(path, src); }}
    />
  );
}
