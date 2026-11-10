/**
 * Tarsee Terminal UI
 * Web-based terminal for running commands on the Tarsee server.
 */

(function () {
  // Initialize xterm.js
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: '"Cascadia Code", "Fira Code", "Courier New", monospace',
    fontSize: 14,
    theme: {
      background: "#000000",
      foreground: "#ffffff",
      cursor: "#f5a623",
      cursorAccent: "#000000",
      selection: "rgba(245, 166, 35, 0.3)",
      black: "#000000",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#d19a66",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#5c6370",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#d19a66",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  });

  // Add-ons
  const fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();

  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);

  // Mount terminal
  term.open(document.getElementById("terminal"));
  fitAddon.fit();
  // Auto-focus so user can type immediately
  term.focus();

  // Handle window resize
  window.addEventListener("resize", () => {
    fitAddon.fit();
    sendResize();
  });

  // Status indicators
  const statusIndicator = document.getElementById("status-indicator");
  const statusText = document.getElementById("status-text");

  function setStatus(status, text) {
    statusIndicator.className = `status-indicator ${status}`;
    statusText.textContent = text;
  }

  // WebSocket connection
  // The browser sends the sign-in's cookie (httpOnly) with the upgrade, and that is what opens the Terminal. The API
  // token opens nothing (websocket/terminal-handler.js terminalRefusal), so it isn't put in the address either.
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/terminal`;
  // The server's close for "no live sign-in" (websocket/terminal-handler.js SIGN_IN_REQUIRED): final. Trying again
  // can't help until the owner signs in again, so the page stops and offers "Sign in again" (signInAgain).
  const SIGN_IN_REQUIRED = 4401;
  const RETRY_MS = 5000;
  let ws = null;
  let retryTimer = null;
  let stopped = false;
  let lastData = "";
  let refusal = "";

  function connect() {
    retryTimer = null;
    if (stopped) return;
    setStatus("connecting", "Connecting...");

    const socket = new WebSocket(wsUrl);
    ws = socket;
    let opened = false;
    socket.addEventListener("open", () => {
      opened = true;
      setStatus("connected", "Connected");

      // Send initial resize
      setTimeout(sendResize, 100);
    });

    socket.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (error) {
        console.error("[terminal] Failed to parse message:", error);
      }
    });

    socket.addEventListener("close", (event) => {
      if (socket !== ws || stopped) return;
      if (event.code === SIGN_IN_REQUIRED) {
        signInAgain();
        return;
      }
      setStatus("disconnected", "Disconnected");
      if (!opened) {
        // Turned away before it opened: at the upgrade, with no live sign-in, or the server is down. Ask which.
        checkSignIn();
        return;
      }
      term.writeln("\r\n\x1b[31m[Disconnected from server]\x1b[0m");
      retryLater();
    });

    socket.addEventListener("error", (error) => {
      console.error("[terminal] WebSocket error:", error);
      if (!stopped) setStatus("disconnected", "Error");
    });
  }

  /** One more try in 5 seconds (one at a time). */
  function retryLater() {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      term.writeln("\x1b[33m[Attempting to reconnect...]\x1b[0m");
      connect();
    }, RETRY_MS);
  }

  /** After a connection that never opened: with no live sign-in, stop and say so; else (the server is down) try again. */
  async function checkSignIn() {
    let signedIn = null;
    try {
      const res = await fetch("/api/auth/status", { credentials: "same-origin", cache: "no-store" });
      if (res.ok) {
        const status = await res.json();
        signedIn = !!(status.authenticated && status.method === "session");
      }
    } catch { /* the server is down: try again */ }
    if (signedIn === false) signInAgain();
    else retryLater();
  }

  /** The owner's sign-in has ended, or there is none: stop trying, and offer "Sign in again" with a Reload button. */
  function signInAgain() {
    stopped = true;
    clearTimeout(retryTimer);
    retryTimer = null;
    setStatus("disconnected", "Signed out");
    const why = refusal || "The Terminal needs you signed in to the dashboard. Sign in there, then reload this page.";
    if (!lastData.includes(why)) term.writeln(`\r\n\x1b[33m[${why}]\x1b[0m`);
    showSignInAgain(why);
  }

  function showSignInAgain(why) {
    if (document.getElementById("sign-in-again")) return;
    const style = document.createElement("style");
    style.textContent = `
      #sign-in-again { position: fixed; top: 76px; left: 16px; right: 16px; max-width: 440px; margin: 0 auto; z-index: 200;
        box-sizing: border-box; padding: 16px; border-radius: 8px; background: #2a2a2a; color: #fff;
        border: 1px solid #f5a623; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5); }
      #sign-in-again h2 { margin: 0 0 6px; font-size: 16px; color: #f5a623; }
      #sign-in-again p { margin: 0 0 12px; overflow-wrap: anywhere; }
      #sign-in-again .actions { display: flex; flex-wrap: wrap; gap: 8px; }
      #sign-in-again button, #sign-in-again a { font: inherit; font-weight: 600; border-radius: 6px; padding: 8px 14px;
        cursor: pointer; text-decoration: none; border: 1px solid #f5a623; }
      #sign-in-again button { background: #f5a623; color: #000; }
      #sign-in-again a { background: transparent; color: #f5a623; }
      #sign-in-again button:focus-visible, #sign-in-again a:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }`;
    document.head.appendChild(style);

    const box = document.createElement("div");
    box.id = "sign-in-again";
    box.setAttribute("role", "alert");
    const title = document.createElement("h2");
    title.textContent = "Sign in again";
    const text = document.createElement("p");
    text.textContent = why;
    const actions = document.createElement("div");
    actions.className = "actions";
    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "Reload";
    reload.addEventListener("click", () => window.location.reload());
    const dashboard = document.createElement("a");
    dashboard.href = "/";
    dashboard.target = "_blank";
    dashboard.rel = "noopener";
    dashboard.textContent = "Open the dashboard";
    actions.append(reload, dashboard);
    box.append(title, text, actions);
    document.body.appendChild(box);
    reload.focus();
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "connected":
        term.writeln(`\x1b[32mTerminal connected: ${msg.terminalId}\x1b[0m`);
        term.writeln(`\x1b[36mShell: ${msg.shell}\x1b[0m`);
        term.writeln(`\x1b[36mWorking directory: ${msg.cwd}\x1b[0m`);
        term.writeln("");
        break;

      case "data":
        lastData = String(msg.data);
        term.write(msg.data);
        break;

      case "error":
        // Why the server is closing. A refusal comes as a "data" line too; anything else is written here.
        refusal = String(msg.message || "");
        if (refusal && !lastData.includes(refusal)) term.writeln(`\r\n\x1b[31m[${refusal}]\x1b[0m`);
        break;

      case "exit":
        term.writeln(`\r\n\x1b[33m[Process exited with code ${msg.exitCode}]\x1b[0m`);
        setStatus("disconnected", "Process exited");
        break;

      case "pong":
        // Keepalive response
        break;

      default:
        console.warn("[terminal] Unknown message type:", msg.type);
    }
  }

  // Handle terminal input
  term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }));
    }
  });

  function sendResize() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "resize",
          cols: term.cols,
          rows: term.rows,
        })
      );
    }
  }

  // Keepalive ping every 30 seconds
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 30000);

  // Initial connection
  connect();

  // Ctrl+C handling (prevent default browser behavior)
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "c" && document.activeElement.closest("#terminal")) {
      e.preventDefault();
    }
  });
})();
