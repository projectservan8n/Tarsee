/**
 * A small, strict .tar.gz extractor, for the standalone Python archive (python-runtime.js). Node has no tar of its
 * own, and running the system's tar on a download would hand it whatever the archive asks for; this one only ever
 * writes inside its folder:
 *   - no absolute paths, drive letters or ".." parts; nothing written through a symlink (links are made last);
 *   - a symlink must be relative and, once made, resolve inside the folder (a chain of links that leads out is
 *     caught); on Windows, where making one needs extra rights, a link to a file is copied instead;
 *   - hard links are copies of a file already extracted; devices, fifos and anything else are refused;
 *   - modes keep their execute bits but never setuid, setgid or write for others.
 * Any refusal, or a damaged archive, removes the half-made folder. Nothing in the archive is ever run here.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const BLOCK = 512;

const refuse = (why) => Object.assign(new Error(`the archive ${why}`), { code: "BAD_ARCHIVE" });

function cstr(buf, start, len) {
  const s = buf.subarray(start, start + len);
  const end = s.indexOf(0);
  return (end >= 0 ? s.subarray(0, end) : s).toString("utf8");
}

function octal(buf, start, len) {
  // GNU base-256 for big numbers: the high bit of the first byte is set.
  if (buf[start] & 0x80) {
    let n = 0;
    for (let i = start + 1; i < start + len; i++) n = n * 256 + buf[i];
    return n;
  }
  const s = cstr(buf, start, len).trim();
  return s ? Number.parseInt(s, 8) : 0;
}

/** The header's checksum: the unsigned sum POSIX asks for, or the signed one some old writers made. */
function checksumOk(h) {
  let sum = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 32 : h[i];
    sum += b;
    signed += b > 127 ? b - 256 : b;
  }
  const want = octal(h, 148, 8);
  return want === sum || want === signed;
}

function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number.parseInt(buf.subarray(i, sp).toString("ascii"), 10);
    if (!(len > 0)) break;
    const rec = buf.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** The parts of an entry's name once `strip` leading folders are gone; throws for anything that could leave dest. */
function partsOf(name, strip) {
  if (name.includes("\0") || name.includes("\\")) throw refuse(`has a name it should not: ${JSON.stringify(name.slice(0, 120))}`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw refuse(`has an absolute path: ${name.slice(0, 120)}`);
  const parts = name.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) throw refuse(`has a path outside its folder: ${name.slice(0, 120)}`);
  if (parts.some((p) => p.includes(":"))) throw refuse(`has a name Windows can't hold: ${name.slice(0, 120)}`);
  return parts.slice(strip);
}

const isInside = (root, p) => p === root || p.startsWith(root + path.sep);

/**
 * Extract the gzip'd tar `file` into `dest` (which must not exist yet), dropping `strip` leading folders from every
 * name. Resolves with counts { files, dirs, links }.
 */
export async function extractTarGz(file, dest, { strip = 0 } = {}) {
  if (fs.existsSync(dest)) throw new Error(`extractTarGz: ${dest} already exists`);
  fs.mkdirSync(dest, { recursive: true });
  const root = fs.realpathSync(dest);
  const counts = { files: 0, dirs: 0, links: 0 };
  const links = [];
  const hardlinks = [];
  try {
    await readEntries(file, async (entry, readBody) => {
      const parts = partsOf(entry.name, strip);
      if (parts.length === 0) { await readBody(null); return; }
      const target = path.join(root, ...parts);
      if (!isInside(root, target)) throw refuse(`has a path outside its folder: ${entry.name.slice(0, 120)}`);
      if (entry.type === "dir") {
        fs.mkdirSync(target, { recursive: true });
        counts.dirs++;
        await readBody(null);
      } else if (entry.type === "file") {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (fs.existsSync(target) && fs.lstatSync(target).isDirectory()) throw refuse(`names ${parts.join("/")} as both a file and a folder`);
        fs.rmSync(target, { force: true });
        const fd = fs.openSync(target, "w", safeMode(entry.mode));
        try { await readBody((chunk) => fs.writeSync(fd, chunk)); } finally { fs.closeSync(fd); }
        try { fs.chmodSync(target, safeMode(entry.mode)); } catch { /* Windows */ }
        counts.files++;
      } else if (entry.type === "symlink") {
        const link = entry.linkname;
        if (!link || link.startsWith("/") || /^[A-Za-z]:/.test(link) || link.includes("\\") || link.includes("\0")) {
          throw refuse(`has a link that points outside its folder: ${parts.join("/")} -> ${link}`);
        }
        if (!isInside(root, path.resolve(path.dirname(target), link))) {
          throw refuse(`has a link that points outside its folder: ${parts.join("/")} -> ${link}`);
        }
        links.push({ target, link, name: parts.join("/") });
        await readBody(null);
      } else if (entry.type === "hardlink") {
        const from = path.join(root, ...partsOf(entry.linkname, strip));
        if (!isInside(root, from)) throw refuse(`has a hard link outside its folder: ${parts.join("/")}`);
        hardlinks.push({ target, from, name: parts.join("/") });
        await readBody(null);
      } else {
        throw refuse(`has an entry of a kind it should not (${entry.type}): ${parts.join("/")}`);
      }
    });

    for (const h of hardlinks) {
      if (!fs.existsSync(h.from) || !fs.lstatSync(h.from).isFile()) throw refuse(`has a hard link to nothing: ${h.name}`);
      fs.mkdirSync(path.dirname(h.target), { recursive: true });
      fs.copyFileSync(h.from, h.target);
      counts.files++;
    }

    // Links last, so no file was ever written through one.
    for (const l of links) {
      if (fileExists(l.target)) throw refuse(`names ${l.name} twice`);
      fs.mkdirSync(path.dirname(l.target), { recursive: true });
      try {
        fs.symlinkSync(l.link, l.target);
      } catch (err) {
        if (process.platform !== "win32" || (err.code !== "EPERM" && err.code !== "EACCES")) throw err;
        // Windows without the right to make links: a link to a file is copied.
        const to = path.resolve(path.dirname(l.target), l.link);
        if (!fs.existsSync(to) || !fs.statSync(to).isFile()) throw refuse(`has a link this computer can't make: ${l.name}`);
        fs.copyFileSync(to, l.target);
        counts.files++;
        continue;
      }
      counts.links++;
    }
    for (const l of links) {
      if (!fs.lstatSync(l.target).isSymbolicLink()) continue;
      let real;
      try { real = fs.realpathSync(l.target); } catch { continue; } // dangling: harmless
      if (!isInside(root, real)) throw refuse(`has links that lead outside its folder: ${l.name}`);
    }
    return counts;
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true });
    if (err?.code === "BAD_ARCHIVE") throw err;
    if (err?.code === "Z_DATA_ERROR" || err?.code === "Z_BUF_ERROR" || err?.errno === -3) throw refuse(`could not be read (${err.message})`);
    throw err;
  }
}

