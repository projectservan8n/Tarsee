/**
 * test-tls.js: a throwaway TLS authority and a server certificate for loopback fakes, made in memory with node:crypto
 * (no openssl, no key or certificate in the repo).
 *
 * Codex reaches ChatGPT's backend only over HTTPS: its workspace routing refuses a plain-http origin. So a fake of that
 * backend serves HTTPS with a certificate from this authority, and Codex is told to trust it through SSL_CERT_FILE.
 *
 *   const t = makeTestTls();                    // hosts: ["127.0.0.1", "localhost"] by default
 *   https.createServer({ key: t.keyPem, cert: t.certPem }, ...)
 *   fs.writeFileSync(file, t.bundlePem);        // SSL_CERT_FILE: the authority plus the public roots
 *
 * The private keys stay in memory (keyPem goes to the server only). bundlePem carries the public roots Node ships
 * (tls.rootCertificates) after the authority, so a program given it as SSL_CERT_FILE still reaches real hosts; caPem
 * alone trusts the authority only.
 */
import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";

// --- DER, just what a certificate needs -----------------------------------------------------------------------------

function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const explicit = (n, ...parts) => tlv(0xa0 + n, ...parts);
const octets = (buf) => tlv(0x04, buf);
const bitString = (buf, unused = 0) => tlv(0x03, Buffer.from([unused]), buf);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const utf8 = (s) => tlv(0x0c, Buffer.from(s, "utf8"));

/** A positive INTEGER from big-endian bytes. */
function integer(bytes) {
  let b = Buffer.from(bytes);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oid(dotted) {
  const parts = dotted.split(".").map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const n of parts.slice(2)) {
    const b = [];
    let v = n;
    do { b.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
    for (let i = 0; i < b.length - 1; i += 1) b[i] |= 0x80;
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime through 2049, GeneralizedTime after (RFC 5280 4.1.2.5). */
function time(d) {
  const p = (n) => String(n).padStart(2, "0");
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const y = d.getUTCFullYear();
  return y < 2050 ? tlv(0x17, Buffer.from(`${String(y).slice(2)}${rest}`)) : tlv(0x18, Buffer.from(`${y}${rest}`));
}

const commonName = (cn) => seq(set(seq(oid("2.5.4.3"), utf8(cn))));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const extension = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

function ipBytes(ip) {
  if (net.isIPv4(ip)) return Buffer.from(ip.split(".").map(Number));
  // IPv6: expand "::" and write the eight groups.
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return Buffer.from(groups.flatMap((g) => { const v = parseInt(g || "0", 16); return [v >> 8, v & 0xff]; }));
}

/** subjectAltName: [2] dNSName for a name, [7] iPAddress for an address. */
const altNames = (hosts) => seq(...hosts.map((h) => (net.isIP(h) ? tlv(0x87, ipBytes(h)) : tlv(0x82, Buffer.from(h, "ascii")))));

function pem(label, der) {
  const b64 = der.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/** One signed X.509 v3 certificate (ECDSA P-256 with SHA-256). */
function certificate({ subject, issuer, publicKey, signingKey, notBefore, notAfter, extensions }) {
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;   // positive, at most 20 bytes (RFC 5280 4.1.2.2)
  const tbs = seq(
    explicit(0, integer([2])),   // v3
    integer(serial),
    ECDSA_SHA256,
    commonName(issuer),
    seq(time(notBefore), time(notAfter)),
    commonName(subject),
    publicKey.export({ type: "spki", format: "der" }),
    explicit(3, seq(...extensions)),
  );
  const signature = crypto.sign("sha256", tbs, signingKey);   // DER-encoded ECDSA signature
  return pem("CERTIFICATE", seq(tbs, ECDSA_SHA256, bitString(signature)));
}

/**
 * A new authority and a server certificate for `hosts`, valid from an hour ago for `days` days.
 * Returns { caPem, certPem, keyPem, bundlePem, hosts }.
 */
export function makeTestTls({ hosts = ["127.0.0.1", "localhost"], days = 2 } = {}) {
  const notBefore = new Date(Date.now() - 3_600_000);
  const notAfter = new Date(Date.now() + days * 86_400_000);
  const tag = crypto.randomBytes(4).toString("hex");
  const caName = `Tarsee test authority ${tag}`;
  const ca = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const leaf = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const caPem = certificate({
    subject: caName, issuer: caName, publicKey: ca.publicKey, signingKey: ca.privateKey, notBefore, notAfter,
    extensions: [
      extension("2.5.29.19", true, seq(bool(true))),                       // basicConstraints: CA
      extension("2.5.29.15", true, bitString(Buffer.from([0x06]), 1)),      // keyUsage: keyCertSign, cRLSign
    ],
  });
  const certPem = certificate({
    subject: `Tarsee test server ${tag}`, issuer: caName, publicKey: leaf.publicKey, signingKey: ca.privateKey, notBefore, notAfter,
    extensions: [
      extension("2.5.29.19", true, seq()),                                  // basicConstraints: not a CA
      extension("2.5.29.15", true, bitString(Buffer.from([0x80]), 7)),      // keyUsage: digitalSignature
      extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))),         // extKeyUsage: serverAuth
      extension("2.5.29.17", false, altNames(hosts)),                       // subjectAltName
    ],
  });
  const keyPem = leaf.privateKey.export({ type: "pkcs8", format: "pem" });
  const bundlePem = [caPem, ...tls.rootCertificates.map((c) => `${c.trim()}\n`)].join("");
  return { caPem, certPem, keyPem, bundlePem, hosts: [...hosts] };
}
