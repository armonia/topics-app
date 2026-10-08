/**
 * The size of each picture a message draws, read from the file's first bytes
 * and sent with the message, never stored.
 *
 * @covers CHAT-MEDIA-BOX-01
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imagePathsOf, jpegOrientation, mediaFileOf, mediaSizesOf, withMediaSizes, type MediaFileRules } from "./media-size";

/** A PNG whose header says `w`×`h`: the signature and the IHDR, all the size reader looks at. */
function pngHead(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

/** A JPEG of `w`×`h` with an EXIF orientation (big-endian TIFF), then its SOF0. */
function jpegHead(w: number, h: number, orientation: number | null): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (orientation !== null) {
    const tiff = Buffer.alloc(8 + 2 + 12 + 4);
    tiff.write("MM", 0, "latin1");
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(orientation, 18);
    const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
    const app1 = Buffer.alloc(4);
    app1.writeUInt16BE(0xffe1, 0);
    app1.writeUInt16BE(body.length + 2, 2);
    parts.push(app1, body);
  }
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  parts.push(sof, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

let root = "";
let rules: MediaFileRules;
let uploads = "";
let media = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "media-size-"));
  uploads = join(root, "uploads");
  media = join(root, "media");
  mkdirSync(uploads);
  mkdirSync(media);
  mkdirSync(join(root, "secret"));
  writeFileSync(join(uploads, "shot.png"), pngHead(1600, 900));
  writeFileSync(join(media, "photo.jpg"), jpegHead(4000, 3000, 6));
  writeFileSync(join(media, "flat.jpg"), jpegHead(800, 600, 1));
  writeFileSync(join(media, "broken.png"), Buffer.from("not a picture"));
  writeFileSync(join(media, "vector.svg"), '<svg width="10" height="10"/>');
  writeFileSync(join(root, "secret", "outside.png"), pngHead(10, 10));
  rules = { uploadsDir: uploads, isPathAllowed: (f) => f.startsWith(uploads + "/") || f.startsWith(media + "/") };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("which pictures a message draws", () => {
  test("the server's marker, an attachment, the media array and a local markdown image", () => {
    const paths = imagePathsOf({
      content: "Done.\n\n![chart](uploads/chart.png) and ![web](https://example.com/x.png)\nMEDIA:/m/a.png\n[Attached file: /u/b.jpg]",
      media: ["/m/c.webp", "/m/d.pdf"],
    });
    expect(paths.sort()).toEqual(["/m/a.png", "/m/c.webp", "/u/b.jpg", "/uploads/chart.png"]);
  });

  test("the text of the timeline blocks, not the tool rows", () => {
    const paths = imagePathsOf({
      content: "",
      blocks: [
        { kind: "text", text: "Here:\nMEDIA:/m/inline.gif" },
        { kind: "tool", toolCall: { id: "t", name: "Bash", args: {} }, text: "MEDIA:/m/not-drawn.png" },
      ],
    });
    expect(paths).toEqual(["/m/inline.gif"]);
  });

  test("a voice note, a document and an SVG are not boxed", () => {
    expect(imagePathsOf({ content: "[Voice message: /v/a.ogg] MEDIA:/m/x.pdf MEDIA:/m/y.svg" })).toEqual([]);
  });
});

describe("where a picture is read from", () => {
  test("`/uploads/…` from the uploads folder, never above it", () => {
    expect(mediaFileOf("/uploads/shot.png", rules)).toBe(join(uploads, "shot.png"));
    expect(mediaFileOf("/uploads/../secret/outside.png", rules)).toBeNull();
  });

  test("an absolute path only through the allowlist of `/api/media`", () => {
    expect(mediaFileOf(join(media, "photo.jpg"), rules)).toBe(join(media, "photo.jpg"));
    expect(mediaFileOf(join(root, "secret", "outside.png"), rules)).toBeNull();
    expect(mediaFileOf("~/.topics/media/a.png", rules)).toBeNull();
  });
});

describe("the sizes", () => {
  test("PNG from its header, keyed by the path the client looks up", () => {
    expect(mediaSizesOf({ content: "[Attached file: /uploads/shot.png]" }, rules)).toEqual({ "/uploads/shot.png": [1600, 900] });
  });

  test("a JPEG turned by its EXIF is laid out turned: width and height swap", () => {
    expect(jpegOrientation(jpegHead(4000, 3000, 6))).toBe(6);
    expect(jpegOrientation(jpegHead(4000, 3000, null))).toBe(1);
    const turned = join(media, "photo.jpg");
    const flat = join(media, "flat.jpg");
    expect(mediaSizesOf({ media: [turned, flat] }, rules)).toEqual({ [turned]: [3000, 4000], [flat]: [800, 600] });
  });

  test("a file that is not a picture, or is missing, or is outside: no size, the message as it was", () => {
    const msg = { content: `MEDIA:${join(media, "broken.png")}\nMEDIA:${join(media, "gone.png")}\nMEDIA:${join(root, "secret", "outside.png")}` };
    expect(mediaSizesOf(msg, rules)).toBeUndefined();
    expect(withMediaSizes(msg, rules)).toBe(msg);
  });

  test("a frame gains `mediaSizes` and keeps every other field", () => {
    const frame = { type: "message:media", sessionKey: "s", media: ["/uploads/shot.png"] };
    expect(withMediaSizes(frame, rules)).toEqual({ ...frame, mediaSizes: { "/uploads/shot.png": [1600, 900] } });
  });

  test("a file rewritten under the same name is read again", () => {
    const file = join(media, "again.png");
    writeFileSync(file, pngHead(100, 50));
    utimesSync(file, new Date(1_000_000), new Date(1_000_000));
    expect(mediaSizesOf({ media: [file] }, rules)).toEqual({ [file]: [100, 50] });
    writeFileSync(file, pngHead(300, 200));
    utimesSync(file, new Date(2_000_000), new Date(2_000_000));
    expect(mediaSizesOf({ media: [file] }, rules)).toEqual({ [file]: [300, 200] });
  });
});
