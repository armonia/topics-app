// La BARRA: nessun file caricato da qualcun altro puo' RENDERSI sull'origine
// della app.
//
// Il difetto misurato: `/uploads/` decideva con
// `/^(image|video|audio)\//.test(mime)`, e `image/svg+xml` passa quel test. Un
// SVG e' un documento — navigato direttamente esegue il suo `<script>` con la
// sessione dentro — e `X-Content-Type-Options: nosniff` non c'entra nulla:
// vieta di INDOVINARE un tipo, e qui il tipo dichiarato e' gia' quello attivo.
//
// Il test esegue la decisione vera (la funzione che la rotta chiama), non cerca
// una sottostringa nel sorgente: `getMimeType` mappa davvero `svg` su
// `image/svg+xml`, e quel valore entra qui dalla stessa porta da cui entra in
// produzione.
import { test, expect, describe } from "bun:test";
import {
  ACTIVE_CONTENT_MIMES,
  isActiveContent,
  isInlineSafe,
  normalizeMime,
  servedFileHeaders,
} from "../../server/lib/served-file-headers";

const upload = (mime: string, filename = "x") =>
  servedFileHeaders({ mime, filename, cacheControl: "public, max-age=3600" });

describe("un upload attivo non si rende in linea", () => {
  // Il verso in cui il difetto si vedeva: `image/svg+xml` inline, tipo
  // dichiarato intatto, nessun sandbox.
  test("image/svg+xml scende come allegato, senza il suo tipo e in sandbox", () => {
    const h = upload("image/svg+xml", "payload.svg");
    expect(h["Content-Disposition"]).toBe('attachment; filename="payload.svg"');
    expect(h["Content-Type"]).toBe("application/octet-stream");
    expect(h["Content-Security-Policy"]).toBe("sandbox");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
  });

  test("il predicato `^image/` da solo lo ammetterebbe: e' il difetto, inchiodato", () => {
    // La riga che c'era prima, verbatim. Se un giorno tornasse, questo test dice
    // esattamente perche' e' sbagliata.
    const vecchio = (m: string) => /^(image|video|audio)\//.test(m) || m === "application/pdf";
    expect(vecchio("image/svg+xml")).toBe(true);
    expect(isInlineSafe("image/svg+xml")).toBe(false);
  });

  test("ogni tipo attivo perde inline, tipo e origine", () => {
    for (const mime of ACTIVE_CONTENT_MIMES) {
      const h = upload(mime, `f.${mime.replace(/\W/g, "")}`);
      expect(h["Content-Disposition"]).toStartWith("attachment;");
      expect(h["Content-Type"]).toBe("application/octet-stream");
      expect(h["Content-Security-Policy"]).toBe("sandbox");
    }
  });

  test("i parametri del MIME non aprono una porta di servizio", () => {
    // `text/html;charset=utf-8` e' la forma che Bun produce da `formData()`: una
    // lista confrontata sulla stringa grezza ha un buco esattamente li'.
    expect(normalizeMime("Text/HTML; charset=utf-8")).toBe("text/html");
    expect(isActiveContent("Image/SVG+XML ; charset=utf-8")).toBe(true);
    expect(upload("text/html;charset=utf-8")["Content-Type"]).toBe("application/octet-stream");
  });
});

describe("cio' che si guarda in chat continua a guardarsi", () => {
  test.each([
    ["image/png", "inline"],
    ["image/jpeg", "inline"],
    ["video/mp4", "inline"],
    ["audio/mpeg", "inline"],
    ["application/pdf", "inline"],
  ])("%s resta inline", (mime, expected) => {
    const h = upload(mime, "a.bin");
    expect(h["Content-Disposition"]).toBe(expected);
    expect(h["Content-Type"]).toBe(mime);
    expect(h["Content-Security-Policy"]).toBeUndefined();
  });

  test("un tipo sconosciuto si scarica, non viene rifiutato", () => {
    // Deny list e non allow list: un allegato che nessuno aveva previsto deve
    // arrivare a destinazione come file, non come 400.
    const h = upload("application/octet-stream", "senza-estensione");
    expect(h["Content-Disposition"]).toBe('attachment; filename="senza-estensione"');
    expect(h["Content-Type"]).toBe("application/octet-stream");
  });

  test("il nome non esce dalle virgolette", () => {
    const h = upload("application/zip", 'a".evil\r\n.zip');
    expect(h["Content-Disposition"]).toBe('attachment; filename="a_.evil__.zip"');
  });
});
