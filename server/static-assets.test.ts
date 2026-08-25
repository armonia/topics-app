/**
 * @covers STATIC-01
 */
import { describe, test, expect } from "bun:test";
import { classifyStaticAsset } from "./static-assets";
import { buildTabPath } from "../shared/tab-link";

const PUBLIC = "/srv/topics/public";

describe("classifyStaticAsset — cosa si serve", () => {
  // Il caso che ha rotto la PWA per un mese: /boot.js non era nell'elenco di
  // nomi scritto a mano, quindi rispondeva 404 mentre index.html lo caricava.
  test("/boot.js si serve (era il buco)", () => {
    const a = classifyStaticAsset("/boot.js", PUBLIC);
    expect(a).not.toBeNull();
    expect(a!.filePath).toBe(`${PUBLIC}/boot.js`);
  });

  test("i file di radice che c'erano già continuano a servirsi", () => {
    for (const p of ["/sw.js", "/manifest.json", "/manifest-dev.json", "/changelog.json", "/vite.svg"]) {
      expect(classifyStaticAsset(p, PUBLIC)).not.toBeNull();
    }
  });

  test("un asset nuovo alla radice non richiede di aggiornare nessun elenco", () => {
    // È il punto della regola strutturale: domani si aggiunge un file al bundle
    // e funziona, invece di 404-are finché qualcuno non se ne accorge.
    expect(classifyStaticAsset("/robots.txt", PUBLIC)).not.toBeNull();
    expect(classifyStaticAsset("/apple-touch-icon.png", PUBLIC)).not.toBeNull();
  });

  test("/assets/ e /icons/ anche in profondità", () => {
    expect(classifyStaticAsset("/assets/index-a1b2c3.js", PUBLIC)!.filePath).toBe(`${PUBLIC}/assets/index-a1b2c3.js`);
    expect(classifyStaticAsset("/icons/ios/icon-192.png", PUBLIC)).not.toBeNull();
  });
});

describe("classifyStaticAsset — cosa NON si serve", () => {
  test("le API non passano di qui", () => {
    expect(classifyStaticAsset("/api/topics", PUBLIC)).toBeNull();
    // Nemmeno una che finisce con un'estensione: ha più di un segmento.
    expect(classifyStaticAsset("/api/files/read.json", PUBLIC)).toBeNull();
  });

  test("una rotta client (senza estensione) resta al fallback SPA", () => {
    expect(classifyStaticAsset("/task/9f3c-uuid", PUBLIC)).toBeNull();
    expect(classifyStaticAsset("/settings", PUBLIC)).toBeNull();
    expect(classifyStaticAsset("/", PUBLIC)).toBeNull();
  });

  test("un permalink /tab/ non è MAI un asset — nemmeno con un punto nella chiave", () => {
    // `ROOT_FILE` è `^\/[^/]+\.[^/]+$`: un solo segmento. Un permalink ne ha
    // sempre almeno due, quindi non può essere scambiato per un file di radice
    // e arriva intatto al fallback SPA — che è ciò che lo fa bootare. Pinnato
    // qui perché è una premessa del comportamento di `shouldServeSpaFallback`,
    // non una proprietà da dare per scontata leggendo l'altro file.
    expect(classifyStaticAsset("/tab/chat/d8ea2ff3-d412-4771-810d-401faa1d1754", PUBLIC)).toBeNull();
    expect(classifyStaticAsset("/tab/panel/board", PUBLIC)).toBeNull();
    expect(classifyStaticAsset("/tab/project/my.app", PUBLIC)).toBeNull();
    expect(classifyStaticAsset("/tab/file/my.app/src/App.tsx", PUBLIC)).toBeNull();
    const encoded = buildTabPath({ kind: "file", key: "src/App.tsx", projectPath: "/Users/x/my.app" })!;
    expect(classifyStaticAsset(encoded, PUBLIC)).toBeNull();
  });

  test("niente traversata fuori dal bundle", () => {
    // `URL.pathname` normalizza i `..`, ma la guardia non deve dipenderne.
    expect(classifyStaticAsset("/assets/../../etc/passwd", PUBLIC)).toBeNull();
    expect(classifyStaticAsset("/icons/../../../.ssh/id_rsa", PUBLIC)).toBeNull();
    // Una directory SORELLA non deve passare il confronto di prefisso.
    expect(classifyStaticAsset("/assets/../../public-altro/x.js", PUBLIC)).toBeNull();
  });

  test("una cartella di secondo livello non allowlistata resta fuori", () => {
    expect(classifyStaticAsset("/uploads/foto.png", PUBLIC)).toBeNull();
    expect(classifyStaticAsset("/media/browser/x.jpg", PUBLIC)).toBeNull();
  });
});

describe("classifyStaticAsset — cache", () => {
  test("/assets/ e /icons/ sono immutabili (nome versionato o stabile)", () => {
    expect(classifyStaticAsset("/assets/index-a1b2c3.js", PUBLIC)!.cacheControl).toBe("public, max-age=31536000, immutable");
    expect(classifyStaticAsset("/icons/icon-192.png", PUBLIC)!.cacheControl).toBe("public, max-age=31536000, immutable");
  });

  test("i file di radice NON si pinnano: decidono cosa viene servito dopo", () => {
    // `sw.js` e `boot.js` cachati per un anno inchioderebbero l'app a un bundle
    // vecchio — è la stessa classe di guasto dello «still on 2.1.57».
    for (const p of ["/boot.js", "/sw.js", "/manifest.json", "/changelog.json"]) {
      expect(classifyStaticAsset(p, PUBLIC)!.cacheControl).toBe("no-cache");
    }
  });
});
