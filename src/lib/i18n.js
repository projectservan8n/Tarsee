/**
 * Internationalization (i18n) for Tarsee.
 * Simple key-based translation with locale support.
 */
import fs from "node:fs";
import path from "node:path";

const translations = new Map();
let currentLocale = "en";

const I18N_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..", "i18n");

export function setLocale(locale) {
  currentLocale = locale;
  loadLocale(locale);
}

export function getLocale() { return currentLocale; }

export function t(key, params = {}) {
  const locale = translations.get(currentLocale) || translations.get("en") || {};
  let text = locale[key] || key;
  for (const [k, v] of Object.entries(params)) {
    text = text.replace(`{${k}}`, String(v));
  }
  return text;
}

export function listLocales() {
  try {
    return fs.readdirSync(I18N_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""));
  } catch { return ["en"]; }
}

function loadLocale(locale) {
  if (translations.has(locale)) return;
  try {
    const filePath = path.join(I18N_DIR, `${locale}.json`);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    translations.set(locale, data);
  } catch { /* locale file not found */ }
}

// Auto-load English on import
loadLocale("en");
