// Tarsee's own icon, replaceable from Settings → Appearance ("Tarsee's icon").
//
// The dashboard (src/public/js/brand-icon.js) lets the owner pick a picture, crop it square in the browser, and send
// two things to POST /api/settings/brand-icon: a 1024x1024 PNG of the crop (the "master") and the file that was
// picked (the "original", kept as it came, for reference). From the master this module makes every icon a browser or
// an installed app asks for (favicon.ico, the 16 and 32 px tab icons, the iOS home-screen icon, the PWA's 192 and
// 512 px icons, and a maskable 512 px icon that Android cuts into its own shape) and serves them at the usual
// addresses in place of the default files in src/public. The defaults are never touched, so a reset only has to
// remove the upload.
//
// There is no image library in the app and this does not add one: a PNG is a zlib stream of filtered rows, small
// enough to read and write by hand. So this file has its own PNG decoder (every colour type and bit depth, all five
// row filters; interlaced files are refused), an area-average downscaler (each output pixel the exact average of the
// source area it covers, partly covered pixels weighted by the part they cover), a PNG encoder and an ICO writer
// that holds PNGs.
//
// Everything lives in the data folder (on the persistent volume in a container deploy), never in git:
// <DATA_DIR>/brand holds master.png, the generated icons, original.<ext> and brand.json
// ({ version, updatedAt, originalName, originalType, background }). The version is the first 12 hex characters of
// the master's sha256; the page and the manifest add it to every icon address (?v=) so a browser that kept the old
// picture asks again. The default icon's version is "d" followed by 11 characters of icon-512.png's hash.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import config from "../config/env.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

export const MASTER_MIN = 64;
export const MASTER_MAX = 2048;
export const MASTER_MAX_BYTES = 15 * 1024 * 1024;
export const ORIGINAL_MAX_BYTES = 10 * 1024 * 1024;
/** The app's dark background (tokens.css --bg): behind an icon whose edge is see-through, where one must be opaque. */
export const DEFAULT_BACKGROUND = [0x1a, 0x1a, 0x1a];
/** How much of the maskable icon the picture fills: Android's mask may cut anything outside the middle 80%. */
export const MASKABLE_FILL = 0.8;

/** The addresses an uploaded icon is served at, and what each is. */
export const ICON_FILES = Object.freeze({
  "/favicon.ico": "image/x-icon",
  "/icon-16.png": "image/png",
  "/icon-32.png": "image/png",
  "/apple-touch-icon.png": "image/png",
  "/icon-192.png": "image/png",
  "/icon-512.png": "image/png",
  "/icon-maskable-512.png": "image/png",
});

/** A refusal of what was sent (the route answers 400 with its words). */
export class BrandIconError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrandIconError";
    this.status = 400;
  }
}
const refuse = (message) => new BrandIconError(message);

// ---------------------------------------------------------------- CRC32 (PNG chunks)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- PNG decoding

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

export function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** A PNG's header (its first chunk, IHDR), read without unpacking the picture: { width, height, bitDepth, colorType, interlace }. */
export function readPngHeader(buf) {
  if (!isPng(buf)) throw refuse("That is not a PNG file.");
  if (buf.length < 33 || buf.toString("latin1", 12, 16) !== "IHDR" || buf.readUInt32BE(8) !== 13) throw refuse("The PNG file has no proper header.");
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    compression: buf[26],
    filter: buf[27],
    interlace: buf[28],
  };
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Undo the row filters of `raw` (each row: a filter byte, then `stride` bytes) into one buffer of plain rows. */
function unfilter(raw, height, stride, bpp) {
  const out = new Uint8Array(height * stride);
  let at = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[at++];
    const row = y * stride, up = row - stride;
    const hasUp = y > 0;
    switch (ft) {
      case 0:
        out.set(raw.subarray(at, at + stride), row);
        break;
      case 1:
        for (let i = 0; i < stride; i++) out[row + i] = (raw[at + i] + (i >= bpp ? out[row + i - bpp] : 0)) & 255;
        break;
      case 2:
        for (let i = 0; i < stride; i++) out[row + i] = (raw[at + i] + (hasUp ? out[up + i] : 0)) & 255;
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? out[row + i - bpp] : 0, b = hasUp ? out[up + i] : 0;
          out[row + i] = (raw[at + i] + ((a + b) >> 1)) & 255;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? out[row + i - bpp] : 0, b = hasUp ? out[up + i] : 0, c = hasUp && i >= bpp ? out[up + i - bpp] : 0;
          out[row + i] = (raw[at + i] + paeth(a, b, c)) & 255;
        }
        break;
      default:
        throw refuse(`The PNG file is damaged (row ${y} has an unknown filter, ${ft}).`);
    }
    at += stride;
  }
  return out;
}

