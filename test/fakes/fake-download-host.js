// A fake of the download hosts (Hugging Face, GitHub and their CDNs) for the installers' tests: a fetch that serves
// fixed answers and never touches the network. A file can come in slow chunks (so progress moves), stop halfway (a
// dropped connection), redirect (as the real hosts do, to their CDNs), or answer an HTTP error.
//
//   const host = fakeDownloadHost({
//     "https://huggingface.co/x/resolve/rev/model.bin": { redirect: "https://us.aws.cdn.hf.co/xet/abc" },
//     "https://us.aws.cdn.hf.co/xet/abc": { body: buf, chunk: 1024, delayMs: 2 },
//     "https://api.github.com/...": { json: {...} },
//     "https://github.com/...": (url, hit) => (hit === 1 ? { body: buf, failAt: 100 } : { body: buf }),
//   });
//   host.fetch, host.hits[url], host.requests
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fakeDownloadHost(routes = {}) {
  const hits = {};
  const requests = [];
  const fetch = async (url, init = {}) => {
    url = String(url);
    requests.push({ url, redirect: init.redirect, headers: init.headers || {} });
    hits[url] = (hits[url] || 0) + 1;
    let r = routes[url];
    if (typeof r === "function") r = await r(url, hits[url], init);
    if (r === undefined) return new Response("Not Found", { status: 404 });
    if (r instanceof Error) throw r;
    if (r.redirect) {
      return new Response(null, { status: r.status || 302, headers: { location: r.redirect } });
    }
    if (r.status && r.status !== 200) {
      return new Response(r.text ?? "", { status: r.status, headers: r.headers || {} });
    }
    if (r.json !== undefined) {
      return new Response(JSON.stringify(r.json), { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body ?? "");
    const chunk = r.chunk || 64 * 1024;
    const delayMs = r.delayMs || 0;
    const failAt = r.failAt;
    let sent = 0;
    const stream = new ReadableStream({
      async pull(ctrl) {
        if (delayMs) await sleep(delayMs);
        if (failAt !== undefined && sent >= failAt) {
          // What undici does when the other side closes mid-body.
          ctrl.error(Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }));
          return;
        }
        if (sent >= body.length) {
          ctrl.close();
          return;
        }
        const end = Math.min(body.length, sent + chunk, failAt ?? Infinity);
        ctrl.enqueue(new Uint8Array(body.subarray(sent, end)));
        sent = end;
      },
    });
    const headers = { "content-length": String(r.contentLength ?? body.length), ...(r.headers || {}) };
    return new Response(stream, { status: 200, headers });
  };
  return { fetch, hits, requests };
}
