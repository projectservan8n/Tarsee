// Tarsee's icon (src/lib/brand-icon.js, the Settings routes for it, js/brand-icon.js): the PNG decoder on every colour
// type, bit depth and row filter, the resizer, the ICO and the icon set, saving and resetting in a data folder of its
// own, the middleware that serves an uploaded icon, the manifest with the version on every icon, the three routes,
// and window.TarseeBrand on a stand-in page. Nothing here touches the network beyond 127.0.0.1.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import express from "express";

// Keep the module away from the real state directory (all three, so a folder set in the shell cannot win). Set
// before the imports below: src/config/env.js reads them once, when it is first loaded.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tarsee-brand-icon-"));
process.env.TARSEE_STATE_DIR = tmp;
process.env.TARSEE_WORKSPACE_DIR = path.join(tmp, "workspace");
process.env.TARSEE_DATA_DIR = path.join(tmp, "data");
const bi = await import("../src/lib/brand-icon.js");
const { settingsRouter } = await import("../src/routes/settings.js");
const { initDb } = await import("../src/db/sqlite.js");

const PUBLIC = fileURLToPath(new URL("../src/public/", import.meta.url));
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---------------------------------------------------------------- PNGs made by hand (not by the module's encoder)

const crc = typeof zlib.crc32 === "function" ? (b) => zlib.crc32(b) >>> 0 : bi.crc32;
function chunk(type, data = Buffer.alloc(0)) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
}
function ihdr(width, height, bitDepth, colorType, interlace = 0) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0);
  b.writeUInt32BE(height, 4);
  b[8] = bitDepth; b[9] = colorType; b[12] = interlace;
  return chunk("IHDR", b);
}
/** Rows of plain bytes with a filter on each (one number for all, or a list that goes round). */
function filterRows(rows, bpp, filter) {
  let prev = null;
  return Buffer.concat(rows.map((row, y) => {
    const f = Array.isArray(filter) ? filter[y % filter.length] : filter;
    const o = Buffer.alloc(row.length + 1);
    o[0] = f;
    for (let i = 0; i < row.length; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      o[i + 1] = (row[i] - pred) & 255;
    }
    prev = row;
    return o;
  }));
}
function makePng({ width, height, colorType, bitDepth, rows, palette, trns, filter = 0, interlace = 0, extra = [] }) {
  const bpp = Math.max(1, (CHANNELS[colorType] * bitDepth) >> 3);
  const parts = [SIG, ihdr(width, height, bitDepth, colorType, interlace), ...extra];
  if (palette) parts.push(chunk("PLTE", Buffer.from(palette)));
  if (trns) parts.push(chunk("tRNS", Buffer.from(trns)));
  parts.push(chunk("IDAT", zlib.deflateSync(filterRows(rows, bpp, filter))), chunk("IEND"));
  return Buffer.concat(parts);
}
const packBits = (values, depth) => {
  const out = Buffer.alloc(Math.ceil((values.length * depth) / 8));
  values.forEach((v, i) => { const bit = i * depth; out[bit >> 3] |= v << (8 - depth - (bit & 7)); });
  return out;
};
const u16 = (values) => { const b = Buffer.alloc(values.length * 2); values.forEach((v, i) => b.writeUInt16BE(v, i * 2)); return b; };
const to8 = (v, depth) => (depth === 16 ? Math.round(v / 257) : depth === 8 ? v : Math.round((v * 255) / ((1 << depth) - 1)));
const pixel = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

/** An RGBA image, every pixel fill(x, y) -> [r, g, b, a]. */
function rgbaImage(width, height, fill) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(fill(x, y), (y * width + x) * 4);
  return { width, height, data };
}
const flat = (n, c) => rgbaImage(n, n, () => c);
const everyPixel = (img, test) => { for (let i = 0; i < img.data.length; i += 4) if (!test(Array.from(img.data.subarray(i, i + 4)))) return false; return true; };

// ---------------------------------------------------------------- decoding