/**
 * A PNG as RGBA, 8 bits a channel: { width, height, data } (data: width x height x 4 bytes, rows top to bottom).
 * Colour types 0 (gray), 2 (RGB), 3 (palette, with PLTE and tRNS), 4 (gray and alpha), 6 (RGBA), at every bit depth
 * the format allows. 16-bit samples are rounded to 8; a gray of 1, 2 or 4 bits is spread over 0 to 255.
 */
export function decodePng(buf, { maxPixels = MASTER_MAX * MASTER_MAX } = {}) {
  const head = readPngHeader(buf);
  const { width, height, bitDepth, colorType } = head;
  if (!width || !height) throw refuse("The PNG file is 0 pixels across.");
  if (!(colorType in CHANNELS) || !DEPTHS[colorType].includes(bitDepth)) throw refuse(`The PNG file has a colour type (${colorType}) and bit depth (${bitDepth}) that do not go together.`);
  if (head.compression !== 0 || head.filter !== 0) throw refuse("The PNG file uses a compression or filter method that does not exist.");
  if (head.interlace === 1) throw refuse("Interlaced PNG files are not supported: save it again without interlacing.");
  if (head.interlace !== 0) throw refuse("The PNG file has an unknown interlace method.");
  if (width * height > maxPixels) throw refuse(`The PNG file is too big (${width} by ${height} pixels).`);

  let palette = null, trns = null;
  const idat = [];
  let at = 8;
  while (at + 12 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const start = at + 8, end = start + len;
    if (end + 4 > buf.length) throw refuse("The PNG file is cut short.");
    if (crc32(buf.subarray(at + 4, end)) !== buf.readUInt32BE(end)) throw refuse(`The PNG file is damaged (its ${type.replace(/[^A-Za-z]/g, "?")} chunk fails its checksum).`);
    const data = buf.subarray(start, end);
    if (type === "IEND") break;
    if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type !== "IHDR" && !(type.charCodeAt(0) & 0x20)) throw refuse(`The PNG file has a part this app cannot read (${type.replace(/[^A-Za-z]/g, "?")}).`);
    at = end + 4;
  }
  if (!idat.length) throw refuse("The PNG file has no picture in it.");
  if (colorType === 3 && (!palette || palette.length % 3 || !palette.length)) throw refuse("The PNG file has no proper palette.");

  const channels = CHANNELS[colorType];
  const bitsPerPixel = channels * bitDepth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const expected = height * (stride + 1);
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch {
    throw refuse("The PNG file is damaged (its picture data will not unpack).");
  }
  if (raw.length < expected) throw refuse("The PNG file is cut short (its picture data ends early).");
  const px = unfilter(raw, height, stride, bpp);

  const rgba = new Uint8Array(width * height * 4);
  const max = (1 << bitDepth) - 1;
  // A sample as stored (before any scaling): what tRNS compares against.
  const sampleAt = (row, x, c) => {
    if (bitDepth === 8) return px[row + x * channels + c];
    if (bitDepth === 16) { const i = row + (x * channels + c) * 2; return (px[i] << 8) | px[i + 1]; }
    const bit = x * bitDepth;   // (1, 2 or 4 bits: one channel only, gray or palette)
    return (px[row + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & max;
  };
  const to8 = bitDepth === 16 ? (v) => Math.round(v / 257) : bitDepth === 8 ? (v) => v : (v) => Math.round((v * 255) / max);
  const trnsGray = colorType === 0 && trns && trns.length >= 2 ? trns.readUInt16BE(0) & 0xffff : -1;
  const trnsRgb = colorType === 2 && trns && trns.length >= 6 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null;
  const colours = palette ? palette.length / 3 : 0;

  for (let y = 0; y < height; y++) {
    const row = y * stride;
    let o = y * width * 4;
    for (let x = 0; x < width; x++, o += 4) {
      switch (colorType) {
        case 0: {
          const g = sampleAt(row, x, 0);
          rgba[o] = rgba[o + 1] = rgba[o + 2] = to8(g);
          rgba[o + 3] = g === trnsGray ? 0 : 255;
          break;
        }
        case 2: {
          const r = sampleAt(row, x, 0), g = sampleAt(row, x, 1), b = sampleAt(row, x, 2);
          rgba[o] = to8(r); rgba[o + 1] = to8(g); rgba[o + 2] = to8(b);
          rgba[o + 3] = trnsRgb && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2] ? 0 : 255;
          break;
        }
        case 3: {
          const i = sampleAt(row, x, 0);
          if (i >= colours) throw refuse("The PNG file is damaged (a pixel names a colour its palette does not have).");
          rgba[o] = palette[i * 3]; rgba[o + 1] = palette[i * 3 + 1]; rgba[o + 2] = palette[i * 3 + 2];
          rgba[o + 3] = trns && i < trns.length ? trns[i] : 255;
          break;
        }
        case 4: {
          rgba[o] = rgba[o + 1] = rgba[o + 2] = to8(sampleAt(row, x, 0));
          rgba[o + 3] = to8(sampleAt(row, x, 1));
          break;
        }
        default: {
          rgba[o] = to8(sampleAt(row, x, 0)); rgba[o + 1] = to8(sampleAt(row, x, 1));
          rgba[o + 2] = to8(sampleAt(row, x, 2)); rgba[o + 3] = to8(sampleAt(row, x, 3));
        }
      }
    }
  }
  return { width, height, data: rgba };
}

