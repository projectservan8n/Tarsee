import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { readWorkspaceFile, writeWorkspaceFile, appendDailyLog } from "./workspace-files.js";
import { runCmd } from "./run-cmd.js";

/**
 * Tool registry for Tarsee.
 * Defines tools that the AI can call via native tool_use (Anthropic) or function calling (OpenAI).
 * Each tool has a name, description, input_schema (JSON Schema), and execute function.
 */

const WORKSPACE_FILES = ["SOUL.md", "IDENTITY.md", "AGENTS.md", "USER.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md", "BOOT.md"];

export const TOOLS = [
  {
    name: "read_file",
    description: "Read the contents of a workspace file (SOUL.md, IDENTITY.md, AGENTS.md, USER.md, TOOLS.md, MEMORY.md, HEARTBEAT.md, BOOT.md) or a daily memory log (memory/YYYY-MM-DD.md).",
    input_schema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "The filename to read, e.g. 'MEMORY.md' or 'memory/2026-03-24.md'",
        },
        offset: {
          type: "number",
          description: "Line number to start reading from (1-indexed). Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to return. Optional, defaults to all lines.",
        },
      },
      required: ["filename"],
    },
  },

  {
    name: "write_file",
    description: "Write or overwrite the contents of a workspace file. Use this to update your personality (SOUL.md), identity (IDENTITY.md), user notes (USER.md), long-term memory (MEMORY.md), tools (TOOLS.md), or agent rules (AGENTS.md).",
    input_schema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "The workspace filename to write, e.g. 'MEMORY.md'",
        },
        content: {
          type: "string",
          description: "The full content to write to the file",
        },
      },
      required: ["filename", "content"],
    },
  },

  {
    name: "list_files",
    description: "List all workspace files and their sizes. Also lists daily memory logs.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },

  {
    name: "remember",
    description: "Save an important fact or preference to long-term memory. This appends to the MEMORY.md file and saves to the database.",
    input_schema: {
      type: "object",
      properties: {
        fact: {
          type: "string",
          description: "The fact, preference, or important information to remember",
        },
        category: {
          type: "string",
          description: "Category: preference, fact, project, person, decision",
          enum: ["preference", "fact", "project", "person", "decision"],
        },
      },
      required: ["fact"],
    },
  },

  {
    name: "daily_log",
    description: "Append a timestamped note to today's daily memory log (memory/YYYY-MM-DD.md).",
    input_schema: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description: "The note to log",
        },
      },
      required: ["note"],
    },
  },

  {
    name: "exec",
    description: "Execute a shell command on the server. Use for system tasks, checking status, running scripts, or using installed tools like Playwright. Commands run in a sandboxed environment with a 60-second timeout. Output is capped at 50KB.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute, e.g. 'ls -la' or 'node -e \"console.log(1+1)\"'",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds (default: 60000, max: 120000)",
        },
      },
      required: ["command"],
    },
  },

  {
    name: "web_fetch",
    description: "Fetch the contents of a URL. Returns the response body as text (HTML, JSON, etc). Useful for checking APIs, fetching web pages, or downloading data.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
        method: {
          type: "string",
          description: "HTTP method (default: GET)",
          enum: ["GET", "POST", "PUT", "DELETE"],
        },
        headers: {
          type: "object",
          description: "Optional HTTP headers as key-value pairs",
        },
        body: {
          type: "string",
          description: "Optional request body (for POST/PUT)",
        },
      },
      required: ["url"],
    },
  },

  {
    name: "search_memories",
    description: "Search through stored memories in the database for relevant facts about the user or past conversations.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search term to find in memories",
        },
      },
      required: ["query"],
    },
  },

  {
    name: "search_memories_deep",
    description: "Deep semantic search — dumps ALL stored memories, MEMORY.md, and recent daily logs so you can reason about relevance. Use this when search_memories returns nothing or when the user asks about something vague that keyword search can't match. Costs more tokens but finds things word search misses.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What you're looking for — describe it naturally, e.g. 'that API integration we discussed' or 'user's timezone preference'",
        },
      },
      required: ["query"],
    },
  },

  {
    name: "edit_file",
    description: "Edit a workspace file by replacing specific text (targeted find-and-replace). Only replaces the first occurrence.",
    input_schema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "The workspace filename to edit, e.g. 'MEMORY.md'",
        },
        old_text: {
          type: "string",
          description: "The exact text to find in the file",
        },
        new_text: {
          type: "string",
          description: "The replacement text",
        },
      },
      required: ["filename", "old_text", "new_text"],
    },
  },

  {
    name: "grep",
    description: "Search for a text pattern across workspace files. Returns matching lines with filename:lineNumber format. Case-insensitive. Results capped at 50 matches.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The text pattern to search for (case-insensitive substring match)",
        },
        filename: {
          type: "string",
          description: "Optional: search only this specific workspace file. If omitted, searches all workspace files and memory logs.",
        },
      },
      required: ["pattern"],
    },
  },

  {
    name: "append_file",
    description: "Append content to a workspace file without overwriting existing content. Useful for adding entries to MEMORY.md, TOOLS.md, etc.",
    input_schema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "The workspace filename to append to, e.g. 'MEMORY.md'",
        },
        content: {
          type: "string",
          description: "The content to append to the end of the file",
        },
      },
      required: ["filename", "content"],
    },
  },

  {
    name: "browser",
    description: "Control a stealth web browser (anti-detection enabled). Actions: navigate (go to URL), screenshot (capture page), click (click element), type (type text), evaluate (run JS), get_text (extract text), wait_for (wait for selector/navigation), scroll (scroll page), select (dropdown), solve_captcha (auto-detect and solve reCAPTCHA/hCaptcha/Turnstile via 2Captcha or Capsolver). Browser persists across calls.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["navigate", "screenshot", "click", "type", "evaluate", "get_text", "wait_for", "scroll", "select", "solve_captcha", "close"],
          description: "The browser action to perform",
        },
        url: {
          type: "string",
          description: "URL to navigate to (for 'navigate' action)",
        },
        selector: {
          type: "string",
          description: "CSS selector for the target element (for 'click' and 'type' actions)",
        },
        text: {
          type: "string",
          description: "Text to type into the element (for 'type' action)",
        },
        script: {
          type: "string",
          description: "JavaScript code to evaluate in the page (for 'evaluate' action)",
        },
        value: {
          type: "string",
          description: "Value to select in dropdown (for 'select' action)",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (for 'wait_for', default 30000)",
        },
        direction: {
          type: "string",
          enum: ["down", "up", "bottom", "top"],
          description: "Scroll direction (for 'scroll' action, default 'down')",
        },
      },
      required: ["action"],
    },
  },

  {
    name: "calculator",
    description: "Evaluate a math expression with precision. Use this for ANY math: arithmetic, percentages, unit conversions, financial calculations, etc. Never do math in your head — always use this tool. Supports: +, -, *, /, **, %, Math.sqrt(), Math.round(), Math.ceil(), Math.floor(), Math.abs(), Math.log(), Math.PI, Math.E, parentheses.",
    input_schema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Math expression to evaluate, e.g. '(149 * 12) * 0.85' or 'Math.sqrt(144) + 5'",
        },
      },
      required: ["expression"],
    },
  },

  {
    name: "datetime",
    description: `Get the current date, time, day of week, or convert between timezones. ALWAYS use this tool when mentioning dates, days of the week, or times — never guess from LLM inference. Use for: 'what day is April 17?', 'what time is it in Tokyo?', 'how many days until Friday?'. The agent's local zone is ${config.TIMEZONE}.`,
    input_schema: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description: `IANA timezone, e.g. 'Europe/Berlin', 'America/New_York', 'UTC'. Default: ${config.TIMEZONE}`,
        },
        date: {
          type: "string",
          description: "Optional date to check, e.g. '2026-04-17' or 'next friday'. If omitted, returns current date/time.",
        },
        format: {
          type: "string",
          enum: ["full", "date", "time", "day", "iso"],
          description: "Output format. 'full' = everything, 'day' = just the day of week, 'iso' = ISO 8601",
        },
      },
      required: [],
    },
  },

  {
    name: "web_search",
    description: "Search the web using DuckDuckGo. Returns titles, URLs, and snippets for the top results. Free, no API key needed.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (default: 5, max: 10)",
        },
      },
      required: ["query"],
    },
  },

  {
    name: "pdf_read",
    description: "Read and extract text from a PDF file. Can read from a URL or from a workspace file path.",
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "URL of the PDF or workspace filename to read",
        },
      },
      required: ["source"],
    },
  },

  {
    name: "send_message",
    description: "Send a message to a specific channel. Use this to proactively message the user on Telegram, Discord, WhatsApp, Slack or email, or to send data/files to the chat.",
    input_schema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "The channel to send to. `email` requires channel_id (the target address).",
          enum: ["web", "discord", "telegram", "whatsapp", "slack", "email"],
        },
        message: {
          type: "string",
          description: "The message content to send",
        },
        channel_id: {
          type: "string",
          description: "Optional specific chat/channel ID to target",
        },
      },
      required: ["channel", "message"],
    },
  },

  {
    name: "schedule_task",
    description: "Schedule a task to run at a specific time or interval using cron syntax. The task will be executed as an AI prompt at the scheduled time.",
    input_schema: {
      type: "object",
      properties: {
        schedule: {
          type: "string",
          description: "Cron expression, e.g. '0 9 * * *' for daily at 9am",
        },
        prompt: {
          type: "string",
          description: "What to do when the task triggers — this will be sent as an AI prompt",
        },
        name: {
          type: "string",
          description: "Optional descriptive name for this scheduled task",
        },
      },
      required: ["schedule", "prompt"],
    },
  },

  {
    name: "get_key",
    description: "Retrieve an API key or secret from the secure vault. Use this when you need a key for a task (e.g., Google Places API key, Stripe key, etc). Keys are stored encrypted and only decrypted when needed.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Key name (e.g., GOOGLE_PLACES_KEY, STRIPE_SECRET)" },
      },
      required: ["name"],
    },
  },

  {
    name: "set_key",
    description: "Store an API key or secret in the secure vault. The user gives you a key and you save it encrypted. Use a descriptive name like GOOGLE_PLACES_KEY, OPENWEATHER_KEY, etc.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Key name (uppercase with underscores, e.g., GOOGLE_PLACES_KEY)" },
        value: { type: "string", description: "The secret value to store" },
        description: { type: "string", description: "What this key is for (e.g., Google Places API for location lookups)" },
      },
      required: ["name", "value"],
    },
  },

  {
    name: "list_keys",
    description: "List all API keys and secrets stored in the vault. Shows names and descriptions only — values are masked for security.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },

  {
    name: "delete_key",
    description: "Delete an API key or secret from the vault.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Key name to delete" },
      },
      required: ["name"],
    },
  },

  {
    name: "create_canvas",
    description: "Create an interactive HTML/CSS/JS canvas that can be viewed in the browser. Use for dashboards, visualizations, mini-apps, or any UI the user needs.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Canvas title/ID (used in URL)" },
        html: { type: "string", description: "HTML content" },
        css: { type: "string", description: "Optional CSS styles" },
        js: { type: "string", description: "Optional JavaScript" },
      },
      required: ["title", "html"],
    },
  },

  {
    name: "create_diagram",
    description: "Render a clickable flowchart/diagram (processes, workflows, architecture, decision trees). Embeds as an interactive iframe in chat — clicking a node posts a follow-up question back to the conversation. Prefer this over ASCII art or lengthy prose for multi-step flows.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Diagram title (also used as URL slug)" },
        nodes: {
          type: "array",
          description: "Diagram nodes. Each node has a unique id.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique node id" },
              label: { type: "string", description: "Main label shown in the node" },
              sublabel: { type: "string", description: "Optional secondary line under the main label" },
              kind: { type: "string", enum: ["trigger", "processing", "decision", "output", "note"], description: "Node type — drives color: trigger=grey (sources/storage), processing=purple (actions), decision=amber (yes/no branches), output=teal (results), note=transparent (annotation, not clickable)" },
              question: { type: "string", description: "Optional custom question to ask when this node is clicked. Defaults to 'Tell me more about: <label>'" },
            },
            required: ["id", "label", "kind"],
          },
        },
        edges: {
          type: "array",
          description: "Directional connections between nodes.",
          items: {
            type: "object",
            properties: {
              from: { type: "string", description: "Source node id" },
              to: { type: "string", description: "Target node id" },
              label: { type: "string", description: "Optional edge label, e.g. 'Yes', 'No', 'fails'" },
            },
            required: ["from", "to"],
          },
        },
        legend: {
          type: "array",
          description: "Optional legend pills shown below the diagram.",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["trigger", "processing", "decision", "output", "note"] },
              label: { type: "string" },
            },
            required: ["kind"],
          },
        },
      },
      required: ["title", "nodes", "edges"],
    },
  },
];