describe("brand icon: the PNG decoder", () => {
  it("crc32 is the standard one", () => {
    assert.equal(bi.crc32(Buffer.from("123456789")), 0xcbf43926);
    if (typeof zlib.crc32 === "function") { const b = crypto.randomBytes(999); assert.equal(bi.crc32(b), zlib.crc32(b) >>> 0); }
  });

  it("RGBA 8-bit from its own encoder, with each filter and the automatic choice: back as it went in", () => {
    const img = rgbaImage(7, 5, () => [rnd(256), rnd(256), rnd(256), rnd(256)]);
    for (const filter of [0, 1, 2, 3, 4, "auto"]) {
      const back = bi.decodePng(bi.encodePng(img, { filter }));
      assert.deepEqual([back.width, back.height], [7, 5]);
      assert.deepEqual(Array.from(back.data), Array.from(img.data), `filter ${filter}`);
    }
  });

  // Every colour type at every bit depth it allows, through every filter (three rows, so Up, Average and Paeth all
  // look at the row above), against what each pixel must come out as.
  const cases = [];
  for (const depth of [1, 2, 4, 8, 16]) cases.push({ colorType: 0, depth });
  for (const depth of [8, 16]) cases.push({ colorType: 2, depth }, { colorType: 4, depth }, { colorType: 6, depth });
  for (const depth of [1, 2, 4, 8]) cases.push({ colorType: 3, depth });

  for (const { colorType, depth } of cases) {
    it(`colour type ${colorType} at ${depth} bits, all five filters`, () => {
      const width = 9, height = 3, ch = CHANNELS[colorType];
      const max = colorType === 3 ? Math.min(255, (1 << depth) - 1) : (1 << depth) - 1;
      const colours = colorType === 3 ? max + 1 : 0;
      const palette = colorType === 3 ? Array.from({ length: colours * 3 }, () => rnd(256)) : null;
      const trns = colorType === 3 ? Array.from({ length: Math.max(1, colours >> 1) }, () => rnd(256)) : null;   // (fewer than the colours: the rest opaque)
      const px = [];
      for (let y = 0; y < height; y++) {
        const row = [];
        for (let x = 0; x < width; x++) row.push(Array.from({ length: ch }, (_, c) => (x === 0 && y === 0 ? max : x === 1 && y === 0 ? 0 : (rnd(max + 1) + c) % (max + 1))));
        px.push(row);
      }
      const rows = px.map((row) => {
        const flatRow = row.flat();
        return depth < 8 ? packBits(flatRow, depth) : depth === 16 ? u16(flatRow) : Buffer.from(flatRow);
      });
      const want = (p) => {
        if (colorType === 0) { const g = to8(p[0], depth); return [g, g, g, 255]; }
        if (colorType === 2) return [to8(p[0], depth), to8(p[1], depth), to8(p[2], depth), 255];
        if (colorType === 3) return [palette[p[0] * 3], palette[p[0] * 3 + 1], palette[p[0] * 3 + 2], p[0] < trns.length ? trns[p[0]] : 255];
        if (colorType === 4) { const g = to8(p[0], depth); return [g, g, g, to8(p[1], depth)]; }
        return p.map((v) => to8(v, depth));
      };
      for (const filter of [0, 1, 2, 3, 4, [4, 3, 1]]) {
        const img = bi.decodePng(makePng({ width, height, colorType, bitDepth: depth, rows, palette, trns, filter }));
        assert.deepEqual([img.width, img.height, img.data.length], [width, height, width * height * 4]);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) assert.deepEqual(pixel(img, x, y), want(px[y][x]), `filter ${filter}, pixel ${x},${y}`);
      }
    });
  }

  it("tRNS: one gray, or one RGB colour, is see-through", () => {
    const gray = bi.decodePng(makePng({ width: 3, height: 1, colorType: 0, bitDepth: 8, rows: [Buffer.from([10, 128, 200])], trns: [0, 128] }));
    assert.deepEqual([pixel(gray, 0, 0)[3], pixel(gray, 1, 0)[3], pixel(gray, 2, 0)[3]], [255, 0, 255]);
    const gray16 = bi.decodePng(makePng({ width: 2, height: 1, colorType: 0, bitDepth: 16, rows: [u16([1000, 1001])], trns: [0x03, 0xe9] }));
    assert.deepEqual([pixel(gray16, 0, 0)[3], pixel(gray16, 1, 0)[3]], [255, 0]);
    const rgb = bi.decodePng(makePng({ width: 2, height: 1, colorType: 2, bitDepth: 8, rows: [Buffer.from([1, 2, 3, 4, 5, 6])], trns: [0, 4, 0, 5, 0, 6] }));
    assert.deepEqual([pixel(rgb, 0, 0), pixel(rgb, 1, 0)], [[1, 2, 3, 255], [4, 5, 6, 0]]);
  });

  it("other chunks it does not need (text, gamma) are passed over", () => {
    const text = chunk("tEXt", Buffer.from("Comment\0hello", "latin1"));
    const gama = chunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f]));
    const img = bi.decodePng(makePng({ width: 1, height: 1, colorType: 2, bitDepth: 8, rows: [Buffer.from([9, 8, 7])], extra: [text, gama] }));
    assert.deepEqual(pixel(img, 0, 0), [9, 8, 7, 255]);
  });

  it("refuses what is not a PNG, an interlaced one, a damaged one, and impossible ones", () => {
    const refused = (buf, re) => assert.throws(() => bi.decodePng(buf), (e) => e instanceof bi.BrandIconError && e.status === 400 && re.test(e.message));
    refused(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]), /not a PNG/);
    refused(Buffer.from("hello there, I am text"), /not a PNG/);
    const good = makePng({ width: 2, height: 2, colorType: 6, bitDepth: 8, rows: [Buffer.alloc(8), Buffer.alloc(8)] });
    refused(makePng({ width: 2, height: 2, colorType: 6, bitDepth: 8, interlace: 1, rows: [Buffer.alloc(8), Buffer.alloc(8)] }), /Interlaced/);
    const flipped = Buffer.from(good); flipped[40] ^= 0xff;   // (inside IDAT)
    refused(flipped, /damaged|checksum/);
    refused(good.subarray(0, good.length - 20), /cut short|no picture|damaged/);
    refused(makePng({ width: 2, height: 1, colorType: 2, bitDepth: 4, rows: [Buffer.alloc(3)] }), /do not go together/);
    refused(makePng({ width: 2, height: 1, colorType: 3, bitDepth: 8, rows: [Buffer.from([0, 5])], palette: [1, 2, 3, 4, 5, 6] }), /palette/);
    refused(makePng({ width: 2, height: 1, colorType: 3, bitDepth: 8, rows: [Buffer.from([0, 0])] }), /palette/);
    refused(Buffer.concat([SIG, ihdr(1, 1, 8, 2), chunk("ABcd", Buffer.alloc(2)), chunk("IDAT", zlib.deflateSync(Buffer.from([0, 1, 2, 3]))), chunk("IEND")]), /cannot read/);
    const badFilter = Buffer.concat([SIG, ihdr(1, 1, 8, 2), chunk("IDAT", zlib.deflateSync(Buffer.from([7, 1, 2, 3]))), chunk("IEND")]);
    refused(badFilter, /filter/);
    assert.throws(() => bi.decodePng(good, { maxPixels: 3 }), /too big/);
  });
});

