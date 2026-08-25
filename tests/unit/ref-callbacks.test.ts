/**
 * Il cancello sul crash della raffica, provato nei due versi.
 *
 * Il valore di questo cancello sta tutto nella precisione: deve prendere la
 * forma che ha rotto la pane (callback ref inline + setState) e NON quella
 * corretta che il repo usa in otto punti (callback ref inline che scrive solo
 * in un ref). Un cancello che le confonde chiede di riscrivere codice sano, e
 * un cancello cosi' si spegne entro la settimana — e' gia' scritto nella
 * baseline di `check:bloat`.
  * @covers RUNTIME-13
 */
import { describe, it, expect } from "bun:test";
import { findInlineRefSetters } from "../../scripts/check-ref-callbacks";

/** La forma ESATTA di MessageList.tsx prima di `39001fa9`. */
const IL_CRASH = `
  <Virtuoso
    scrollerRef={(ref) => {
      const el = (ref as HTMLElement | null) ?? null;
      scrollerElRef.current = el;
      setScrollerEl((prev) => (prev === el ? prev : el));
    }}
  />`;

describe("check:ref-callbacks — la forma che ha rotto la pane", () => {
  it("prende la callback ref inline che chiama un setter di stato", () => {
    const hits = findInlineRefSetters(IL_CRASH);
    expect(hits.length).toBe(1);
    expect(hits[0].attr).toBe("scrollerRef");
  });

  it("prende anche `ref=` normale, non solo `scrollerRef`", () => {
    // Il difetto e' della callback ref in generale: React tratta allo stesso
    // modo l'identita' che cambia su `ref` e su qualunque prop che consegna un
    // elemento.
    const src = `<div ref={(el) => { setNode(el); }} />`;
    expect(findInlineRefSetters(src).length).toBe(1);
  });

  it("NON prende una callback ref che scrive solo in un ref", () => {
    // Il repo ne ha otto, sono corrette: la doppia invocazione scrive due volte
    // lo stesso valore e finisce li'. Vietarle sarebbe lavoro senza un difetto.
    const src = `<div ref={(n) => { slotRefs.current[0] = n; }} className="flex" />`;
    expect(findInlineRefSetters(src)).toEqual([]);
  });

  it("NON prende un `setX` che il file dichiara come funzione sua", () => {
    // `MessageContent.tsx` ha `const setRef = useCallback(...)` che scrive in
    // una Map dentro un ref: si CHIAMA come un setter e non lo e'. Il primo
    // giro di questo cancello lo segnalava, e sarebbe stato un falso positivo
    // su codice corretto.
    const src = `
      const setRef = useCallback((idx, handle) => { diffRefs.current.set(idx, handle); }, []);
      return <DiffBlock ref={(handle) => setRef(i, handle)} />;`;
    expect(findInlineRefSetters(src)).toEqual([]);
  });

  it("NON prende una callback ref gia' estratta in useCallback", () => {
    // E' il rimedio: identita' stabile, React la invoca solo quando il NODO
    // cambia davvero. Segnalarla vorrebbe dire chiedere di disfare il fix.
    const src = `<Virtuoso scrollerRef={scrollerRef} />`;
    expect(findInlineRefSetters(src)).toEqual([]);
  });

  it("legge il corpo su PIU' RIGHE, che e' come il difetto si scrive davvero", () => {
    // Un grep riga-per-riga vedrebbe solo `ref={(el) => {` e si perderebbe il
    // setState due righe sotto: cioe' si perderebbe esattamente il caso reale.
    const src = `
      <div
        ref={(el) => {
          // un commento in mezzo
          qualcosa.current = el;
          setStato(el);
        }}
      />`;
    expect(findInlineRefSetters(src).length).toBe(1);
  });

  it("il file che aveva il difetto oggi e' pulito", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(import.meta.dir, "../../client/src/components/Chat/MessageList.tsx"),
      "utf8",
    );
    expect(findInlineRefSetters(src, "MessageList.tsx")).toEqual([]);
  });
});