// ---------------------------------------------------------------- PNG and ICO encoding

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Filter one row of RGBA (`cur`, the row above `prev` or null) with filter `ft` into `dst`. */
function filterRow(ft, cur, prev, dst) {
  const n = cur.length;
  for (let i = 0; i < n; i++) {
    const a = i >= 4 ? cur[i - 4] : 0, b = prev ? prev[i] : 0, c = prev && i >= 4 ? prev[i - 4] : 0;
    const pred = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : paeth(a, b, c);
    dst[i] = (cur[i] - pred) & 255;
  }
}

/**
 * An RGBA image as a PNG (8-bit RGBA). Each row gets the filter that leaves it the smallest numbers (the usual
 * rule of thumb), or `filter` (0 to 4) for every row.
 */
export function encodePng({ width, height, data }, { filter = "auto", level = 6 } = {}) {
  if (!(width > 0 && height > 0) || data.length !== width * height * 4) throw new Error("encodePng: data is not width x height x 4 bytes");
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  const trial = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const cur = data.subarray(y * stride, (y + 1) * stride);
    const prev = y ? data.subarray((y - 1) * stride, y * stride) : null;
    let best = typeof filter === "number" ? filter : -1;
    if (best < 0) {
      let score = Infinity;
      for (let ft = 0; ft < 5; ft++) {
        filterRow(ft, cur, prev, trial[ft]);
        let s = 0;
        const t = trial[ft];
        for (let i = 0; i < stride; i++) s += t[i] < 128 ? t[i] : 256 - t[i];
        if (s < score) { score = s; best = ft; }
      }
    } else {
      filterRow(best, cur, prev, trial[best]);
    }
    const o = y * (stride + 1);
    raw[o] = best;
    raw.set(trial[best], o + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level })), chunk("IEND", Buffer.alloc(0))]);
}

