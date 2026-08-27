// THE 12 UI CHECKS, MEASURED ON WINDOWS.
//
// Runs INSIDE Chrome on the Windows 11 box, not on the Mac: it is the only way
// to measure what actually differs on Windows — the modifier is `Ctrl` and its
// labels are wider than `⌘`, the system fonts are different, and the scrollbar
// takes up space instead of overlaying. A DOM measured on the Mac would say
// nothing about any of that.
//
// The bundle served on :8199 is rebuilt from commit 780779167, i.e.
// `tauri-v2.2.176`: the SAME code as the installed app, which however keeps it
// compiled inside app.exe and serves it from tauri://localhost, where nothing
// can reach it (the app is single-instance and the debug port cannot be opened
// after the fact without closing the user's window).
//
// SETUP, on the Windows box (both survive the ssh session only as scheduled
// tasks — started from ssh they die with it, measured):
//   schtasks /Create /TN topics-ui176-serve  ... srv.ps1         (bundle on :8199)
//   schtasks /Create /TN topics-ui176-chrome ... chromestart.ps1 (headless CDP :9333)
// then from the Mac:
//   ssh -f -N -L 9555:127.0.0.1:9333 -L 8199:127.0.0.1:8199 zorah@<host>
//   bun run tests/manual/run-ui12-windows.ts
//
// Returns JSON: { esito: "verde"|"rosso", prove: [...] }.
(async () => {
  const prove = [];
  const dice = (id, ok, misura) => prove.push({ id, ok, misura });
  const vis = (el) => el && el.offsetParent !== null;
  const rect = (el) => el.getBoundingClientRect();

  // Who actually receives a click at an element's centre. If it is somebody
  // else, that somebody covers it: exactly the defect where the notification
  // bell was pushed under the z-50 group and stopped being clickable.
  const chiRiceve = (el, selettore) => {
    const r = rect(el);
    const sopra = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (!sopra) return "nessuno";
    return sopra.closest(selettore) === el ? "lui" : (sopra.getAttribute("aria-label") || sopra.tagName);
  };

  await new Promise((r) => setTimeout(r, 4000));

  // 1. The React root mounted something.
  const root = document.getElementById("root");
  dice("UI-01 la radice monta", !!root && root.children.length > 0,
    `figli=${root ? root.children.length : 0}`);

  // 2. The notification bell receives its own click.
  const bell = document.querySelector('[data-testid="notification-bell"],[aria-label*="otific"]');
  dice("UI-02 campanella cliccabile", !!bell && chiRiceve(bell, '[data-testid="notification-bell"],[aria-label*="otific"]') === "lui",
    bell ? `larghezza=${Math.round(rect(bell).width)} riceve=${chiRiceve(bell, '[data-testid="notification-bell"],[aria-label*="otific"]')}` : "assente");

  // 3. The identity chip receives its own click (the resize handle covered it on
  //    EVERY platform, and no test had ever clicked it).
  const chip = document.querySelector('[data-testid="org-chip"],[data-testid="identity-chip"]');
  dice("UI-03 chip identita' cliccabile", !chip || chiRiceve(chip, '[data-testid="org-chip"],[data-testid="identity-chip"]') === "lui",
    chip ? `riceve=${chiRiceve(chip, '[data-testid="org-chip"],[data-testid="identity-chip"]')}` : "assente (non reso senza sessione)");

  // 4. No sidebar row overflows: this is the Ctrl+K defect, where the wider
  //    labels stole 37px from the 255px row.
  const dentro = Array.from(document.querySelectorAll("aside *,nav *"))
    .filter((e) => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1)
    .slice(0, 4).map((e) => `${e.className}:${e.scrollWidth}>${e.clientWidth}`);
  dice("UI-04 sidebar non trabocca", dentro.length === 0, dentro.join(" | ") || "nessun trabocco");

  // 5. No interactive element ends up off-screen.
  const fuori = Array.from(document.querySelectorAll("button,a[href],input"))
    .filter(vis).map((e) => ({ r: rect(e), t: e.getAttribute("aria-label") || e.tagName }))
    .filter(({ r }) => r.width > 0 && (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight))
    .slice(0, 4).map(({ t }) => t);
  dice("UI-05 niente fuori schermo", fuori.length === 0, fuori.join(", ") || "tutto dentro");

  // 6. The page does not scroll horizontally.
  const ox = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  dice("UI-06 niente scorrimento X", ox <= 1, `eccesso=${ox}px`);

  // 7. No text squashed to an unreadable height.
  const schiacciati = Array.from(document.querySelectorAll("button,span,div"))
    .filter((e) => vis(e) && (e.textContent || "").trim().length > 2)
    .filter((e) => { const r = rect(e); return r.height > 0 && r.height < 6; })
    .slice(0, 4).map((e) => (e.textContent || "").slice(0, 24));
  dice("UI-07 testo leggibile", schiacciati.length === 0, schiacciati.join(" | ") || "nessuna riga schiacciata");

  // 8. No click target smaller than 16px.
  //
  // Two exclusions, and both FIX A MISTAKE OF MINE rather than letting the app
  // off: the first version of this check went red on healthy things. `sr-only`
  // is 1x1 BY DESIGN — it is the "Skip to main content" jump, invisible until
  // the keyboard focuses it, and demanding it be large would demand it be
  // visible, the opposite of its purpose. And a 14px target WITH padding around
  // it obeys the real rule, which is about the clickable AREA: measure the
  // element plus its padding, not the icon alone.
  const areaCliccabile = (e) => {
    const r = rect(e);
    const st = getComputedStyle(e);
    const px = parseFloat(st.paddingLeft) + parseFloat(st.paddingRight);
    const py = parseFloat(st.paddingTop) + parseFloat(st.paddingBottom);
    return { w: r.width + px, h: r.height + py };
  };
  const minuscoli = Array.from(document.querySelectorAll("button,a[href]"))
    .filter(vis)
    .filter((e) => !e.className.includes("sr-only"))
    .map((e) => ({ a: areaCliccabile(e), t: e.getAttribute("aria-label") || (e.textContent || "").slice(0, 16) || "senza nome" }))
    .filter(({ a }) => a.w > 0 && (a.w < 16 || a.h < 16))
    .slice(0, 4).map(({ t, a }) => `${t}=${Math.round(a.w)}x${Math.round(a.h)}`);
  dice("UI-08 bersagli >= 16px", minuscoli.length === 0, minuscoli.join(", ") || "nessuno sotto misura");

  // 9. No two clickable elements overlap at each other's centre.
  const bottoni = Array.from(document.querySelectorAll("button")).filter(vis).slice(0, 60);
  const coperti = bottoni.filter((b) => rect(b).width > 8 && chiRiceve(b, "button") !== "lui")
    .slice(0, 4).map((b) => b.getAttribute("aria-label") || (b.textContent || "").slice(0, 16) || "senza nome");
  dice("UI-09 nessun bottone coperto", coperti.length === 0, coperti.join(", ") || `${bottoni.length} bottoni, nessuno coperto`);

  // 10. Shown shortcuts use THIS platform's modifier. On Windows that must be
  //     Ctrl: a ⌘ here would be text written for another machine, which is
  //     precisely the family of defects being hunted.
  const testo = document.body.innerText || "";
  const conCmd = /⌘/.test(testo);
  dice("UI-10 modificatore giusto", !conCmd, conCmd ? "compare ⌘ su Windows" : "nessun ⌘, coerente con Windows");

  // 11. No JavaScript error collected during load.
  dice("UI-11 nessun errore JS", (window.__erroriUI || []).length === 0,
    (window.__erroriUI || []).slice(0, 3).join(" | ") || "nessun errore");

  // 12. The images the shell loads are not broken.
  const rotte = Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0)
    .slice(0, 4).map((i) => i.getAttribute("src") || "senza src");
  dice("UI-12 nessuna immagine rotta", rotte.length === 0, rotte.join(", ") || `${document.images.length} immagini, nessuna rotta`);

  const rossi = prove.filter((p) => !p.ok);
  return JSON.stringify({
    esito: rossi.length === 0 ? "verde" : "rosso",
    viewport: `${innerWidth}x${innerHeight}`,
    piattaforma: navigator.platform,
    verdi: prove.length - rossi.length,
    totale: prove.length,
    prove,
  }, null, 1);
})()