// ---------------------------------------------------------------- resizing, ICO, the set

describe("brand icon: resizing", () => {
  it("a flat colour stays exactly that colour at every size, down and up", () => {
    const colour = [12, 200, 99, 255];
    const master = flat(1024, colour);
    for (const n of [16, 32, 48, 180, 192, 512]) {
      const out = bi.resizeRgba(master, n, n);
      assert.deepEqual([out.width, out.height, out.data.length], [n, n, n * n * 4]);
      assert.ok(everyPixel(out, (p) => p.join() === colour.join()), `at ${n}`);
    }
    const up = bi.resizeRgba(flat(64, colour), 180, 180);
    assert.ok(everyPixel(up, (p) => p.join() === colour.join()), "up from 64");
    const glass = bi.resizeRgba(flat(100, [40, 80, 120, 128]), 33, 33);
    assert.ok(everyPixel(glass, (p) => p.join() === "40,80,120,128"), "half see-through too");
  });

  it("a checkerboard averages to the middle gray; a part-covered pixel counts by the part covered", () => {
    const checker = rgbaImage(2, 2, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    assert.deepEqual(pixel(bi.resizeRgba(checker, 1, 1), 0, 0), [128, 128, 128, 255]);
    const fine = rgbaImage(8, 8, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    assert.ok(everyPixel(bi.resizeRgba(fine, 4, 4), (p) => p.join() === "128,128,128,255"));
    // 3 pixels to 2: each output covers one and a half: (0 + 90/2) / 1.5 = 30, (90/2 + 180) / 1.5 = 150.
    const ramp = rgbaImage(3, 1, (x) => [x * 90, x * 90, x * 90, 255]);
    const two = bi.resizeRgba(ramp, 2, 1);
    assert.deepEqual([pixel(two, 0, 0)[0], pixel(two, 1, 0)[0]], [30, 150]);
  });

  it("weighs colours by their alpha: a see-through neighbour does not darken an opaque pixel", () => {
    const half = rgbaImage(2, 1, (x) => (x ? [0, 255, 0, 0] : [255, 0, 0, 255]));
    assert.deepEqual(pixel(bi.resizeRgba(half, 1, 1), 0, 0), [255, 0, 0, 128]);
    assert.deepEqual(pixel(bi.resizeRgba(rgbaImage(4, 4, () => [9, 9, 9, 0]), 1, 1), 0, 0), [0, 0, 0, 0]);
  });
});

/** A master: a disc of `colour` on see-through, or (full) a square of `colour` to its edges with a disc of white. */
function disc(n, colour, full = false) {
  return rgbaImage(n, n, (x, y) => {
    const inside = (x - n / 2 + 0.5) ** 2 + (y - n / 2 + 0.5) ** 2 < (n * 0.3) ** 2;
    if (full) return inside ? [255, 255, 255, 255] : colour;
    return inside ? colour : [0, 0, 0, 0];
  });
}

describe("brand icon: the ICO and the icon set", () => {
  let transparent, fullBleed;
  before(async () => {
    transparent = await bi.makeIconSet(disc(256, [200, 30, 60, 255]));
    fullBleed = await bi.makeIconSet(disc(256, [20, 40, 200, 255], true));
  });

  it("makes every file at exactly its size", () => {
    const sizes = { "icon-16.png": 16, "icon-32.png": 32, "apple-touch-icon.png": 180, "icon-192.png": 192, "icon-512.png": 512, "icon-maskable-512.png": 512 };
    for (const [name, n] of Object.entries(sizes)) {
      const img = bi.decodePng(transparent.files[name]);
      assert.deepEqual([img.width, img.height], [n, n], name);
    }
    assert.deepEqual(Object.keys(transparent.files).sort(), Object.keys(bi.ICON_FILES).map((p) => p.slice(1)).sort());
  });

  it("favicon.ico: an icon header, three entries (16, 32, 48) of 32 bits, each pointing at a whole PNG", () => {
    const ico = transparent.files["favicon.ico"];
    assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 3]);
    let end = 6 + 16 * 3;
    [16, 32, 48].forEach((n, i) => {
      const e = 6 + 16 * i;
      assert.deepEqual([ico[e], ico[e + 1], ico[e + 2], ico[e + 3], ico.readUInt16LE(e + 4), ico.readUInt16LE(e + 6)], [n, n, 0, 0, 1, 32]);
      const size = ico.readUInt32LE(e + 8), offset = ico.readUInt32LE(e + 12);
      assert.equal(offset, end, "one after the other, no gaps");
      const png = ico.subarray(offset, offset + size);
      assert.ok(png.subarray(0, 8).equals(SIG), `entry ${n} is a PNG`);
      assert.deepEqual([bi.decodePng(png).width, bi.decodePng(png).height], [n, n]);
      end = offset + size;
    });
    assert.equal(end, ico.length);
    const big = bi.encodeIco([{ size: 256, png: transparent.files["icon-16.png"] }]);
    assert.deepEqual([big[6], big[7]], [0, 0], "256 is written as 0");
  });

  it("the home-screen and maskable icons are fully opaque; the plain ones keep their see-through corners", () => {
    for (const set of [transparent, fullBleed]) {
      for (const name of ["apple-touch-icon.png", "icon-maskable-512.png"]) assert.ok(everyPixel(bi.decodePng(set.files[name]), (p) => p[3] === 255), name);
    }
    for (const name of ["icon-16.png", "icon-32.png", "icon-192.png", "icon-512.png"]) assert.equal(pixel(bi.decodePng(transparent.files[name]), 0, 0)[3], 0, name);
  });

  it("behind it: the app's dark background for a see-through edge, the edge's own colour for a full-bleed icon", () => {
    assert.deepEqual(transparent.background, [0x1a, 0x1a, 0x1a]);
    assert.deepEqual(fullBleed.background, [20, 40, 200]);
    const m = bi.decodePng(transparent.files["icon-maskable-512.png"]);
    assert.deepEqual(pixel(m, 0, 0), [0x1a, 0x1a, 0x1a, 255]);
    assert.deepEqual(pixel(m, 256, 256), [200, 30, 60, 255], "the picture in the middle");
    assert.deepEqual(pixel(bi.decodePng(fullBleed.files["icon-maskable-512.png"]), 3, 3), [20, 40, 200, 255]);
    assert.deepEqual(pixel(bi.decodePng(transparent.files["apple-touch-icon.png"]), 0, 0), [0x1a, 0x1a, 0x1a, 255]);
  });

  it("the maskable picture is about 80% across, in the middle", () => {
    const m = bi.decodePng(bi.encodePng(bi.maskableRgba(flat(100, [250, 250, 250, 255]), 512, [0, 0, 0])));
    const row = Array.from({ length: 512 }, (_, x) => pixel(m, x, 256)[0]);
    const from = row.indexOf(250), to = row.lastIndexOf(250);
    assert.equal(to - from + 1, Math.round(512 * 0.8));
    assert.ok(Math.abs(from - (511 - to)) <= 1, "centred");
  });

  it("the default set in src/public has the 16 and maskable icons, made from icon-512.png by this module", async () => {
    const made = await bi.makeIconSet(bi.decodePng(fs.readFileSync(path.join(PUBLIC, "icon-512.png"))));
    for (const name of ["icon-16.png", "icon-maskable-512.png"]) {
      const committed = bi.decodePng(fs.readFileSync(path.join(PUBLIC, name)));
      const fresh = bi.decodePng(made.files[name]);
      assert.deepEqual([committed.width, committed.height], [fresh.width, fresh.height], name);
      assert.ok(Buffer.from(committed.data).equals(Buffer.from(fresh.data)), `${name}: the same pixels`);
    }
    assert.ok(everyPixel(bi.decodePng(fs.readFileSync(path.join(PUBLIC, "icon-maskable-512.png"))), (p) => p[3] === 255));
  });
});