function fileExists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

/** rwx for the owner, rx for others where the archive had x; never setuid/setgid/sticky or group/other write. */
function safeMode(mode) {
  const m = (mode || 0o644) & 0o777;
  return (m & 0o755) | 0o600;
}

/**
 * Read the archive entry by entry. onEntry(entry, readBody) must call readBody(sink) exactly once: sink(chunk) gets
 * the entry's data (null skips it).
 */
async function readEntries(file, onEntry) {
  const gunzip = zlib.createGunzip();
  const src = fs.createReadStream(file);
  src.on("error", (err) => gunzip.destroy(err));
  src.pipe(gunzip);

  let buf = Buffer.alloc(0);
  const iter = gunzip[Symbol.asyncIterator]();
  let done = false;
  const fill = async (n) => {
    while (buf.length < n && !done) {
      const r = await iter.next();
      if (r.done) { done = true; break; }
      buf = buf.length ? Buffer.concat([buf, r.value]) : r.value;
    }
    return buf.length >= n;
  };
  const take = (n) => { const out = buf.subarray(0, n); buf = buf.subarray(n); return out; };

  let pax = {};
  let longName = null;
  let longLink = null;
  let zeroBlocks = 0;
  let sawEntry = false;
  try {
    while (true) {
      if (!(await fill(BLOCK))) {
        if (!sawEntry) throw refuse("is empty or not a tar archive");
        break; // some writers stop without the two zero blocks
      }
      const h = Buffer.from(take(BLOCK));
      if (h.every((b) => b === 0)) {
        if (++zeroBlocks >= 2) break;
        continue;
      }
      zeroBlocks = 0;
      if (!checksumOk(h)) throw refuse("is damaged (a header's checksum is wrong)");
      sawEntry = true;
      const flag = String.fromCharCode(h[156] || 0x30);
      const size = octal(h, 124, 12);
      const padded = Math.ceil(size / BLOCK) * BLOCK;

      const readAll = async () => {
        if (!(await fill(padded))) throw refuse("ends in the middle of a file");
        return Buffer.from(take(padded).subarray(0, size));
      };
      if (flag === "x" || flag === "g") {
        const data = await readAll();
        if (flag === "x") pax = parsePax(data);
        continue;
      }
      if (flag === "L" || flag === "K") {
        const v = (await readAll()).toString("utf8").replace(/\0+$/, "");
        if (flag === "L") longName = v; else longLink = v;
        continue;
      }

      const prefix = cstr(h, 345, 155);
      const base = cstr(h, 0, 100);
      const name = pax.path || longName || (prefix ? `${prefix}/${base}` : base);
      const linkname = pax.linkpath || longLink || cstr(h, 157, 100);
      pax = {};
      longName = null;
      longLink = null;
      const type = flag === "0" || flag === "\0" || flag === "7" ? "file"
        : flag === "5" ? "dir"
        : flag === "2" ? "symlink"
        : flag === "1" ? "hardlink"
        : `type ${flag}`;
      const entry = { name: type === "dir" ? name.replace(/\/+$/, "") : name, type, size, mode: octal(h, 100, 8), linkname };

      let consumed = false;
      await onEntry(entry, async (sink) => {
        consumed = true;
        let left = size;
        while (left > 0) {
          if (!(await fill(1))) throw refuse("ends in the middle of a file");
          const piece = take(Math.min(left, buf.length));
          left -= piece.length;
          if (sink) sink(piece);
        }
        const rest = padded - size;
        if (rest > 0) {
          if (!(await fill(rest))) throw refuse("ends in the middle of a file");
          take(rest);
        }
      });
      if (!consumed) throw new Error("readEntries: the entry's body was not read");
    }
  } finally {
    src.unpipe(gunzip);
    src.destroy();
    gunzip.destroy();
  }
}
