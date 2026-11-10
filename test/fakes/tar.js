// A tiny tar writer for tests: builds the .tar.gz archives the fake download host serves (a stand-in for
// python-build-standalone's install_only archives), including the awkward cases a real one could have: a pax header
// for a long name, symlinks, and the malicious entries an extractor must refuse.
//   makeTarGz([{ name: "python/bin/python3", body: "...", mode: 0o755 }, { name: "python/bin/python", type: "symlink", linkname: "python3" }])
import zlib from "node:zlib";

function header({ name, size = 0, mode = 0o644, type = "0", linkname = "" }) {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, "utf8");
  h.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  h.write("0000000\0", 108, 8, "ascii");
  h.write("0000000\0", 116, 8, "ascii");
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii");
  h.write(type, 156, 1, "ascii");
  h.write(linkname, 157, 100, "utf8");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return h;
}

const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512, 0);

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return `${len}${body}`;
}

/** entries: { name, type?: "file"|"dir"|"symlink"|"hardlink", body?, mode?, linkname?, pax?: true, badChecksum?: true } */
export function makeTar(entries) {
  const parts = [];
  for (const e of entries) {
    const type = e.type || "file";
    const body = type === "file" ? (Buffer.isBuffer(e.body) ? e.body : Buffer.from(e.body ?? "")) : Buffer.alloc(0);
    let name = e.name;
    if (e.pax || Buffer.byteLength(name) > 99) {
      const rec = Buffer.from(paxRecord("path", name));
      parts.push(header({ name: "PaxHeader/x", size: rec.length, type: "x" }), rec, pad(rec.length));
      name = name.slice(-99);
    }
    const flag = { file: "0", dir: "5", symlink: "2", hardlink: "1" }[type];
    const h = header({ name, size: body.length, mode: e.mode ?? (type === "dir" ? 0o755 : 0o644), type: flag, linkname: e.linkname || "" });
    if (e.badChecksum) h[148] = "9".charCodeAt(0);
    parts.push(h, body, pad(body.length));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

export function makeTarGz(entries) {
  return zlib.gzipSync(makeTar(entries));
}
