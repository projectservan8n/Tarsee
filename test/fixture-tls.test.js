// The throwaway TLS authority the ChatGPT fakes use (test/fixtures/test-tls.js). Codex talks to ChatGPT's backend only
// over HTTPS (it refuses a plain-http workspace origin), so a loopback fake of that backend needs a certificate Codex
// trusts through SSL_CERT_FILE. Everything is made in memory for each run; only the authority's public certificate
// (with the public roots, so real hosts keep working) is ever written to a file.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import https from "node:https";
import tls from "node:tls";
import { makeTestTls } from "./fixtures/test-tls.js";

describe("a throwaway TLS authority for loopback fakes", () => {
  const t = makeTestTls();

  it("issues a server certificate for 127.0.0.1 and localhost, signed by its own authority", () => {
    const ca = new crypto.X509Certificate(t.caPem);
    const leaf = new crypto.X509Certificate(t.certPem);
    assert.equal(ca.ca, true, "the authority is a CA");
    assert.equal(leaf.ca, false, "the server certificate is not");
    assert.ok(leaf.checkIssued(ca), "issued by the authority");
    assert.ok(leaf.verify(ca.publicKey), "and signed by it");
    assert.equal(leaf.checkIP("127.0.0.1"), "127.0.0.1");
    assert.equal(leaf.checkHost("localhost"), "localhost");
    assert.equal(leaf.checkHost("example.com"), undefined);
    assert.ok(Date.parse(leaf.validFrom) <= Date.now() && Date.parse(leaf.validTo) > Date.now(), "valid now");
    assert.notEqual(makeTestTls().caPem, t.caPem, "a new authority each time");
  });

  it("a client that trusts the authority connects; one that doesn't is refused", async () => {
    const server = https.createServer({ key: t.keyPem, cert: t.certPem }, (req, res) => res.end("ok"));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `https://127.0.0.1:${server.address().port}/`;
    const get = (opts) => new Promise((resolve, reject) => {
      https.get(url, { agent: false, ...opts }, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve(body));
      }).on("error", reject);
    });
    try {
      assert.equal(await get({ ca: t.caPem }), "ok");
      await assert.rejects(get({}), (err) => /certificate|self[- ]signed|verify/i.test(`${err.code} ${err.message}`));
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it("the bundle for SSL_CERT_FILE holds the authority and the public roots, and no private key", () => {
    assert.ok(t.bundlePem.includes(t.caPem.trim()), "the authority");
    const count = t.bundlePem.split("-----BEGIN CERTIFICATE-----").length - 1;
    assert.equal(count, tls.rootCertificates.length + 1, "and every public root");
    assert.doesNotMatch(t.bundlePem, /PRIVATE KEY/);
    assert.doesNotMatch(t.caPem + t.certPem, /PRIVATE KEY/);
    assert.match(t.keyPem, /^-----BEGIN PRIVATE KEY-----/);
  });
});