/**
 * Get tool definitions for the AI API (Anthropic format).
 * OpenAI format conversion happens in the provider.
 */
export function getToolDefinitions() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

// ── Browser state (persists across tool calls within a session) ──
let browserInstance = null;
let browserPage = null;

const STEALTH_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function ensureBrowser() {
  if (browserPage && !browserPage.isClosed()) return browserPage;
  try {
    const { chromium } = await import("playwright");
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--no-sandbox",
      ],
    });
    const context = await browserInstance.newContext({
      userAgent: STEALTH_UA,
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      timezoneId: "America/New_York",
      deviceScaleFactor: 1,
      hasTouch: false,
      javaScriptEnabled: true,
    });
    browserPage = await context.newPage();

    // Stealth: remove webdriver flag and patch navigator
    await browserPage.addInitScript(() => {
      // Remove webdriver property
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      // Fake plugins
      Object.defineProperty(navigator, "plugins", {
        get: () => [
          { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer" },
          { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai" },
          { name: "Native Client", filename: "internal-nacl-plugin" },
        ],
      });
      // Fake languages
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      // Fake permissions
      const origQuery = window.Permissions?.prototype?.query;
      if (origQuery) {
        window.Permissions.prototype.query = (params) =>
          params?.name === "notifications"
            ? Promise.resolve({ state: Notification.permission })
            : origQuery(params);
      }
      // Fake chrome runtime
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
    });

    return browserPage;
  } catch (err) {
    throw new Error(`Failed to launch browser: ${err.message}. Make sure playwright is installed (npm i playwright).`);
  }
}

