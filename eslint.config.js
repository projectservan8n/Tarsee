import js from "@eslint/js";
import globals from "globals";

// Why this file exists.
//
// `npm run lint` used to be `node -c src/server.js`, which only parses. It
// cannot see that a callback references a variable that does not exist in its
// scope, because that is a runtime failure, not a syntax error. In 7f46330 the
// two housekeeping setIntervals in src/middleware/auth.js had their `const`
// lines transposed; the file parsed clean, shipped green, and then killed the
// process exactly 30 minutes after every boot. Both Railway deployments were
// dead for nine days before anyone noticed (fixed in 5bf90b3).
//
// `no-undef` catches that in about a second. The rest of this is eslint's
// recommended set with the style and hygiene rules switched off, so what
// remains is defects only. Keep it green: the value of this suite is that any
// output at all is a real signal.

/** Top-level objects each public script defines and the others consume. */
const appGlobals = {
  API: "readonly",          // js/api.js
  App: "readonly",          // js/app.js
  Chat: "readonly",         // js/chat.js
  Console: "readonly",      // js/console.js
  FileManager: "readonly",  // js/files.js
  Settings: "readonly",     // js/settings.js
  Setup: "readonly",        // js/setup.js
  Voice: "readonly",        // js/voice.js
  escapeHtml: "readonly",   // js/chat.js
};

/** Vendor globals from the CDN <script> tags in index.html / terminal.html. */
const vendorGlobals = {
  qrcode: "readonly",        // qrcode-generator
  Terminal: "readonly",      // xterm
  FitAddon: "readonly",      // xterm-addon-fit
  WebLinksAddon: "readonly", // xterm-addon-web-links
};

// Rules that fire on this codebase but describe style or hygiene rather than a
// defect. Each was reviewed against every current violation before being
// switched off; see the commit that introduced this file.
const nonDefectRules = {
  "no-unused-vars": "off",
  "no-empty": "off",
  // Always-overwritten initialisers (`let pending = 0` before a try/catch).
  // Defensive, not dead code.
  "no-useless-assignment": "off",
  "no-extra-boolean-cast": "off",
  // Worth doing, but re-throwing without `cause` is not a live bug.
  "preserve-caught-error": "off",
};

const baseRules = { ...js.configs.recommended.rules, ...nonDefectRules };

export default [
  {
    // src/skills is vendored skill documentation, not application code.
    ignores: ["node_modules/**", "data/**", "src/skills/**"],
  },

  // Everything that runs in Node: server, channels, libs, CLI, tests.
  {
    files: ["src/**/*.js", "test/**/*.js"],
    ignores: ["src/public/**"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: baseRules,
  },

  // tools.js drives Playwright. The bodies of page.evaluate() and
  // addInitScript() are serialised and run inside the browser, so `window` and
  // `document` are correct there even though the file itself is Node.
  {
    files: ["src/lib/tools.js"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  // Browser code: classic scripts sharing one global scope. The app globals
  // are declared above rather than ignored, so a typo in a cross-file
  // reference is still an error. builtinGlobals is off because each of those
  // files legitimately declares the one global it owns.
  {
    files: ["src/public/**/*.js"],
    ignores: ["src/public/sw.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser, ...appGlobals, ...vendorGlobals },
    },
    rules: { ...baseRules, "no-redeclare": ["error", { builtinGlobals: false }] },
  },

  // The service worker has its own global scope.
  {
    files: ["src/public/sw.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: globals.serviceworker,
    },
    rules: baseRules,
  },
];
