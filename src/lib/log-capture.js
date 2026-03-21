/**
 * Log capture — intercepts console.log/warn/error and stores in a ring buffer.
 * Broadcasts new entries to subscribed WebSocket clients in real-time.
 */

const MAX_BUFFER = 500; // Keep last 500 log entries in memory

class LogCapture {
  constructor() {
    this.buffer = [];
    this.subscribers = new Set();
    this._installed = false;
  }

  /**
   * Install console interceptors.
   * Call once at startup.
   */
  install() {
    if (this._installed) return;
    this._installed = true;

    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);

    console.log = (...args) => {
      origLog(...args);
      this._capture("log", args);
    };

    console.warn = (...args) => {
      origWarn(...args);
      this._capture("warn", args);
    };

    console.error = (...args) => {
      origError(...args);
      this._capture("error", args);
    };
  }

  _capture(level, args) {
    const entry = {
      ts: Date.now(),
      level,
      text: args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
    };

    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.shift();
    }

    // Broadcast to all subscribers
    const msg = JSON.stringify({ type: "console.log", entry });
    for (const ws of this.subscribers) {
      try {
        if (ws.readyState === 1) { // OPEN
          ws.send(msg);
        } else {
          this.subscribers.delete(ws);
        }
      } catch {
        this.subscribers.delete(ws);
      }
    }
  }

  /**
   * Subscribe a WebSocket to real-time log output.
   */
  subscribe(ws) {
    this.subscribers.add(ws);
    ws.on("close", () => this.subscribers.delete(ws));
  }

  /**
   * Unsubscribe a WebSocket.
   */
  unsubscribe(ws) {
    this.subscribers.delete(ws);
  }

  /**
   * Get recent log entries.
   * @param {number} count - Number of entries to return (default: all)
   */
  recent(count) {
    if (!count) return [...this.buffer];
    return this.buffer.slice(-count);
  }

  /**
   * Get subscriber count.
   */
  get subscriberCount() {
    return this.subscribers.size;
  }
}

// Singleton
export const logCapture = new LogCapture();