// ---------------------------------------------------------------- small helpers

describe("brand icon: what was uploaded", () => {
  it("knows a PNG, JPEG, WebP and SVG by their bytes, and nothing else", () => {
    assert.equal(bi.sniffImageType(bi.encodePng(flat(2, [1, 2, 3, 4])))?.ext, "png");
    assert.equal(bi.sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2]))?.type, "image/jpeg");
    assert.equal(bi.sniffImageType(Buffer.from("RIFF\x10\0\0\0WEBPVP8 ", "latin1"))?.ext, "webp");
    assert.equal(bi.sniffImageType(Buffer.from('<?xml version="1.0"?>\n<!-- hi -->\n<svg xmlns="http://www.w3.org/2000/svg"/>'))?.ext, "svg");
    assert.equal(bi.sniffImageType(Buffer.from("<html><body>svg</body></html>")), null);
    assert.equal(bi.sniffImageType(Buffer.from("GIF89a")), null);
    assert.equal(bi.sniffImageType(Buffer.from([0x3c, 0x73, 0x76, 0x67, 0x20, 0]))?.ext, undefined, "text with a NUL in it is not an SVG");
  });

  it("base64, with or without a data: start; anything else is null", () => {
    assert.deepEqual(bi.decodeBase64(Buffer.from("hi there").toString("base64")), Buffer.from("hi there"));
    assert.deepEqual(bi.decodeBase64("data:image/png;base64," + Buffer.from("abc").toString("base64")), Buffer.from("abc"));
    for (const bad of [null, 42, "", "not base64 at all!", "%%%%"]) assert.equal(bi.decodeBase64(bad), null, String(bad));
  });

  it("the version goes on this site's addresses only, in place of any query", () => {
    assert.equal(bi.withVersion("/icon-32.png", "abc"), "/icon-32.png?v=abc");
    assert.equal(bi.withVersion("/icon-32.png?v=old#x", "abc"), "/icon-32.png?v=abc");
    assert.equal(bi.withVersion("https://cdn.example/icon.png", "abc"), "https://cdn.example/icon.png");
    assert.equal(bi.withVersion("//cdn.example/icon.png", "abc"), "//cdn.example/icon.png");
  });
});

