/**
 * Sends a Server-Sent Event to the response.
 * @param {import('express').Response} res
 * @param {string} event - Event name
 * @param {*} data - Data to JSON-serialize
 */
export function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Sets up SSE headers on a response.
 * @param {import('express').Response} res
 */
export function initSSE(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",  // Disable nginx buffering
  });
  res.flushHeaders();
}

/**
 * Generates a short random ID.
 * @param {number} [length=12]
 * @returns {string}
 */
export function randomId(length = 12) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) {
    id += chars[bytes[i] % chars.length];
  }
  return id;
}