/** An ICO file holding PNGs ([{ size, png }], each square): what Windows and every browser read for /favicon.ico. */
export function encodeIco(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);   // reserved
  head.writeUInt16LE(1, 2);   // 1: an icon (2 would be a cursor)
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head[e] = size >= 256 ? 0 : size;       // width (0 means 256)
    head[e + 1] = size >= 256 ? 0 : size;   // height
    head[e + 2] = 0;                        // colours in a palette: none
    head[e + 3] = 0;                        // reserved
    head.writeUInt16LE(1, e + 4);           // colour planes
    head.writeUInt16LE(32, e + 6);          // bits a pixel
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map((im) => im.png)]);
}

// ---------------------------------------------------------------- resizing and backgrounds

/**
 * For one axis, from n source pixels to m: which source pixels make each output pixel, and how much of it each.
 * Smaller (m < n): the area average, every output pixel covering n/m source pixels, the two at its ends by the part
 * of them it covers. Bigger (m > n): bilinear, between the two nearest source pixels.
 */
function axisWeights(n, m) {
  const start = new Int32Array(m + 1), idx = [], w = [];
  const scale = n / m;
  for (let i = 0; i < m; i++) {
    start[i] = idx.length;
    if (m < n) {
      const a = i * scale, b = (i + 1) * scale;
      let sum = 0;
      const from = idx.length;
      for (let j = Math.floor(a); j < Math.min(n, Math.ceil(b)); j++) {
        const cover = Math.min(j + 1, b) - Math.max(j, a);
        if (cover > 1e-9) { idx.push(j); w.push(cover); sum += cover; }
      }
      for (let k = from; k < w.length; k++) w[k] /= sum;
    } else if (m > n) {
      const centre = Math.min(n - 1, Math.max(0, (i + 0.5) * scale - 0.5));
      const j = Math.floor(centre), f = centre - j;
      idx.push(j); w.push(1 - f);
      if (f > 1e-9 && j + 1 < n) { idx.push(j + 1); w.push(f); }
      else w[w.length - 1] = 1;
    } else {
      idx.push(i); w.push(1);
    }
  }
  start[m] = idx.length;
  return { start, idx: Int32Array.from(idx), w: Float32Array.from(w) };
}

/**
 * An RGBA image at another size: { width, height, data }. The colours are weighed by their alpha (premultiplied)
 * while they are averaged, so a see-through pixel's colour never bleeds a dark fringe into its opaque neighbours.
 */
export function resizeRgba(img, width, height) {
  const { width: sw, height: sh, data } = img;
  if (sw === width && sh === height) return { width, height, data: new Uint8Array(data) };
  const H = axisWeights(sw, width), V = axisWeights(sh, height);
  // Across first: every source row to `width` pixels, premultiplied.
  const across = new Float32Array(width * sh * 4);
  for (let y = 0; y < sh; y++) {
    const src = y * sw * 4, dst = y * width * 4;
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = H.start[x]; k < H.start[x + 1]; k++) {
        const s = src + H.idx[k] * 4, wa = H.w[k] * data[s + 3];
        r += data[s] * wa; g += data[s + 1] * wa; b += data[s + 2] * wa; a += wa;
      }
      const o = dst + x * 4;
      across[o] = r; across[o + 1] = g; across[o + 2] = b; across[o + 3] = a;
    }
  }
  // Then down, and back from premultiplied.
  const out = new Uint8Array(width * height * 4);
  const acc = new Float64Array(width * 4);
  for (let y = 0; y < height; y++) {
    acc.fill(0);
    for (let k = V.start[y]; k < V.start[y + 1]; k++) {
      const wy = V.w[k], row = V.idx[k] * width * 4;
      for (let i = 0; i < width * 4; i++) acc[i] += across[row + i] * wy;
    }
    const o = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = x * 4, a = acc[i + 3];
      if (a <= 1e-6) continue;   // (fully see-through: 0, 0, 0, 0)
      out[o + i] = clamp8(acc[i] / a);
      out[o + i + 1] = clamp8(acc[i + 1] / a);
      out[o + i + 2] = clamp8(acc[i + 2] / a);
      out[o + i + 3] = clamp8(a);
    }
  }
  return { width, height, data: out };
}
const clamp8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/**
 * The colour to put behind the icon where it must be opaque: the average of its edge's opaque pixels when the edge
 * is mostly opaque (a full-bleed icon, a rounded square: the background carries on from it), else the app's dark
 * background. The edge is a ring about 1/64 of the icon thick, so one soft outer pixel does not decide it.
 */