// ---------------------------------------------------------------- saving and resetting

const masterPng = (n = 128, colour = [30, 160, 90, 255]) => bi.encodePng(disc(n, colour, true));
const versionOf = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12);
const DEFAULT_VERSION = "d" + crypto.createHash("sha256").update(fs.readFileSync(path.join(PUBLIC, "icon-512.png"))).digest("hex").slice(0, 11);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

describe("brand icon: saving and resetting in the data folder", () => {
  before(async () => { await bi.resetBrandIcon(); });

  it("keeps its files in <DATA_DIR>/brand, which is the test's own folder", () => {
    assert.ok(bi.brandDir().startsWith(tmp), bi.brandDir());
  });

  it("the default icon at first: its version from icon-512.png", () => {
    assert.deepEqual(bi.brandStatus(), { custom: false, version: DEFAULT_VERSION, updatedAt: null });
    assert.equal(bi.iconVersion(), DEFAULT_VERSION);
  });

  it("a save makes every icon, keeps the master and the original, and writes brand.json", async () => {
    const master = masterPng();
    const s = await bi.saveBrandIcon({ master, original: { name: "../../Logo\u0007 final.jpg\n", type: "image/png", data: JPEG } });
    assert.deepEqual([s.custom, s.version], [true, versionOf(master)]);
    assert.ok(!Number.isNaN(Date.parse(s.updatedAt)));
    assert.equal(bi.iconVersion(), s.version);
    const dir = bi.brandDir();
    for (const p of Object.keys(bi.ICON_FILES)) assert.ok(fs.existsSync(path.join(dir, p.slice(1))), p);
    assert.ok(fs.readFileSync(path.join(dir, "master.png")).equals(master));
    assert.ok(fs.readFileSync(path.join(dir, "original.jpg")).equals(JPEG));
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "brand.json"), "utf8"));
    assert.deepEqual([meta.version, meta.updatedAt, meta.originalName, meta.originalType], [s.version, s.updatedAt, "Logo final.jpg", "image/jpeg"], "its real type, by its bytes; the name without its folders or control characters");
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp-")), [], "no half-written files left");
  });

  it("a new save with an SVG original replaces the JPEG one", async () => {
    const s = await bi.saveBrandIcon({ master: masterPng(96, [200, 100, 0, 255]), original: { name: "mark.svg", type: "image/svg+xml", data: SVG } });
    const dir = bi.brandDir();
    assert.ok(fs.existsSync(path.join(dir, "original.svg")));
    assert.ok(!fs.existsSync(path.join(dir, "original.jpg")));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "brand.json"), "utf8")).originalType, "image/svg+xml");
    assert.equal(bi.iconVersion(), s.version);
  });

  it("refuses a master that is not a PNG, not square, too small, too big, interlaced, or an original that is not a picture", async () => {
    const before = bi.brandStatus();
    const refused = async (args, re) => {
      await assert.rejects(bi.saveBrandIcon(args), (e) => e instanceof bi.BrandIconError && e.status === 400 && re.test(e.message), String(re));
    };
    await refused({ master: JPEG }, /must be a PNG/);
    await refused({}, /No icon/);
    await refused({ master: bi.encodePng(rgbaImage(64, 65, () => [0, 0, 0, 255])) }, /square/);
    await refused({ master: bi.encodePng(flat(63, [0, 0, 0, 255])) }, /too small/);
    await refused({ master: Buffer.concat([SIG, ihdr(2049, 2049, 8, 6), chunk("IEND")]) }, /too big/);
    await refused({ master: Buffer.concat([SIG, Buffer.alloc(bi.MASTER_MAX_BYTES)]) }, /too big/);
    const rows = Array.from({ length: 64 }, () => Buffer.alloc(64 * 4, 200));
    await refused({ master: makePng({ width: 64, height: 64, colorType: 6, bitDepth: 8, rows, interlace: 1 }) }, /Interlaced/);
    await refused({ master: masterPng(), original: { name: "x.txt", data: Buffer.from("just words") } }, /not a PNG, JPEG, WebP or SVG/);
    await refused({ master: masterPng(), original: { name: "big.jpg", data: Buffer.concat([JPEG, Buffer.alloc(bi.ORIGINAL_MAX_BYTES)]) } }, /too big/);
    assert.deepEqual(bi.brandStatus(), before, "nothing changed");
  });

  it("survives a restart (read again from brand.json), and falls back to the default if its icons went missing", async () => {
    const s = bi.brandStatus();
    bi.__forgetBrandState();
    assert.deepEqual(bi.brandStatus(), s);
    fs.renameSync(path.join(bi.brandDir(), "icon-192.png"), path.join(bi.brandDir(), "icon-192.png.away"));
    bi.__forgetBrandState();
    assert.equal(bi.brandStatus().custom, false);
    fs.renameSync(path.join(bi.brandDir(), "icon-192.png.away"), path.join(bi.brandDir(), "icon-192.png"));
    bi.__forgetBrandState();
    assert.deepEqual(bi.brandStatus(), s);
  });

  it("a reset removes the upload and brings the default back", async () => {
    const s = await bi.resetBrandIcon();
    assert.deepEqual(s, { custom: false, version: DEFAULT_VERSION, updatedAt: null });
    const left = fs.readdirSync(bi.brandDir());
    assert.deepEqual(left, [], `nothing left: ${left}`);
    bi.__forgetBrandState();
    assert.equal(bi.brandStatus().custom, false);
  });

  it("two saves at once: one after the other, and the last one wins", async () => {
    const a = masterPng(80, [1, 2, 3, 255]), b = masterPng(80, [4, 5, 6, 255]);
    const [sa, sb] = await Promise.all([bi.saveBrandIcon({ master: a }), bi.saveBrandIcon({ master: b })]);
    assert.deepEqual([sa.version, sb.version], [versionOf(a), versionOf(b)]);
    assert.equal(bi.iconVersion(), versionOf(b));
    assert.ok(fs.readFileSync(path.join(bi.brandDir(), "master.png")).equals(b));
    await bi.resetBrandIcon();
  });
});