/**
 * Solve a captcha on the current page using 2Captcha/Capsolver API.
 * Supports reCAPTCHA v2/v3, hCaptcha, and Cloudflare Turnstile.
 */
async function solveCaptcha(page, settingsStore) {
  const apiKey = settingsStore?.get("captcha.api_key");
  const service = settingsStore?.get("captcha.service") || "2captcha";
  if (!apiKey) return "Error: No captcha API key configured. Set 'captcha.api_key' and 'captcha.service' (2captcha or capsolver) in Settings > Security.";

  const pageUrl = page.url();

  // Detect captcha type
  const captchaInfo = await page.evaluate(() => {
    // reCAPTCHA v2
    const recaptchaEl = document.querySelector(".g-recaptcha, [data-sitekey]");
    if (recaptchaEl) {
      return { type: "recaptcha_v2", sitekey: recaptchaEl.getAttribute("data-sitekey") };
    }
    // reCAPTCHA v3 (in script src)
    const recaptchaScript = document.querySelector('script[src*="recaptcha"]');
    if (recaptchaScript) {
      const match = recaptchaScript.src.match(/render=([^&]+)/);
      if (match && match[1] !== "explicit") return { type: "recaptcha_v3", sitekey: match[1] };
    }
    // hCaptcha
    const hcaptchaEl = document.querySelector(".h-captcha, [data-hcaptcha-sitekey]");
    if (hcaptchaEl) {
      return { type: "hcaptcha", sitekey: hcaptchaEl.getAttribute("data-sitekey") };
    }
    // Cloudflare Turnstile
    const turnstileEl = document.querySelector(".cf-turnstile, [data-turnstile-sitekey]");
    if (turnstileEl) {
      return { type: "turnstile", sitekey: turnstileEl.getAttribute("data-sitekey") || turnstileEl.getAttribute("data-turnstile-sitekey") };
    }
    return null;
  });

  if (!captchaInfo?.sitekey) return "No captcha detected on this page.";

  try {
    let token;
    if (service === "capsolver") {
      token = await solveWithCapsolver(apiKey, captchaInfo, pageUrl);
    } else {
      token = await solveWith2Captcha(apiKey, captchaInfo, pageUrl);
    }

    // Inject the solved token into the page
    await page.evaluate(({ token, type }) => {
      if (type === "recaptcha_v2" || type === "recaptcha_v3") {
        const textarea = document.querySelector("#g-recaptcha-response, [name='g-recaptcha-response']");
        if (textarea) { textarea.style.display = "block"; textarea.value = token; }
        // Trigger callback if available
        if (typeof window.___grecaptcha_cfg !== "undefined") {
          const clients = window.___grecaptcha_cfg?.clients;
          if (clients) {
            for (const c of Object.values(clients)) {
              const callback = c?.aa?.l?.callback || c?.aa?.callback;
              if (typeof callback === "function") callback(token);
            }
          }
        }
      } else if (type === "hcaptcha") {
        const textarea = document.querySelector("[name='h-captcha-response'], [name='g-recaptcha-response']");
        if (textarea) textarea.value = token;
        if (typeof window.hcaptcha !== "undefined") window.hcaptcha.execute();
      } else if (type === "turnstile") {
        const input = document.querySelector("[name='cf-turnstile-response']");
        if (input) input.value = token;
        if (typeof window.turnstile !== "undefined") {
          const widgets = document.querySelectorAll(".cf-turnstile");
          widgets.forEach(w => {
            const widgetId = w.getAttribute("data-turnstile-widget-id");
            if (widgetId) window.turnstile.getResponse(widgetId);
          });
        }
      }
    }, { token, type: captchaInfo.type });

    return `Solved ${captchaInfo.type} captcha. Token injected into page.`;
  } catch (err) {
    return `Captcha solve failed: ${err.message}`;
  }
}

async function solveWith2Captcha(apiKey, captchaInfo, pageUrl) {
  const base = "https://2captcha.com";
  let method, extraParams = {};

  if (captchaInfo.type === "recaptcha_v2") { method = "userrecaptcha"; }
  else if (captchaInfo.type === "recaptcha_v3") { method = "userrecaptcha"; extraParams.version = "v3"; extraParams.action = "verify"; extraParams.min_score = "0.3"; }
  else if (captchaInfo.type === "hcaptcha") { method = "hcaptcha"; }
  else if (captchaInfo.type === "turnstile") { method = "turnstile"; }

  // Submit task
  const params = new URLSearchParams({
    key: apiKey, method, sitekey: captchaInfo.sitekey, pageurl: pageUrl, json: "1", ...extraParams,
  });
  const submitRes = await fetch(`${base}/in.php?${params}`);
  const submitData = await submitRes.json();
  if (submitData.status !== 1) throw new Error(submitData.request || "Submit failed");
  const taskId = submitData.request;

  // Poll for result (max 120s)
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`${base}/res.php?key=${apiKey}&action=get&id=${taskId}&json=1`);
    const pollData = await pollRes.json();
    if (pollData.status === 1) return pollData.request;
    if (pollData.request !== "CAPCHA_NOT_READY") throw new Error(pollData.request);
  }
  throw new Error("Captcha solve timed out (120s)");
}

