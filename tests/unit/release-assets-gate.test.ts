/**
 * IL CANCELLO DEL PUBLISH: dodici asset, non tre exit code.
 *
 * Il caso che ha aperto questo lavoro non e' ipotetico ed e' gia' costato una
 * release: tauri-v2.2.131, dodici asset su dodici caricati, poi un
 * `##[error]Server Error` dell'API di GitHub undici secondi DOPO l'ultimo
 * upload riuscito. Il job Windows e' uscito non-zero, `publish` e' stato
 * saltato per `needs:`, e una build completa su tre OS e' rimasta draft per
 * sempre.
 *
 * Questo file prova le DUE direzioni, perche' una sola non dice niente:
 *  - una release completa si pubblica ANCHE se un build e' rosso (il recupero);
 *  - una release a cui manca un pezzo NON si pubblica (la protezione che
 *    esisteva prima e che non va persa nel cambio).
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ASSET_SUFFIXES, assetVerdict, isUpdaterManifestMissing } from "../../scripts/check-release-assets";

const ROOT = resolve(import.meta.dir, "../..");
const WF = readFileSync(resolve(ROOT, ".github/workflows/tauri-release.yml"), "utf8");

/** I nomi veri di una release completa, presi da tauri-v2.2.155. */
const completa = (v = "2.2.155"): string[] => [
  "latest.json",
  `Topics_${v}_amd64.deb`,
  `Topics_${v}_amd64.deb.sig`,
  `Topics_${v}_universal.dmg`,
  `Topics_${v}_x64_en-US.msi`,
  `Topics_${v}_x64_en-US.msi.sig`,
  `Topics_${v}_x64-setup.exe`,
  `Topics_${v}_x64-setup.exe.sig`,
  "Topics_universal.app.tar.gz",
  "Topics_universal.app.tar.gz.sig",
  `Topics-${v}-1.x86_64.rpm`,
  `Topics-${v}-1.x86_64.rpm.sig`,
];

describe("publish: il cancello sono gli asset", () => {
  it("i dodici attesi sono dodici", () => {
    expect(ASSET_SUFFIXES.length).toBe(12);
  });

  it("una release completa e' pubblicabile", () => {
    const v = assetVerdict(completa());
    expect(v.complete).toBe(true);
    expect(v.found).toBe(12);
  });

  it("LA 2.2.131: dodici asset caricati, build rosso — si pubblica", () => {
    // Il caso letterale del 2026-08-14. L'exit code diceva «no», gli asset
    // dicono «c'e' tutto»: e' la seconda che risponde alla domanda giusta.
    expect(assetVerdict(completa("2.2.131")).complete).toBe(true);
  });

  it("la versione nel nome non conta: si guardano i SUFFISSI", () => {
    // Confrontare nomi interi vorrebbe dire ricostruire qui la regola di naming
    // di tauri — una seconda copia, che va in deriva al primo cambio di bundler.
    expect(assetVerdict(completa("9.9.9")).complete).toBe(true);
    expect(assetVerdict(completa("2.0.0-beta.3")).complete).toBe(true);
  });

  it("manca UN bundle: non si pubblica, e il log dice quale", () => {
    const senzaMsi = completa().filter((n) => !n.endsWith("_x64_en-US.msi"));
    const v = assetVerdict(senzaMsi);
    expect(v.complete).toBe(false);
    expect(v.found).toBe(11);
    expect((v as { missing: string[] }).missing).toEqual(["_x64_en-US.msi"]);
  });

  it("manca una FIRMA: non si pubblica — l'updater non installa senza", () => {
    // Il .sig non e' un accessorio: e' quello che l'updater verifica prima di
    // applicare. Un bundle senza firma e' un aggiornamento che non si puo' fare.
    const senzaSig = completa().filter((n) => !n.endsWith("Topics_universal.app.tar.gz.sig"));
    const v = assetVerdict(senzaSig);
    expect(v.complete).toBe(false);
    expect((v as { missing: string[] }).missing).toContain("_universal.app.tar.gz.sig");
  });

  it("manca un OS INTERO (il caso della firma macOS del 08/08)", () => {
    const senzaMac = completa().filter(
      (n) => !n.includes("universal.dmg") && !n.includes("universal.app.tar.gz"),
    );
    const v = assetVerdict(senzaMac);
    expect(v.complete).toBe(false);
    expect(v.found).toBe(9);
  });

  it("una draft VUOTA non si pubblica: sono 12 su 27 nel repo", () => {
    const v = assetVerdict([]);
    expect(v.complete).toBe(false);
    expect(v.found).toBe(0);
    expect((v as { missing: string[] }).missing.length).toBe(12);
  });

  it("senza latest.json l'updater non chiede mai gli altri undici", () => {
    expect(isUpdaterManifestMissing([])).toBe(true);
    expect(isUpdaterManifestMissing(completa())).toBe(false);
    expect(assetVerdict(completa().filter((n) => n !== "latest.json")).complete).toBe(false);
  });

  it("asset in piu' non disturbano: si chiede «c'e' tutto», non «c'e' solo»", () => {
    expect(assetVerdict([...completa(), "SHA256SUMS", "note.txt"]).complete).toBe(true);
  });

  it("il workflow gira ANCHE con un build rosso, ma solo con la release creata", () => {
    // Senza `always()` il job non partirebbe proprio nel caso da recuperare,
    // e questo cancello sarebbe decorativo. Senza il controllo su
    // create-release non ci sarebbe una release_id da misurare.
    expect(WF).toContain("always() && needs.create-release.result == 'success'");
  });

  it("il controllo degli asset viene PRIMA della pubblicazione", () => {
    // L'ordine e' il cancello: misurare dopo aver pubblicato sarebbe un referto.
    const iCheck = WF.indexOf("check-release-assets.ts");
    const iPub = WF.indexOf("Publish the release");
    expect(iCheck).toBeGreaterThan(0);
    expect(iCheck).toBeLessThan(iPub);
  });
});