// ---------------------------------------------------------------- serving

describe("brand icon: the middleware and the manifest", () => {
  let server, base, publicDir;
  before(async () => {
    await bi.resetBrandIcon();
    // A public folder of its own: the default files say DEFAULT so a fall-through is plain to see.
    publicDir = fs.mkdtempSync(path.join(tmp, "public-"));
    for (const p of Object.keys(bi.ICON_FILES)) fs.writeFileSync(path.join(publicDir, p.slice(1)), `DEFAULT ${p}`);
    fs.writeFileSync(path.join(publicDir, "other.png"), "OTHER");
    fs.copyFileSync(path.join(PUBLIC, "manifest.json"), path.join(publicDir, "manifest.json"));
    // As src/server.js mounts them: ahead of express.static, which has a max-age of its own in production.
    const app = express();
    app.use(bi.brandIconMiddleware());
    app.use(bi.manifestHandler(publicDir));
    app.use(express.static(publicDir, { maxAge: "5m" }));
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { server?.close(); await bi.resetBrandIcon(); });

  it("no upload: the default files, still asked for again each time (no-cache)", async () => {
    const res = await fetch(`${base}/icon-32.png?v=whatever`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "DEFAULT /icon-32.png");
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assert.equal(await (await fetch(`${base}/other.png`)).text(), "OTHER");
  });

  it("an upload: served in place of the defaults at every address, whatever the query, with its type and ETag", async () => {
    const s = await bi.saveBrandIcon({ master: masterPng() });
    for (const [p, type] of Object.entries(bi.ICON_FILES)) {
      const res = await fetch(`${base}${p}?v=${s.version}`);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers.get("content-type"), type, p);
      assert.equal(res.headers.get("cache-control"), "no-cache", p);
      assert.equal(res.headers.get("etag"), `"${s.version}-${p.slice(1)}"`, p);
      const body = Buffer.from(await res.arrayBuffer());
      assert.ok(body.equals(fs.readFileSync(path.join(bi.brandDir(), p.slice(1)))), p);
    }
    assert.equal(bi.ICON_FILES["/favicon.ico"], "image/x-icon");
    const plain = await fetch(`${base}/icon-192.png`);
    assert.ok(Buffer.from(await plain.arrayBuffer()).subarray(0, 8).equals(SIG), "no query: the upload too");
    assert.equal(await (await fetch(`${base}/other.png`)).text(), "OTHER", "other files are not its business");
  });

  it("304 for a matching If-None-Match (weak, in a list, or *), 200 for an old one; HEAD has no body", async () => {
    const etag = (await fetch(`${base}/icon-32.png`)).headers.get("etag");
    for (const inm of [etag, `W/${etag}`, `"old", ${etag}`, "*"]) {
      const res = await fetch(`${base}/icon-32.png?v=x`, { headers: { "If-None-Match": inm } });
      assert.equal(res.status, 304, inm);
      assert.equal(res.headers.get("etag"), etag);
    }
    assert.equal((await fetch(`${base}/icon-32.png`, { headers: { "If-None-Match": '"d000-icon-32.png"' } })).status, 200);
    const head = await fetch(`${base}/apple-touch-icon.png`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "image/png");
    assert.equal(Number(head.headers.get("content-length")), fs.statSync(path.join(bi.brandDir(), "apple-touch-icon.png")).size);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });

  it("only GET and HEAD: a POST to an icon address goes on to whatever is after it", async () => {
    const res = await fetch(`${base}/icon-32.png`, { method: "POST" });
    assert.equal(res.status, 404);
  });

  it("the manifest: the version on every icon, one maskable icon (the one made for it), 192 and 512 for any purpose", async () => {
    for (const p of ["/manifest.json", "/manifest.json?v=old"]) {
      const res = await fetch(`${base}${p}`);
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get("content-type"), /^application\/manifest\+json/);
      assert.equal(res.headers.get("cache-control"), "no-cache");
      const m = await res.json();
      const v = bi.iconVersion();
      for (const icon of m.icons) assert.ok(icon.src.endsWith(`?v=${v}`), `${p}: ${icon.src}`);
      const maskable = m.icons.filter((i) => /maskable/.test(i.purpose || ""));
      assert.deepEqual(maskable, [{ src: `/icon-maskable-512.png?v=${v}`, sizes: "512x512", type: "image/png", purpose: "maskable" }], p);
      for (const size of ["192x192", "512x512"]) assert.ok(m.icons.some((i) => i.sizes === size && i.purpose === "any" && !/maskable/.test(i.src)), `${p}: ${size} any`);
      for (const sc of m.shortcuts || []) for (const icon of sc.icons || []) assert.ok(icon.src.endsWith(`?v=${v}`));
      const again = await fetch(`${base}${p}`, { headers: { "If-None-Match": res.headers.get("etag") } });
      assert.equal(again.status, 304);
    }
  });

  it("a manifest follows the icon: after a reset its icons carry the default's version", async () => {
    await bi.resetBrandIcon();
    const m = await (await fetch(`${base}/manifest.json`)).json();
    assert.ok(m.icons.every((i) => i.src.endsWith(`?v=${DEFAULT_VERSION}`)));
    assert.equal(await (await fetch(`${base}/icon-32.png`)).text(), "DEFAULT /icon-32.png", "and the default files are back");
  });

  it("versionedManifest keeps an 'any maskable' icon's other purpose", () => {
    const m = bi.versionedManifest({ icons: [{ src: "/icon-192.png", sizes: "192x192", purpose: "any maskable" }, { src: "/icon-512.png", sizes: "512x512", purpose: "maskable" }] }, "v1");
    assert.deepEqual(m.icons, [
      { src: "/icon-maskable-512.png?v=v1", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon-192.png?v=v1", sizes: "192x192", purpose: "any" },
    ]);
  });
});

