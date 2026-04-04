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
  // Session cookie (httpOnly) is sent automatically by browser on WS upgrade.
  // API token via query param serves as fallback auth.
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const apiToken = localStorage.getItem("tarsee_api_token");
  const wsUrl = `${protocol}//${window.location.host}/terminal${apiToken ? "?token=" + encodeURIComponent(apiToken) : ""}`;
  let ws = null;
  let reconnectInterval = null;

  function connect() {
    setStatus("connecting", "Connecting...");

    ws = new WebSocket(wsUrl);

    ws._wasOpen = false;
    ws.addEventListener("open", () => {
      ws._wasOpen = true;
      setStatus("connected", "Connected");
      clearInterval(reconnectInterval);
      reconnectInterval = null;

      // Send initial resize
      setTimeout(sendResize, 100);
    });

    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (error) {
        console.error("[terminal] Failed to parse message:", error);
      }
    });

    ws.addEventListener("close", (event) => {
      setStatus("disconnected", "Disconnected");

      // Detect auth failure (server sends 401 before upgrade completes → code 1006)
      if (event.code === 1006 && !ws._wasOpen) {
        term.writeln("\r\n\x1b[31m[Connection rejected — not authenticated]\x1b[0m");
        term.writeln("\x1b[33mPlease log in to Tarsee first, then reload this page.\x1b[0m");
        return; // Don't reconnect — auth won't magically fix itself
      }

      term.writeln("\r\n\x1b[31m[Disconnected from server]\x1b[0m");

      // Attempt to reconnect every 5 seconds
      if (!reconnectInterval) {
        reconnectInterval = setInterval(() => {
          term.writeln("\x1b[33m[Attempting to reconnect...]\x1b[0m");
          connect();
        }, 5000);
      }
    });

    ws.addEventListener("error", (error) => {
      console.error("[terminal] WebSocket error:", error);
      setStatus("disconnected", "Error");
    });
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
        term.write(msg.data);
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