export function edgeBackground(img, { fallback = DEFAULT_BACKGROUND } = {}) {
  const { width: w, height: h, data } = img;
  const t = Math.max(1, Math.round(Math.min(w, h) / 64));
  let total = 0, opaque = 0, r = 0, g = 0, b = 0;
  const take = (x, y) => {
    const o = (y * w + x) * 4;
    total++;
    if (data[o + 3] >= 250) { opaque++; r += data[o]; g += data[o + 1]; b += data[o + 2]; }
  };
  for (let y = 0; y < h; y++) {
    if (y < t || y >= h - t) { for (let x = 0; x < w; x++) take(x, y); continue; }
    for (let x = 0; x < Math.min(t, w); x++) take(x, y);
    for (let x = Math.max(t, w - t); x < w; x++) take(x, y);
  }
  if (!total || opaque / total <= 0.5) return [...fallback];
  return [Math.round(r / opaque), Math.round(g / opaque), Math.round(b / opaque)];
}

/** The image drawn over a background colour: fully opaque (an iPhone turns see-through parts of its icon black). */
export function flattenRgba(img, bg) {
  const { width, height, data } = img;
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    out[i] = Math.round(data[i] * a + bg[0] * (1 - a));
    out[i + 1] = Math.round(data[i + 1] * a + bg[1] * (1 - a));
    out[i + 2] = Math.round(data[i + 2] * a + bg[2] * (1 - a));
    out[i + 3] = 255;
  }
  return { width, height, data: out };
}

/** The maskable icon: the picture at MASKABLE_FILL of `size`, in the middle of an opaque square of the background. */
export function maskableRgba(master, size, bg) {
  const inner = Math.round(size * MASKABLE_FILL);
  const small = flattenRgba(resizeRgba(master, inner, inner), bg);
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < out.length; i += 4) { out[i] = bg[0]; out[i + 1] = bg[1]; out[i + 2] = bg[2]; out[i + 3] = 255; }
  const off = Math.floor((size - inner) / 2);
  for (let y = 0; y < inner; y++) out.set(small.data.subarray(y * inner * 4, (y + 1) * inner * 4), ((y + off) * size + off) * 4);
  return { width: size, height: size, data: out };
}

const pause = () => new Promise((r) => setImmediate(r));

/**
 * Every icon from a square RGBA master: { files: { "icon-16.png": Buffer, ..., "favicon.ico": Buffer }, background }.
 * It stops for a moment between icons, so a big master does not hold up the server's other work.
 */
export async function makeIconSet(master) {
  const bg = edgeBackground(master);
  const at = (n) => resizeRgba(master, n, n);
  const files = {};
  files["icon-16.png"] = encodePng(at(16));
  files["icon-32.png"] = encodePng(at(32));
  files["favicon.ico"] = encodeIco([
    { size: 16, png: files["icon-16.png"] },
    { size: 32, png: files["icon-32.png"] },
    { size: 48, png: encodePng(at(48)) },
  ]);
  await pause();
  files["apple-touch-icon.png"] = encodePng(flattenRgba(at(180), bg));
  await pause();
  files["icon-192.png"] = encodePng(at(192));
  await pause();
  files["icon-512.png"] = encodePng(at(512));
  await pause();
  files["icon-maskable-512.png"] = encodePng(maskableRgba(master, 512, bg));
  return { files, background: bg };
}