// ---------------------------------------------------------------- the routes

describe("brand icon: GET, POST and DELETE /api/settings/brand-icon", () => {
  let server, base, db;
  const audit = [];
  before(async () => {
    await bi.resetBrandIcon();
    db = initDb(path.join(tmp, "t.db"));
    const app = express();
    app.set("db", db);
    app.set("auditLog", { log: (entry) => audit.push(entry) });
    app.use(express.json({ limit: "50mb" }));
    app.use((req, _res, next) => {
      req.auth = { authenticated: true, method: "session" };   // (what sessionAuth sets for a signed-in browser)
      next();
    });
    app.use("/api/settings", settingsRouter);
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}/api/settings/brand-icon`;
  });
  after(async () => { server?.close(); db?.close(); await bi.resetBrandIcon(); });

  const post = (body) => fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("GET: the default icon's state", async () => {
    const res = await fetch(base);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { custom: false, version: DEFAULT_VERSION, updatedAt: null });
  });

  it("POST: 400 with plain words for what is wrong", async () => {
    const cases = [
      [{}, /master must be a PNG in base64/],
      [{ master: "%%% not base64 %%%" }, /master must be a PNG in base64/],
      [{ master: JPEG.toString("base64") }, /must be a PNG/],
      [{ master: bi.encodePng(rgbaImage(70, 64, () => [0, 0, 0, 255])).toString("base64") }, /square/],
      [{ master: bi.encodePng(flat(32, [0, 0, 0, 255])).toString("base64") }, /too small/],
      [{ master: masterPng().toString("base64"), original: { name: "a.png", data: "" } }, /original\.data must be base64/],
      [{ master: masterPng().toString("base64"), original: "nope" }, /original\.data must be base64/],
      [{ master: masterPng().toString("base64"), original: { name: "a.txt", data: Buffer.from("words").toString("base64") } }, /not a PNG, JPEG, WebP or SVG/],
    ];
    for (const [body, re] of cases) {
      const res = await post(body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.match((await res.json()).error, re);
    }
    assert.equal(bi.brandStatus().custom, false, "nothing saved");
  });

  it("POST: a good one is saved (a data: address is fine too), and it goes in the audit log", async () => {
    const master = masterPng(256);
    const res = await post({ master: `data:image/png;base64,${master.toString("base64")}`, original: { name: "icon.svg", type: "image/svg+xml", data: SVG.toString("base64") } });
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.deepEqual([s.custom, s.version], [true, versionOf(master)]);
    assert.deepEqual(await (await fetch(base)).json(), s);
    assert.ok(fs.existsSync(path.join(bi.brandDir(), "original.svg")));
    assert.ok(audit.some((e) => e.action === "settings.brand_icon" && e.actor === "user" && e.detail.includes(s.version)));
  });

  it("DELETE: back to the default", async () => {
    const res = await fetch(base, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { custom: false, version: DEFAULT_VERSION, updatedAt: null });
    assert.ok(audit.some((e) => e.action === "settings.brand_icon_reset"));
  });
});

// ---------------------------------------------------------------- the page's side (js/brand-icon.js)

/**
 * js/brand-icon.js run on a stand-in page (its icon links and pictures; no Settings section) whose server answers
 * GET /api/settings/brand-icon with `answer`. signIn: fire "tarsee:signed-in", as app.js does once there is a session.
 */
async function page({ answer, signIn = true }) {
  const { default: vm } = await import("node:vm");
  const el = (tag, attrs) => {
    const node = {
      tagName: tag, attrs: { ...attrs },
      get rel() { return this.attrs.rel || ""; },
      getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
      setAttribute(n, v) { this.attrs[n] = String(v); },
      cloneNode() { return el(tag, this.attrs); },
      replaceWith(other) { els[els.indexOf(this)] = other; },
    };
    return node;
  };
  const els = [
    el("link", { rel: "icon", href: "/icon-32.png" }),
    el("link", { rel: "apple-touch-icon", href: "/apple-touch-icon.png" }),
    el("link", { rel: "manifest", href: "/manifest.json" }),
    el("link", { rel: "stylesheet", href: "/css/style.css" }),
    el("img", { src: "/icon-192.png" }),
    el("img", { src: "https://app.example/icon-32.png?v=old" }),
    el("img", { src: "/img/photo.png" }),
  ];
  const heard = [], listeners = {}, asked = [];
  const win = {
    location: { href: "https://app.example/", origin: "https://app.example" },
    URL, Promise, setTimeout, clearTimeout, console,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    dispatchEvent: (e) => { heard.push(e); for (const fn of listeners[e.type] || []) fn(e); return true; },
    fetch: async (url) => { asked.push(url); return answer; },
    document: {
      readyState: "complete",
      querySelectorAll: (sel) => (sel.startsWith("img")
        ? els.filter((e) => e.tagName === "img")
        : els.filter((e) => e.tagName === "link" && (/(^|\s)icon(\s|$)/.test(e.rel) || e.rel === "apple-touch-icon" || e.rel === "manifest"))),
      getElementById: () => null,
      addEventListener: () => {},
    },
  };
  win.window = win;
  vm.runInNewContext(fs.readFileSync(path.join(PUBLIC, "js/brand-icon.js"), "utf8"), win);
  if (signIn) win.dispatchEvent({ type: "tarsee:signed-in" });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const attr = (i) => els[i].getAttribute(els[i].tagName === "img" ? "src" : "href");
  return { asked, heard, attr, brand: win.TarseeBrand };
}
const answered = (status, body) => ({ ok: status === 200, status, json: async () => body });

describe("brand icon: TarseeBrand on the page", () => {
  it("before sign-in: nothing is asked, there is no version, and the addresses stay as they are", async () => {
    const { asked, brand, attr } = await page({ answer: answered(200, { custom: false, version: "d1" }), signIn: false });
    assert.deepEqual(asked, []);
    assert.equal(brand.version, null);
    assert.equal(brand.src("/icon-32.png"), "/icon-32.png");
    assert.equal(attr(0), "/icon-32.png");
    assert.ok(Object.isFrozen(brand) && brand.paths.includes("/favicon.ico"));
  });

  it("signed in: the version from GET /api/settings/brand-icon on every icon address, and tarsee:icon-changed", async () => {
    const { asked, brand, heard, attr } = await page({ answer: answered(200, { custom: true, version: "def456", updatedAt: "2026-01-01T00:00:00.000Z" }) });
    assert.deepEqual(asked, ["/api/settings/brand-icon"]);
    assert.equal(brand.version, "def456");
    assert.equal(brand.src("/icon-32.png"), "/icon-32.png?v=def456");
    assert.equal(brand.src("/icon-192.png?v=old"), "/icon-192.png?v=def456");
    assert.equal(brand.src("/manifest.json"), "/manifest.json?v=def456");
    assert.equal(brand.src("/js/app.js"), "/js/app.js");
    assert.equal(brand.src("https://elsewhere.example/icon-32.png"), "https://elsewhere.example/icon-32.png");
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(attr), [
      "/icon-32.png?v=def456", "/apple-touch-icon.png?v=def456", "/manifest.json?v=def456", "/css/style.css",
      "/icon-192.png?v=def456", "https://app.example/icon-32.png?v=def456", "/img/photo.png",
    ]);
    const changed = heard.filter((e) => e.type === "tarsee:icon-changed");
    assert.equal(changed.length, 1);
    assert.deepEqual({ ...changed[0].detail }, { version: "def456", initial: true });
  });

  it("a lapsed session (401): no version, and the page is left as it is", async () => {
    const { asked, brand, attr } = await page({ answer: answered(401, { error: "Unauthorized" }) });
    assert.equal(asked.length, 1);
    assert.equal(brand.version, null);
    assert.equal(attr(0), "/icon-32.png");
  });
});
