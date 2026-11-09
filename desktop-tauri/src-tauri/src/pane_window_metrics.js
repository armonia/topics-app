(function () {
  // Un WKWebView figlio non ha una finestra sua: `outerWidth` e `outerHeight`
  // tornano 0. Nessun browser vero lo fa (fuori è sempre >= dentro), ed è il
  // segnale per cui l'anti-bot di Hetzner (Heray) rifiuta la prova di lavoro e
  // rimanda alla stessa pagina «Security Check» in ciclo. Misurato il 09/11:
  // Playwright WebKit passa in 3-4 s e fallisce con la sola coppia
  // outerWidth/outerHeight a 0, senza toccare altro.
  // La pagina vede il valore vero quando è già plausibile, e quello interno
  // quando non lo è: mai un numero inventato più piccolo dell'area visibile.
  if (window.__topicsOuterMetrics) return;
  window.__topicsOuterMetrics = true;
  function patch(outer, inner) {
    try {
      var d = Object.getOwnPropertyDescriptor(window, outer);
      var read = d && d.get ? function () { return d.get.call(window); } : function () { return d ? d.value : 0; };
      var getter = function () {
        var v = Number(read());
        var i = Number(window[inner]);
        return v >= i ? v : i;
      };
      Object.defineProperty(window, outer, {
        configurable: true,
        enumerable: d ? d.enumerable : true,
        get: getter,
        // [Replaceable] nello standard: la pagina può sovrascriverlo.
        set: d && d.set ? function (x) { d.set.call(window, x); } : undefined,
      });
    } catch (e) {}
  }
  patch('outerWidth', 'innerWidth');
  patch('outerHeight', 'innerHeight');
})();