// ---------------------------------------------------------------- what was uploaded

/** A file's real type by its first bytes (a PNG, JPEG or WebP), or an SVG by a light look (text with an <svg element). */
export function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return null;
  if (isPng(buf)) return { ext: "png", type: "image/png" };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return { ext: "webp", type: "image/webp" };
  if (!buf.includes(0) && /<svg[\s>/]/i.test(buf.toString("utf8"))) return { ext: "svg", type: "image/svg+xml" };
  return null;
}

/** Base64 (a data: address's too) as bytes, or null when it is not base64 at all. */
export function decodeBase64(text) {
  if (typeof text !== "string") return null;
  const body = text.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  const buf = Buffer.from(body, "base64");
  return buf.length ? buf : null;
}

/** The original's file name as it is kept in brand.json: no folders, no control characters, 200 characters at most. */
const cleanName = (name) => path.basename(String(name || "")).replace(/\p{Cc}/gu, "").trim().slice(0, 200);

// ---------------------------------------------------------------- the files on disk

export const brandDir = () => path.join(config.DATA_DIR, "brand");

let defaultVersion = null;
/** The default icon's version: "d" and the start of icon-512.png's sha256 (worked out once). */
function defaultIconVersion() {
  if (!defaultVersion) {
    try {
      defaultVersion = "d" + crypto.createHash("sha256").update(fs.readFileSync(path.join(PUBLIC_DIR, "icon-512.png"))).digest("hex").slice(0, 11);
    } catch {
      defaultVersion = "d0";
    }
  }
  return defaultVersion;
}

let state = null;        // { custom, version, updatedAt }
let served = new Map();  // file name -> its bytes, for the version in `state`

/** What is in use now, from brand.json the first time (and after a save or reset, from memory). */
function current() {
  if (state) return state;
  state = { custom: false, version: defaultIconVersion(), updatedAt: null };
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(brandDir(), "brand.json"), "utf8"));
    const whole = Object.keys(ICON_FILES).every((p) => fs.existsSync(path.join(brandDir(), p.slice(1))));
    if (/^[0-9a-f]{12}$/.test(meta?.version || "") && whole) {
      state = { custom: true, version: meta.version, updatedAt: meta.updatedAt || null };
    } else if (meta) {
      console.warn("[brand-icon] brand.json is there but the icons are not all there: using the default icon");
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.warn("[brand-icon] could not read brand.json:", err.message);
  }
  return state;
}

/** The icon's version now: the uploaded one's, or the default's. Cheap (kept in memory). */
export function iconVersion() {
  return current().version;
}

