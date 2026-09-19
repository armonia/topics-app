/**
 * LO SCREENCAST VIVO, dopo l'estrazione in `browser-cdp-surface.ts`.
 *
 * L'estrazione tocca cinque punti dello screencast (start, ACK, i due stop, il
 * restart dentro `resize`) e nessun test del repo accende uno stream vero: i
 * file che nominano lo screencast lo fanno di striscio, quindi un refuso nei
 * parametri o un ACK che non parte piu' passerebbe tutti i cancelli verdi e si
 * vedrebbe solo come una pane nera.
 *
 * Quindi qui si guarda l'unica cosa che conta: arrivano i fotogrammi, e dopo un
 * `resize` arrivano PIU' GRANDI. La seconda meta' e' il motivo per cui
 * `screencastParams` esiste in un posto solo - Chromium congela
 * maxWidth/maxHeight all'avvio, e prima della centralizzazione i due chiamanti
 * calcolavano le stesse dimensioni con due copie della stessa aritmetica.
 *
 * Non e' nella suite: e' una sonda, si lancia a mano con un Chromium vero.
 */
import { createBrowserService } from '../../server/browser-service';

const svc = await createBrowserService({ defaultViewport: { width: 800, height: 600 } });
const id = `screencast-probe-${Date.now()}`;
const got: { w: number; h: number }[] = [];

function decodeJpegSize(b64: string): { w: number; h: number } {
  // SOF0/SOF2 marker: la dimensione REALE del fotogramma, non quella chiesta.
  const buf = Buffer.from(b64, 'base64');
  for (let i = 2; i < buf.length - 9; ) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { w: -1, h: -1 };
}

try {
  await svc.createContext(id, { viewport: { width: 800, height: 600 } });
  await svc.navigate(id, 'data:text/html,<body style="background:linear-gradient(red,blue)"><h1>frame</h1>');

  await svc.startScreencast(id, (data) => { got.push(decodeJpegSize(data)); });
  // Una pagina ferma smette di produrre fotogrammi: muovila.
  for (let i = 0; i < 10 && got.length < 2; i++) {
    await svc.dispatchInput(id, 'scroll', { deltaY: 40 });
    await new Promise((r) => setTimeout(r, 200));
  }
  const beforeCount = got.length;
  const beforeSize = got[got.length - 1];

  got.length = 0;
  await svc.resize(id, 1100, 700);
  for (let i = 0; i < 10 && got.length < 2; i++) {
    await svc.dispatchInput(id, 'scroll', { deltaY: 40 });
    await new Promise((r) => setTimeout(r, 200));
  }
  const afterSize = got[got.length - 1];

  await svc.stopScreencast(id);
  const counters = svc.registrySizes();

  console.log(JSON.stringify({
    framesBeforeResize: beforeCount,
    sizeBeforeResize: beforeSize,
    framesAfterResize: got.length,
    sizeAfterResize: afterSize,
    screencastSessionsAfterStop: counters.screencastSessions,
    verdict:
      beforeCount > 0 && got.length > 0 && afterSize && beforeSize &&
      afterSize.w > beforeSize.w && counters.screencastSessions === 0
        ? 'OK: frames flow, resize widens them, session released'
        : 'FAIL',
  }, null, 2));
} finally {
  await svc.close();
}
