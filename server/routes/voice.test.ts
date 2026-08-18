import { describe, it, expect } from "bun:test";
import { createVoiceRouter } from "./voice";

/**
 * Il router della voce, sul pezzo che serve a diagnosticare.
 *
 * Non prova la trascrizione (vuole un provider vero): prova la SEGNALAZIONE
 * della nota vuota, che e' l'unico modo che il server ha di sapere di un guasto
 * che succede prima della richiesta.
 */
/** Il contesto vero passa `json`/`readJSON`: qui bastano quelli. */
const router = createVoiceRouter(
  {
    json: (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
  } as never,
  { env: {} },
);

describe("la nota vocale VUOTA si registra sul server", () => {
  // Il difetto «il vocale non parte sul telefono» e' rimasto senza diagnosi
  // perche' il guasto succede PRIMA della richiesta di trascrizione: misurato
  // su 300 avvii, 27 richieste di capabilities e ZERO caricamenti di audio.
  // Quell'assenza non lasciava traccia da nessuna parte.
  const chiama = (body: unknown) =>
    router(
      new Request("http://x/api/stt/vuota", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "iPhone" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      new URL("http://x/api/stt/vuota"),
      "/api/stt/vuota",
      "POST",
    );

  it("accetta la segnalazione e scrive i due numeri che distinguono i due guasti", async () => {
    const righe: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => righe.push(m);
    try {
      const r = await chiama({ spezzoni: 0, byte: 0, mimeType: "audio/mp4", superficie: "dettatura" });
      expect(r?.status).toBe(200);
    } finally { console.warn = orig; }
    expect(righe.join(" ")).toContain("0 spezzoni");
    expect(righe.join(" ")).toContain("0 byte");
    expect(righe.join(" ")).toContain("audio/mp4");
    expect(righe.join(" ")).toContain("dettatura");
  });

  it("un corpo storto si registra lo stesso: una segnalazione persa e' il guasto che voleva togliere", async () => {
    const righe: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => righe.push(m);
    try {
      const r = await chiama("{non json");
      expect(r?.status).toBe(200);
    } finally { console.warn = orig; }
    expect(righe.join(" ")).toContain("-1 spezzoni");
  });

  it("non si fida di cio' che arriva: numeri finti e stringhe lunghe non entrano nel log", async () => {
    const righe: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => righe.push(m);
    try {
      await chiama({ spezzoni: "molti", byte: Number.NaN, mimeType: "x".repeat(500), superficie: 42 });
    } finally { console.warn = orig; }
    const riga = righe.join(" ");
    expect(riga).toContain("-1 spezzoni");
    expect(riga).toContain("-1 byte");
    expect(riga).toContain("mime ?");
    expect(riga).toContain("superficie ?");
  });
});