/** { custom, version, updatedAt }: whether an uploaded icon is in use, its version, and when it was saved. */
export function brandStatus() {
  const s = current();
  return { custom: s.custom, version: s.version, updatedAt: s.updatedAt };
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

// One save or reset at a time: two at once would leave a mix of both.
let queue = Promise.resolve();
const oneAtATime = (job) => {
  const run = queue.then(job);
  queue = run.catch(() => {});
  return run;
};

/**
 * Save an uploaded icon. master: the PNG of the crop (square, 64 to 2048 pixels); original (optional): the file that
 * was picked, { name, type, data }, kept as it came (a PNG, JPEG, WebP or SVG, 10 MB at most). Refusals are
 * BrandIconError (status 400). Gives brandStatus().
 */
export function saveBrandIcon({ master, original } = {}) {
  return oneAtATime(async () => {
    if (!Buffer.isBuffer(master) || !master.length) throw refuse("No icon came with it.");
    if (master.length > MASTER_MAX_BYTES) throw refuse("The icon is too big: 15 MB at most.");
    if (!isPng(master)) throw refuse("The icon must be a PNG file.");
    const head = readPngHeader(master);
    if (head.width !== head.height) throw refuse(`The icon must be square (this one is ${head.width} by ${head.height}).`);
    if (head.width < MASTER_MIN) throw refuse(`The icon is too small: ${MASTER_MIN} pixels across at least (this one is ${head.width}).`);
    if (head.width > MASTER_MAX) throw refuse(`The icon is too big: ${MASTER_MAX} pixels across at most (this one is ${head.width}).`);

    let orig = null;
    if (original != null) {
      const data = original.data;
      if (!Buffer.isBuffer(data) || !data.length) throw refuse("The original file came through empty.");
      if (data.length > ORIGINAL_MAX_BYTES) throw refuse("The original file is too big: 10 MB at most.");
      const kind = sniffImageType(data);
      if (!kind) throw refuse("The original file is not a PNG, JPEG, WebP or SVG image.");
      orig = { ...kind, data, name: cleanName(original.name) || `original.${kind.ext}` };
    }

    const img = decodePng(master, { maxPixels: MASTER_MAX * MASTER_MAX });
    const { files, background } = await makeIconSet(img);
    const version = crypto.createHash("sha256").update(master).digest("hex").slice(0, 12);

    const dir = brandDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const f of fs.readdirSync(dir)) if (f.includes(".tmp-")) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* gone */ } }
    writeAtomic(path.join(dir, "master.png"), master);
    for (const [name, data] of Object.entries(files)) writeAtomic(path.join(dir, name), data);
    if (orig) {
      writeAtomic(path.join(dir, `original.${orig.ext}`), orig.data);
      for (const f of fs.readdirSync(dir)) if (/^original\./.test(f) && f !== `original.${orig.ext}`) fs.rmSync(path.join(dir, f), { force: true });
    }
    const updatedAt = new Date().toISOString();
    const prev = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, "brand.json"), "utf8")); } catch { return {}; } })();
    // brand.json last: until it is written the icons in use are the ones before.
    writeAtomic(path.join(dir, "brand.json"), JSON.stringify({
      version,
      updatedAt,
      originalName: orig ? orig.name : prev.originalName || null,
      originalType: orig ? orig.type : prev.originalType || null,
      background: "#" + background.map((c) => c.toString(16).padStart(2, "0")).join(""),
    }, null, 2) + "\n");
    state = { custom: true, version, updatedAt };
    served = new Map();
    console.log(`[brand-icon] new icon saved (version ${version})`);
    return brandStatus();
  });
}

/** Back to the default icon: the uploaded files are removed. Gives brandStatus(). */
export function resetBrandIcon() {
  return oneAtATime(async () => {
    const dir = brandDir();
    // brand.json first: from then on the default icons are served, whatever is left.
    fs.rmSync(path.join(dir, "brand.json"), { force: true });
    state = { custom: false, version: defaultIconVersion(), updatedAt: null };
    served = new Map();
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* no folder: nothing to remove */ }
    for (const f of names) {
      if (f === "master.png" || f.startsWith("original.") || f.includes(".tmp-") || ICON_FILES["/" + f]) fs.rmSync(path.join(dir, f), { force: true });
    }
    console.log("[brand-icon] back to the default icon");
    return brandStatus();
  });
}

/** An uploaded icon's bytes (kept in memory once read), or null. */
function customFile(name) {
  if (served.has(name)) return served.get(name);
  let buf = null;
  try { buf = fs.readFileSync(path.join(brandDir(), name)); } catch { /* not there: the default */ }
  if (buf) served.set(name, buf);
  return buf;
}