async function solveWithCapsolver(apiKey, captchaInfo, pageUrl) {
  const base = "https://api.capsolver.com";
  const typeMap = {
    recaptcha_v2: "ReCaptchaV2TaskProxyLess",
    recaptcha_v3: "ReCaptchaV3TaskProxyLess",
    hcaptcha: "HCaptchaTaskProxyLess",
    turnstile: "AntiTurnstileTaskProxyLess",
  };

  // Create task
  const taskReq = {
    clientKey: apiKey,
    task: {
      type: typeMap[captchaInfo.type],
      websiteURL: pageUrl,
      websiteKey: captchaInfo.sitekey,
    },
  };
  if (captchaInfo.type === "recaptcha_v3") {
    taskReq.task.pageAction = "verify";
    taskReq.task.minScore = 0.3;
  }

  const createRes = await fetch(`${base}/createTask`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(taskReq),
  });
  const createData = await createRes.json();
  if (createData.errorId) throw new Error(createData.errorDescription || "Create task failed");
  const taskId = createData.taskId;

  // Poll for result (max 120s)
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`${base}/getTaskResult`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, taskId }),
    });
    const pollData = await pollRes.json();
    if (pollData.status === "ready") return pollData.solution?.gRecaptchaResponse || pollData.solution?.token;
    if (pollData.status !== "processing") throw new Error(pollData.errorDescription || "Unknown error");
  }
  throw new Error("Captcha solve timed out (120s)");
}

/**
 * Execute a tool call and return the result string.
 * @param {string} toolName
 * @param {object} toolInput
 * @param {object} ctx - Context with db, settingsStore, conversationId
 * @returns {Promise<string>}
 */
