/**
 * A real picture for a chat message: a PNG the browser decodes, uploaded
 * through the composer's own door (`POST /api/upload`), and a way to make its
 * bytes late on purpose.
 *
 * Late, because on a test machine a picture loads in a few milliseconds and
 * "the box was there before the bytes" would look the same as "the bytes were
 * fast". Held for a second, a picture without a box is drawn at zero height and
 * then grows, which is the movement CHAT-MEDIA-BOX-01 is about.
 */
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { deflateSync } from "zlib";
import { E2E_BASE } from "./test-server";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** A grey PNG of `width`×`height` with diagonal bands, so a video shows which part is on screen. */
export function bandedPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    const off = y * (width + 1);
    raw[off] = 0; // filter: none
    for (let x = 0; x < width; x++) raw[off + 1 + x] = (x + y) % 120 < 60 ? 0x55 : 0xbb;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Uploads a `width`×`height` PNG and returns the path a message names it by. */
export async function uploadPng(request: APIRequestContext, name: string, width: number, height: number): Promise<string> {
  const res = await request.post(`${E2E_BASE}/api/upload`, {
    multipart: { file: { name, mimeType: "image/png", buffer: bandedPng(width, height) } },
  });
  expect(res.ok(), `upload: ${res.status()}`).toBe(true);
  const { path } = (await res.json()) as { path: string };
  expect(path).toBeTruthy();
  return path;
}

/**
 * Holds every request for a picture whose URL carries `needle` for `ms`.
 * `releasedAt` is the wall clock (`Date.now()`) the first held request went on.
 */
export async function holdPicture(page: Page, needle: string, ms: number): Promise<{ held: number; releasedAt: number | null }> {
  const probe = { held: 0, releasedAt: null as number | null };
  await page.route((url) => url.pathname.endsWith("/api/media") && url.search.includes(encodeURIComponent(needle)), async (route) => {
    probe.held += 1;
    await new Promise((r) => setTimeout(r, ms));
    probe.releasedAt ??= Date.now();
    await route.continue();
  });
  return probe;
}