/** Does an If-None-Match header name this ETag (or *)? */
function etagMatches(header, etag) {
  if (!header) return false;
  const bare = etag.replace(/^W\//, "");
  return String(header).split(",").some((t) => { const v = t.trim(); return v === "*" || v.replace(/^W\//, "") === bare; });
}

/**
 * Express middleware for the icon addresses (ICON_FILES), GET and HEAD, whatever the query (?v=): an uploaded icon
 * is sent from the data folder; with none, express.static after it sends the default file. Either way the browser is
 * told to ask again each time (no-cache: it gets a 304 while nothing changed), so the new icon shows at once. No
 * sign-in: browsers fetch icons without cookies, and the sign-in page shows the icon too.
 */
export function brandIconMiddleware() {
  return function brandIcon(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const type = ICON_FILES[req.path];
    if (!type) return next();
    res.setHeader("Cache-Control", "no-cache");
    const s = current();
    if (!s.custom) return next();
    const name = req.path.slice(1);
    const buf = customFile(name);
    if (!buf) return next();
    const etag = `"${s.version}-${name}"`;
    res.setHeader("ETag", etag);
    res.setHeader("Content-Type", type);
    if (etagMatches(req.headers["if-none-match"], etag)) return res.status(304).end();
    res.setHeader("Content-Length", buf.length);
    if (req.method === "HEAD") return res.status(200).end();
    res.status(200).end(buf);
  };
}

/** An address on this site with the icon's version on it (?v=); anything else as it was. */
export function withVersion(src, version) {
  if (typeof src !== "string" || !src.startsWith("/") || src.startsWith("//")) return src;
  return `${src.split(/[?#]/)[0]}?v=${encodeURIComponent(version)}`;
}

/**
 * A web app manifest with the icon's version on every icon, and its maskable icon the one made for it
 * (/icon-maskable-512.png, the picture inside Android's safe zone) in place of the plain 192 and 512.
 */
export function versionedManifest(base, version) {
  const out = JSON.parse(JSON.stringify(base || {}));
  const v = (src) => withVersion(src, version);
  if (Array.isArray(out.icons)) {
    const icons = [];
    let maskable = false;
    for (const icon of out.icons) {
      const purposes = String(icon.purpose || "any").split(/\s+/).filter(Boolean);
      if (!purposes.includes("maskable")) { icons.push({ ...icon, src: v(icon.src) }); continue; }
      if (!maskable) {
        icons.push({ src: v("/icon-maskable-512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" });
        maskable = true;
      }
      const rest = purposes.filter((p) => p !== "maskable");
      if (rest.length) icons.push({ ...icon, src: v(icon.src), purpose: rest.join(" ") });
    }
    out.icons = icons;
  }
  for (const sc of Array.isArray(out.shortcuts) ? out.shortcuts : []) {
    if (Array.isArray(sc.icons)) sc.icons = sc.icons.map((icon) => ({ ...icon, src: v(icon.src) }));
  }
  return out;
}

/**
 * Express handler for /manifest.json: publicDir's manifest.json with versionedManifest() applied, never kept by the
 * browser without asking (no-cache). If the file cannot be read, the request goes on to express.static.
 */
export function manifestHandler(publicDir) {
  const file = path.join(publicDir, "manifest.json");
  let read = null;   // { mtimeMs, json }: parsed once, again only when the file changes
  return function manifest(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path !== "/manifest.json") return next();
    let base;
    try {
      const { mtimeMs } = fs.statSync(file);
      if (!read || read.mtimeMs !== mtimeMs) read = { mtimeMs, json: JSON.parse(fs.readFileSync(file, "utf8")) };
      base = read.json;
    } catch (err) {
      console.warn("[brand-icon] could not read manifest.json:", err.message);
      return next();
    }
    const body = JSON.stringify(versionedManifest(base, iconVersion()), null, 2);
    const etag = `"m${crypto.createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
    res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("ETag", etag);
    if (etagMatches(req.headers["if-none-match"], etag)) return res.status(304).end();
    res.setHeader("Content-Length", Buffer.byteLength(body));
    if (req.method === "HEAD") return res.status(200).end();
    res.status(200).end(body);
  };
}

/** For tests: forget what is in memory (the next call reads brand.json again). */
export function __forgetBrandState() {
  state = null;
  served = new Map();
}