export async function executeTool(toolName, toolInput, ctx = {}) {
  const MAX_RESULT = 50_000; // 50KB max result

  try {
    switch (toolName) {
      case "read_file": {
        const { filename, offset, limit } = toolInput;
        // Allow workspace files and memory/ subdirectory
        if (!isAllowedFile(filename)) {
          return `Error: Cannot read '${filename}'. Allowed files: ${WORKSPACE_FILES.join(", ")} and memory/*.md`;
        }
        let content = readWorkspaceFile(filename);
        if (!content) return `File '${filename}' is empty or does not exist.`;
        // Apply offset and limit if provided
        if (offset || limit) {
          const lines = content.split("\n");
          const start = Math.max(0, (offset || 1) - 1); // 1-indexed to 0-indexed
          const end = limit ? start + limit : lines.length;
          content = lines.slice(start, end).join("\n");
          if (!content) return `No content in '${filename}' at offset ${offset || 1} with limit ${limit || "all"}.`;
        }
        return truncate(content, MAX_RESULT);
      }

      case "write_file": {
        const { filename, content } = toolInput;
        if (!isAllowedWriteFile(filename)) {
          return `Error: Cannot write to '${filename}'. Allowed: ${WORKSPACE_FILES.join(", ")}`;
        }
        writeWorkspaceFile(filename, content);
        // Auto-sync identity.name when IDENTITY.md is written
        if (filename === "IDENTITY.md" && ctx.settingsStore) {
          const nameMatch = content.match(/\*\*Name:\*\*\s*(.+)/i);
          if (nameMatch) {
            ctx.settingsStore.set("identity.name", nameMatch[1].trim());
          }
        }
        return `Successfully wrote ${content.length} chars to ${filename}.`;
      }

      case "list_files": {
        const files = [];
        for (const f of WORKSPACE_FILES) {
          const filePath = path.join(config.WORKSPACE_DIR, f);
          try {
            const stat = fs.statSync(filePath);
            files.push(`${f}: ${stat.size} bytes`);
          } catch {
            files.push(`${f}: (not created)`);
          }
        }
        // List memory logs
        const memDir = path.join(config.WORKSPACE_DIR, "memory");
        try {
          const memFiles = fs.readdirSync(memDir).filter((f) => f.endsWith(".md")).sort();
          for (const f of memFiles.slice(-10)) {
            const stat = fs.statSync(path.join(memDir, f));
            files.push(`memory/${f}: ${stat.size} bytes`);
          }
        } catch { /* no memory dir yet */ }
        return files.join("\n");
      }

      case "remember": {
        const { fact, category } = toolInput;
        // Save to DB
        if (ctx.db) {
          try {
            const { MemoryStore } = await import("../db/memory.js");
            const store = new MemoryStore(ctx.db);
            store.addAndSync(fact, category || "fact", ctx.conversationId || null);
          } catch { /* best effort */ }
        }
        return `Remembered: "${fact}"`;
      }

      case "daily_log": {
        const { note } = toolInput;
        appendDailyLog(note);
        const today = new Date().toISOString().slice(0, 10);
        return `Logged to memory/${today}.md: "${note}"`;
      }

      case "exec": {
        const { command, timeout_ms } = toolInput;
        const timeout = Math.min(timeout_ms || 60_000, 120_000);
        // Split command for runCmd
        const result = await runCmd("sh", ["-c", command], { timeoutMs: timeout });
        const output = truncate(result.output || "(no output)", MAX_RESULT);
        return `Exit code: ${result.code}\n${output}`;
      }

      case "web_fetch": {
        const { url, method, headers, body } = toolInput;
        // URL safety check
        const { checkUrlSafety: checkFetchUrl } = await import("./url-safety.js");
        const fetchSafety = await checkFetchUrl(url, ctx.settingsStore);
        if (!fetchSafety.safe) {
          console.warn(`[web_fetch] Blocked: ${url}: ${fetchSafety.reason}`);
          return `BLOCKED: ${fetchSafety.reason}. URL: ${url}`;
        }
        const res = await fetch(url, {
          method: method || "GET",
          headers: headers || {},
          body: body || undefined,
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        return truncate(`Status: ${res.status}\n\n${text}`, MAX_RESULT);
      }

      case "search_memories": {
        const { query } = toolInput;
        const allResults = [];
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const regex = new RegExp(words.join("|"), "i");

        // 1. Search DB memories
        if (ctx.db) {
          try {
            const { MemoryStore } = await import("../db/memory.js");
            const store = new MemoryStore(ctx.db);
            const dbResults = store.search(query, 10);
            for (const m of dbResults) {
              allResults.push(`[db:${m.category}] ${m.content}`);
            }
          } catch { /* ignore db errors */ }
        }

        // 2. Search MEMORY.md and daily log files
        const searchFileForMatches = (filename) => {
          const content = readWorkspaceFile(filename);
          if (!content) return;
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              allResults.push(`[${filename}:${i + 1}] ${lines[i].trim()}`);
            }
          }
        };

        searchFileForMatches("MEMORY.md");

        // Search last 7 daily logs
        const memDir = path.join(config.WORKSPACE_DIR, "memory");
        try {
          const memFiles = fs.readdirSync(memDir)
            .filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
            .sort()
            .slice(-7);
          for (const f of memFiles) {
            searchFileForMatches(`memory/${f}`);
          }
        } catch { /* no memory dir */ }

        if (allResults.length === 0) return `No memories found matching "${query}".`;
        return allResults.slice(0, 30).join("\n");
      }

      case "search_memories_deep": {
        const { query } = toolInput;
        const sections = [];
        sections.push(`# Deep Memory Search\nQuery: "${query}"\n`);

        // 1. All DB memories
        if (ctx.db) {
          try {
            const { MemoryStore } = await import("../db/memory.js");
            const store = new MemoryStore(ctx.db);
            const all = store.list(500); // get up to 500
            if (all.length > 0) {
              sections.push(`## Database Memories (${all.length} total)\n`);
              for (const m of all) {
                sections.push(`- [${m.category}] ${m.content}`);
              }
            }
          } catch { /* ignore */ }
        }

        // 2. Full MEMORY.md
        const memoryMd = readWorkspaceFile("MEMORY.md");
        if (memoryMd) {
          sections.push(`\n## MEMORY.md\n${memoryMd}`);
        }

        // 3. Last 30 daily logs
        const memDir = path.join(config.WORKSPACE_DIR, "memory");
        try {
          const logFiles = fs.readdirSync(memDir)
            .filter((f) => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
            .sort()
            .slice(-30);
          if (logFiles.length > 0) {
            sections.push(`\n## Daily Logs (last ${logFiles.length} days)\n`);
            for (const f of logFiles) {
              try {
                const content = fs.readFileSync(path.join(memDir, f), "utf-8");
                // Truncate each log to ~2KB to stay reasonable
                sections.push(`### ${f}\n${content.slice(0, 2000)}${content.length > 2000 ? "\n...(truncated)" : ""}\n`);
              } catch { /* skip unreadable */ }
            }
          }
        } catch { /* no memory dir */ }

        // 4. Conversation summaries (auto-generated from idle conversations)
        const summaries = readWorkspaceFile("memory/summaries.md");
        if (summaries) sections.push(`\n## Conversation Summaries\n${summaries}`);

        // 5. USER.md for context
        const userMd = readWorkspaceFile("USER.md");
        if (userMd) sections.push(`\n## USER.md\n${userMd}`);

        const result = sections.join("\n");
        const tokenEstimate = Math.round(result.length / 4);
        return `${result}\n\n---\n~${tokenEstimate} tokens. Find what matches the query "${query}" and report your findings.`;
      }

      case "edit_file": {
        const { filename, old_text, new_text } = toolInput;
        if (!isAllowedWriteFile(filename)) {
          return `Error: Cannot edit '${filename}'. Allowed: ${WORKSPACE_FILES.join(", ")}`;
        }
        const existing = readWorkspaceFile(filename);
        if (!existing) return `Error: File '${filename}' is empty or does not exist.`;
        if (!existing.includes(old_text)) {
          return `Error: Could not find the specified old_text in '${filename}'. Make sure the text matches exactly (including whitespace and newlines).`;
        }
        const updated = existing.replace(old_text, new_text);
        writeWorkspaceFile(filename, updated);
        // Auto-sync identity.name when IDENTITY.md is edited
        if (filename === "IDENTITY.md" && ctx.settingsStore) {
          const nameMatch = updated.match(/\*\*Name:\*\*\s*(.+)/i);
          if (nameMatch) ctx.settingsStore.set("identity.name", nameMatch[1].trim());
        }
        return `Successfully edited '${filename}'. Replaced ${old_text.length} chars with ${new_text.length} chars.`;
      }

      case "grep": {
        const { pattern, filename } = toolInput;
        const MAX_MATCHES = 50;
        const matches = [];
        const regex = new RegExp(pattern, "i");

        const searchFile = (fname) => {
          try {
            const content = readWorkspaceFile(fname);
            if (!content) return;
            const lines = content.split("\n");
            for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
              if (regex.test(lines[i])) {
                matches.push(`${fname}:${i + 1}: ${lines[i]}`);
              }
            }
          } catch { /* skip unreadable files */ }
        };

        if (filename) {
          if (!isAllowedFile(filename)) {
            return `Error: Cannot search '${filename}'. Allowed files: ${WORKSPACE_FILES.join(", ")} and memory/*.md`;
          }
          searchFile(filename);
        } else {
          // Search all workspace files
          for (const f of WORKSPACE_FILES) {
            if (matches.length >= MAX_MATCHES) break;
            searchFile(f);
          }
          // Search memory logs
          const memDir = path.join(config.WORKSPACE_DIR, "memory");
          try {
            const memFiles = fs.readdirSync(memDir).filter((f) => f.endsWith(".md")).sort();
            for (const f of memFiles) {
              if (matches.length >= MAX_MATCHES) break;
              searchFile(`memory/${f}`);
            }
          } catch { /* no memory dir yet */ }
        }

        if (matches.length === 0) return `No matches found for pattern "${pattern}".`;
        let result = matches.join("\n");
        if (matches.length >= MAX_MATCHES) result += `\n...(capped at ${MAX_MATCHES} matches)`;
        return result;
      }

      case "append_file": {
        const { filename, content } = toolInput;
        if (!isAllowedWriteFile(filename)) {
          return `Error: Cannot append to '${filename}'. Allowed: ${WORKSPACE_FILES.join(", ")}`;
        }
        const existing = readWorkspaceFile(filename) || "";
        const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
        writeWorkspaceFile(filename, existing + separator + content);
        return `Successfully appended ${content.length} chars to '${filename}'.`;
      }

      case "send_message": {
        const { channel, message, channel_id } = toolInput;
        const preview = message.length > 80 ? message.slice(0, 80) + "..." : message;

        // Email needs an explicit target — the threadKey stored under
        // channel_conv.email:<threadKey> is a Message-ID, not an address,
        // and we don't want to guess which recipient to reach. Require
        // channel_id for email; suggest tarsee_send_email_thread for
        // full thread control.
        if (channel === "email") {
          if (!channel_id) {
            return "send_message to email requires channel_id = target email address. For threaded outbound (with In-Reply-To), use tarsee_send_email_thread instead.";
          }
          if (!ctx.channelManager) return "send_message error: channel manager unavailable";
          try {
            await ctx.channelManager.sendMessage("email", channel_id, message);
            return `Email sent to ${channel_id}: ${preview}`;
          } catch (err) {
            return `send_message email error: ${err.message}`;
          }
        }

        // For external channels (Telegram, Discord, Slack), push via ChannelManager
        if (channel !== "web" && ctx.channelManager) {
          try {
            // Resolve chat ID: explicit channel_id, or find from stored conversation mapping
            let chatId = channel_id;
            if (!chatId) {
              // Resolve chat ID from stored conversation mappings
              const store = ctx.settingsStore || (ctx.db ? new (await import("../db/settings.js")).SettingsStore(ctx.db) : null);
              if (store) {
                const convMappings = store.getByPrefix(`channel_conv.${channel}:`);
                for (const s of convMappings) {
                  // Extract chat ID from key (e.g., "channel_conv.telegram:123456" → "123456")
                  chatId = s.key.split(`${channel}:`)[1]?.split(":")[0];
                  if (chatId) break;
                }
              }
            }
            if (!chatId) return `send_message error: No chat ID found for ${channel}. The bot needs to have received at least one message from a chat first.`;
            await ctx.channelManager.sendMessage(channel, chatId, message);
            return `Message sent to ${channel} (chat ${chatId}): ${preview}`;
          } catch (err) {
            return `send_message error: ${err.message}`;
          }
        }

        // Fallback: save to DB (for web channel or when channelManager unavailable)
        if (!ctx.db) return "Database not available.";
        try {
          const { ConversationStore } = await import("../db/conversations.js");
          const store = new ConversationStore(ctx.db);
          const { SettingsStore } = await import("../db/settings.js");
          const settings = new SettingsStore(ctx.db);
          const convId = settings.get("channel_conv.web:default");
          if (convId) {
            store.addMessage(convId, { role: "assistant", content: message });
          }
          return `Message saved to web chat: ${preview}`;
        } catch (err) {
          return `send_message error: ${err.message}`;
        }
      }

      case "schedule_task": {
        const { schedule, prompt, name, action, once } = toolInput;
        try {
          const { addCronJob } = await import("./cron.js");
          const job = addCronJob({ schedule, prompt: prompt || "", name, action, once: !!once });
          const desc = action ? `direct ${action.tool}` : "AI prompt";
          const freq = once ? "one-time" : "recurring";
          return `Scheduled ${freq} task (${desc}): ${name || job.id} at ${schedule}`;
        } catch (err) {
          return `schedule_task error: ${err.message}`;
        }
      }

      case "calculator": {
        const { expression } = toolInput;
        if (!expression) return "Error: 'expression' is required.";
        // Whitelist: only allow math chars, Math.*, numbers, parentheses, spaces
        const sanitized = expression.trim();
        if (!/^[0-9+\-*/.%() ,eE\s]|Math\./g.test(sanitized) && /[a-zA-Z]/.test(sanitized.replace(/Math\.\w+/g, ""))) {
          return `Error: Invalid expression. Only math operators and Math.* functions allowed.`;
        }
        try {
          // Safe eval — only Math globals available
          const fn = new Function("Math", `"use strict"; return (${sanitized});`);
          const result = fn(Math);
          if (typeof result !== "number" || !isFinite(result)) return `Result: ${result} (not a finite number)`;
          return `${expression} = ${result}`;
        } catch (err) {
          return `Math error: ${err.message}`;
        }
      }

      case "datetime": {
        const { timezone, date: dateInput, format } = toolInput;
        const tz = timezone || config.TIMEZONE;
        try {
          let targetDate;
          if (dateInput) {
            // Parse relative dates
            const lower = (dateInput || "").toLowerCase().trim();
            if (lower === "today" || !lower) targetDate = new Date();
            else if (lower === "tomorrow") { targetDate = new Date(); targetDate.setDate(targetDate.getDate() + 1); }
            else if (lower === "yesterday") { targetDate = new Date(); targetDate.setDate(targetDate.getDate() - 1); }
            else if (lower.startsWith("next ")) {
              const dayNames = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
              const target = dayNames.indexOf(lower.replace("next ", ""));
              if (target >= 0) {
                targetDate = new Date();
                const current = targetDate.getDay();
                const diff = ((target - current + 7) % 7) || 7;
                targetDate.setDate(targetDate.getDate() + diff);
              } else targetDate = new Date(dateInput);
            }
            else targetDate = new Date(dateInput);
          } else {
            targetDate = new Date();
          }

          if (isNaN(targetDate.getTime())) return `Error: Could not parse date "${dateInput}"`;

          const opts = { timeZone: tz };
          const full = targetDate.toLocaleString("en-US", { ...opts, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
          const dayOfWeek = targetDate.toLocaleString("en-US", { ...opts, weekday: "long" });
          const dateOnly = targetDate.toLocaleString("en-US", { ...opts, year: "numeric", month: "long", day: "numeric" });
          const timeOnly = targetDate.toLocaleString("en-US", { ...opts, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
          const iso = targetDate.toISOString();

          if (format === "day") return `${dayOfWeek}`;
          if (format === "date") return `${dateOnly} (${dayOfWeek})`;
          if (format === "time") return `${timeOnly} (${tz})`;
          if (format === "iso") return iso;

          // Full format
          let result = `${full}\nTimezone: ${tz}\nDay: ${dayOfWeek}\nISO: ${iso}`;

          // Add days-until info if checking a future date
          const now = new Date();
          const diffMs = targetDate.getTime() - now.getTime();
          const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
          if (diffDays > 0) result += `\n${diffDays} days from now`;
          else if (diffDays < 0) result += `\n${Math.abs(diffDays)} days ago`;
          else result += `\nToday`;

          return result;
        } catch (err) {
          return `Datetime error: ${err.message}`;
        }
      }

      case "browser": {
        const { action, url, selector, text, script, value, timeout: userTimeout, direction } = toolInput;
        try {
          if (action === "close") {
            if (browserInstance) {
              await browserInstance.close();
              browserInstance = null;
              browserPage = null;
            }
            return "Browser closed.";
          }

          const page = await ensureBrowser();

          switch (action) {
            case "navigate": {
              if (!url) return "Error: 'url' is required for navigate action.";
              // URL safety check before navigating
              const { checkUrlSafety } = await import("./url-safety.js");
              const safety = await checkUrlSafety(url, ctx.settingsStore);
              if (!safety.safe) {
                console.warn(`[browser] Blocked navigation to ${url}: ${safety.reason}`);
                return `BLOCKED: ${safety.reason}. URL: ${url}\n\nThis URL was flagged as potentially dangerous. If you're sure it's safe, ask the user to confirm.`;
              }
              await page.goto(url, { waitUntil: "domcontentloaded", timeout: userTimeout || 30_000 });
              const title = await page.title();
              return `Navigated to: ${page.url()}\nTitle: ${title}`;
            }
            case "screenshot": {
              const buf = await page.screenshot({ type: "png", fullPage: false });
              const b64 = buf.toString("base64");
              return `Screenshot captured (${buf.length} bytes, base64). Data URL: data:image/png;base64,${b64.slice(0, 200)}... (truncated for display, full image available)`;
            }
            case "click": {
              if (!selector) return "Error: 'selector' is required for click action.";
              await page.click(selector, { timeout: userTimeout || 10_000 });
              await page.waitForTimeout(500); // brief settle after click
              return `Clicked element: ${selector}`;
            }
            case "type": {
              if (!selector) return "Error: 'selector' is required for type action.";
              if (!text) return "Error: 'text' is required for type action.";
              // Clear field first, then type with human-like delay
              await page.click(selector, { timeout: 5000 });
              await page.fill(selector, "");
              await page.type(selector, text, { delay: 50 + Math.random() * 80 });
              return `Typed "${text}" into ${selector}`;
            }
            case "evaluate": {
              if (!script) return "Error: 'script' is required for evaluate action.";
              const result = await page.evaluate(script);
              return truncate(JSON.stringify(result, null, 2) || "undefined", MAX_RESULT);
            }
            case "get_text": {
              const bodyText = await page.textContent("body");
              return truncate(bodyText || "(empty page)", MAX_RESULT);
            }
            case "wait_for": {
              if (selector) {
                await page.waitForSelector(selector, { timeout: userTimeout || 30_000 });
                return `Element found: ${selector}`;
              }
              // Wait for navigation/load
              await page.waitForLoadState("networkidle", { timeout: userTimeout || 30_000 });
              return `Page loaded (networkidle). URL: ${page.url()}`;
            }
            case "scroll": {
              const dir = direction || "down";
              if (dir === "bottom") await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
              else if (dir === "top") await page.evaluate(() => window.scrollTo(0, 0));
              else if (dir === "up") await page.evaluate(() => window.scrollBy(0, -600));
              else await page.evaluate(() => window.scrollBy(0, 600));
              await page.waitForTimeout(300);
              return `Scrolled ${dir}. Page height: ${await page.evaluate(() => document.body.scrollHeight)}px`;
            }
            case "select": {
              if (!selector) return "Error: 'selector' is required for select action.";
              if (!value) return "Error: 'value' is required for select action.";
              await page.selectOption(selector, value);
              return `Selected "${value}" in ${selector}`;
            }
            case "solve_captcha": {
              return await solveCaptcha(page, ctx.settingsStore);
            }
            default:
              return `Unknown browser action: ${action}. Valid: navigate, screenshot, click, type, evaluate, get_text, wait_for, scroll, select, solve_captcha, close`;
          }
        } catch (err) {
          return `Browser error (${action}): ${err.message}`;
        }
      }

      case "web_search": {
        const { query, max_results } = toolInput;
        const limit = Math.min(Math.max(max_results || 5, 1), 10);
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res = await fetch(searchUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
          signal: AbortSignal.timeout(15_000),
        });
        const html = await res.text();

        // Parse results from DuckDuckGo HTML
        const results = [];
        const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
        const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

        let match;
        while ((match = resultRegex.exec(html)) !== null && results.length < limit) {
          const rawUrl = match[1];
          const title = match[2].replace(/<[^>]+>/g, "").trim();
          // DuckDuckGo wraps URLs in a redirect; extract the actual URL
          let actualUrl = rawUrl;
          const uddgMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
          if (uddgMatch) actualUrl = decodeURIComponent(uddgMatch[1]);
          results.push({ title, url: actualUrl, snippet: "" });
        }

        // Extract snippets
        let snippetIdx = 0;
        while ((match = snippetRegex.exec(html)) !== null && snippetIdx < results.length) {
          results[snippetIdx].snippet = match[1].replace(/<[^>]+>/g, "").trim();
          snippetIdx++;
        }

        if (results.length === 0) return `No results found for "${query}".`;

        return results.map((r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
        ).join("\n\n");
      }

      case "pdf_read": {
        const { source } = toolInput;
        let pdfBuffer;

        if (source.startsWith("http://") || source.startsWith("https://")) {
          // Fetch PDF from URL
          const res = await fetch(source, {
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) return `Error fetching PDF: HTTP ${res.status}`;
          pdfBuffer = Buffer.from(await res.arrayBuffer());
        } else {
          // Read from workspace
          const filePath = path.join(config.WORKSPACE_DIR, source);
          try {
            pdfBuffer = fs.readFileSync(filePath);
          } catch (err) {
            return `Error reading PDF file '${source}': ${err.message}`;
          }
        }

        // Try pdftotext first (poppler-utils), fall back to raw text extraction
        try {
          const { execSync } = await import("node:child_process");
          const tmpPath = path.join(config.WORKSPACE_DIR, ".tmp_pdf_read.pdf");
          fs.writeFileSync(tmpPath, pdfBuffer);
          try {
            const text = execSync(`pdftotext "${tmpPath}" -`, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }).toString();
            fs.unlinkSync(tmpPath);
            if (text.trim()) return truncate(text, MAX_RESULT);
          } catch {
            // pdftotext not available, fall through
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          }
        } catch { /* ignore */ }

        // Fallback: extract readable ASCII text from PDF binary
        const rawText = pdfBuffer.toString("utf-8").replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s{3,}/g, " ").trim();
        if (rawText.length < 50) return "Could not extract meaningful text from this PDF. Install poppler-utils (pdftotext) for better PDF support.";
        return truncate(`(Raw text extraction — install pdftotext for better results)\n\n${rawText}`, MAX_RESULT);
      }

      case "get_key": {
        const { name: keyName } = toolInput;
        try {
          const { getKey } = await import("./key-vault.js");
          const value = getKey(keyName);
          if (!value) return `Key "${keyName}" not found in vault. Use list_keys to see available keys.`;
          return value;
        } catch (err) {
          return `get_key error: ${err.message}`;
        }
      }

      case "set_key": {
        const { name: skName, value: skValue, description: skDesc } = toolInput;
        try {
          const { setKey } = await import("./key-vault.js");
          const result = setKey(skName, skValue, skDesc);
          return `Key "${result.name}" saved securely (masked: ${result.masked}). Description: ${result.description || "none"}`;
        } catch (err) {
          return `set_key error: ${err.message}`;
        }
      }

      case "list_keys": {
        try {
          const { listKeys } = await import("./key-vault.js");
          const keys = listKeys();
          if (keys.length === 0) return "No keys stored in vault. Use set_key to add API keys.";
          return keys.map(k => k.name + ": " + (k.description || "(no description)") + " [masked: " + k.masked + "]").join("\n");
        } catch (err) {
          return `list_keys error: ${err.message}`;
        }
      }

      case "delete_key": {
        const { name: dkName } = toolInput;
        try {
          const { deleteKey } = await import("./key-vault.js");
          const deleted = deleteKey(dkName);
          return deleted ? `Key "${dkName}" deleted from vault.` : `Key "${dkName}" not found.`;
        } catch (err) {
          return `delete_key error: ${err.message}`;
        }
      }

      case "create_canvas": {
        const { title, html, css, js } = toolInput;
        try {
          const { CanvasServer } = await import("./canvas.js");
          const canvas = CanvasServer.create();
          const canvasId = title.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
          const result = canvas.serve(canvasId, html, css, js);
          return `Canvas created! View at: /canvas/${canvasId}/  (${result.size} bytes)`;
        } catch (err) {
          return `create_canvas error: ${err.message}`;
        }
      }

      case "create_diagram": {
        const { title, nodes, edges, legend } = toolInput;
        try {
          if (!Array.isArray(nodes) || nodes.length === 0) {
            return "create_diagram error: nodes array is required and must be non-empty";
          }
          if (!Array.isArray(edges)) {
            return "create_diagram error: edges array is required";
          }
          const ids = new Set(nodes.map((n) => n.id));
          for (const e of edges) {
            if (!ids.has(e.from) || !ids.has(e.to)) {
              return `create_diagram error: edge references unknown node id (${e.from} -> ${e.to})`;
            }
          }
          const { CanvasServer } = await import("./canvas.js");
          const { renderDiagramHtml } = await import("./diagram-renderer.js");
          const canvas = CanvasServer.create();
          const slug = title.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
          const canvasId = "diagram-" + (slug || Math.random().toString(36).slice(2, 8));
          const html = renderDiagramHtml({ title, nodes, edges, legend, diagramId: canvasId });
          const result = canvas.serve(canvasId, html);
          return `Diagram created! View at: /canvas/${canvasId}/  (${nodes.length} nodes, ${edges.length} edges, ${result.size} bytes)`;
        } catch (err) {
          return `create_diagram error: ${err.message}`;
        }
      }

      case "configure_email_channel": {
        // Partial-update: only keys passed are written, rest preserved.
        // Chat-driven setup path for the email channel — see plan file.
        if (!ctx.settingsStore) return "configure_email_channel error: settings store unavailable";
        const prev = ctx.settingsStore.get("channel.email") || {};
        const input = toolInput || {};
        const merged = {
          enabled: input.enabled !== undefined ? !!input.enabled : (prev.enabled ?? false),
          tarseeEmailAddress: input.tarseeEmailAddress ?? prev.tarseeEmailAddress ?? (input.imap?.user ?? prev.imap?.user ?? ""),
          fromName: input.fromName ?? prev.fromName ?? "Tarsee",
          defaultSubject: input.defaultSubject ?? prev.defaultSubject ?? "Tarsee",
          mentionKeyword: input.mentionKeyword ?? prev.mentionKeyword ?? "tarsee",
          replyAllMarker: input.replyAllMarker ?? prev.replyAllMarker ?? "[reply-all]",
          allowlistFromAddresses: Array.isArray(input.allowlistFromAddresses)
            ? input.allowlistFromAddresses
            : (prev.allowlistFromAddresses || []),
          imap: {
            host: input.imap?.host ?? prev.imap?.host ?? "",
            port: Number(input.imap?.port ?? prev.imap?.port ?? 993),
            user: input.imap?.user ?? prev.imap?.user ?? "",
            password: input.imap?.password ?? prev.imap?.password ?? "",
            secure: input.imap?.secure !== false,
          },
          smtp: {
            host: input.smtp?.host ?? prev.smtp?.host ?? "",
            port: Number(input.smtp?.port ?? prev.smtp?.port ?? 465),
            user: input.smtp?.user ?? prev.smtp?.user ?? "",
            password: input.smtp?.password ?? prev.smtp?.password ?? "",
            secure: input.smtp?.secure !== false,
          },
        };
        ctx.settingsStore.set("channel.email", merged);

        // Restart the channel if fully configured + enabled.
        if (merged.enabled && merged.imap.host && merged.imap.user && merged.smtp.host && merged.smtp.user) {
          if (ctx.channelManager) {
            try { await ctx.channelManager.restart("email"); }
            catch (err) { return `Email saved, but restart failed: ${err.message}`; }
          }
        } else if (!merged.enabled && ctx.channelManager) {
          try { await ctx.channelManager.stop("email"); } catch {}
        }

        // Human-readable confirmation with passwords masked.
        const maskPw = (p) => (p ? "•".repeat(Math.min(16, p.length)) : "(not set)");
        const allowlistSummary = merged.allowlistFromAddresses.length
          ? `${merged.allowlistFromAddresses.length} address${merged.allowlistFromAddresses.length === 1 ? "" : "es"} (${merged.allowlistFromAddresses[0]}${merged.allowlistFromAddresses.length > 1 ? ", …" : ""})`
          : "empty — WARNING: allows any sender";
        return [
          "✓ Email channel configured:",
          `  Mailbox:     ${merged.tarseeEmailAddress || "(not set)"}`,
          `  IMAP:        ${merged.imap.host || "(not set)"}:${merged.imap.port} as ${merged.imap.user || "(not set)"} (password ${maskPw(merged.imap.password)})`,
          `  SMTP:        ${merged.smtp.host || "(not set)"}:${merged.smtp.port} as ${merged.smtp.user || "(not set)"} (password ${maskPw(merged.smtp.password)})`,
          `  Mention:     @${merged.mentionKeyword}`,
          `  Reply-all:   ${merged.replyAllMarker}`,
          `  Allowlist:   ${allowlistSummary}`,
          `  Enabled:     ${merged.enabled ? "yes — IMAP IDLE connecting…" : "no"}`,
        ].join("\n");
      }

      case "send_email_thread": {
        const { to, cc, subject, body, inReplyTo } = toolInput || {};
        if (!to) return "send_email_thread error: 'to' is required";
        if (!subject) return "send_email_thread error: 'subject' is required";
        if (!body) return "send_email_thread error: 'body' is required";
        if (!ctx.channelManager) return "send_email_thread error: channel manager unavailable";
        const emailChannel = ctx.channelManager.channels?.get?.("email");
        if (!emailChannel?.bot?.sendNew) {
          return "send_email_thread error: email channel not running. Configure it in Settings > Channels > Email or via tarsee_configure_email_channel.";
        }
        try {
          const { messageId } = await emailChannel.bot.sendNew({ to, cc, subject, body, inReplyTo });
          const toDisplay = Array.isArray(to) ? to.join(", ") : to;
          return `Email ${inReplyTo ? "reply" : "thread"} sent to ${toDisplay}. Message-ID: ${messageId || "(unknown)"}`;
        } catch (err) {
          return `send_email_thread error: ${err.message}`;
        }
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    return `Tool error (${toolName}): ${err.message}`;
  }
}

// ── Helpers ──

function isAllowedFile(filename) {
  if (WORKSPACE_FILES.includes(filename)) return true;
  if (filename.startsWith("memory/") && filename.endsWith(".md")) return true;
  return false;
}

function isAllowedWriteFile(filename) {
  return WORKSPACE_FILES.includes(filename);
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max) + "\n...(truncated)";
}
