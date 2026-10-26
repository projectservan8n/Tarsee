/**
 * Text cleanup for the Phonon TTS engine.
 *
 * cleanSpeechText: the same cleanup Edge TTS and Piper do before speaking:
 * drop emoji, code, markdown links and marks, and fold newlines into pauses.
 *
 * speakPesos: Phonon's own text normalizer spells out dollars ("$5" becomes
 * "5 dollars") but passes the peso sign through untouched, and the model then
 * garbles the amount. "PHP 2,500" fares no better: it is read letter by letter
 * before the number. Writing the currency out as a word first ("2,500 pesos")
 * lets the normalizer read the number properly.
 */

// The same emoji class as edge-tts-engine.js. The ZWJ and variation selectors
// are bare members on purpose: this deletes every codepoint of a sequence
// rather than matching the sequence as one grapheme.
// eslint-disable-next-line no-misleading-character-class
const EMOJI = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2702}-\u{27B0}\u{200D}\u{20E3}\u{FE0F}]/gu;

export function cleanSpeechText(text) {
  return String(text || "")
    .replace(EMOJI, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~#>]/g, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// An amount that is never cut short ("12,500" is never read as "12"), then an
// optional scale word, then the word "pesos" when the writer already put it
// (it is swallowed so it is not said twice).
const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\d]|[.,]\d)`;
const TAIL = String.raw`(?:\s?(k|K|M|B|thousand|million|billion)\b)?(\s*(?:pesos?|PHP)\b)?`;
const SCALE_WORDS = { k: "thousand", K: "thousand", M: "million", B: "billion" };

function pesoWords(amount, scale) {
  return `${amount}${scale ? ` ${SCALE_WORDS[scale] || scale}` : ""} pesos`;
}

const PESO_SIGN = new RegExp(String.raw`₱\s?${AMOUNT}${TAIL}`, "g");
const PESO_CODE = new RegExp(String.raw`\b(?:PHP|Php|php)\s?${AMOUNT}${TAIL}`, "g");
// A bare "P" only when it is clearly money: thousands commas or two decimals
// ("P2,500", "P99.50"). Still opt-in, because "P" has other meanings.
const PESO_P = new RegExp(String.raw`\bP(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d{2})(?![\d]|[.,]\d)${TAIL}`, "g");

// "PHP 8.3" is far more often the programming language than eight pesos: a
// one-digit amount with at most one decimal and no scale or "pesos" after it
// is left alone.
const LOOKS_LIKE_VERSION = /^\d(?:\.\d)?$/;

/**
 * "₱12,500", "PHP 2,500" and "Php1.5M" become "12,500 pesos", "2,500 pesos"
 * and "1.5 million pesos". With opts.barePeso, "P2,500" and "P99.50" do too.
 */
export function speakPesos(text, opts = {}) {
  let out = String(text || "")
    .replace(PESO_SIGN, (_m, amount, scale) => pesoWords(amount, scale))
    .replace(PESO_CODE, (m, amount, scale, word) =>
      (!scale && !word && LOOKS_LIKE_VERSION.test(amount) ? m : pesoWords(amount, scale)));
  if (opts.barePeso) out = out.replace(PESO_P, (_m, amount, scale) => pesoWords(amount, scale));
  return out;
}

/** Text as Phonon should receive it. opts.barePeso: also read "P2,500" as pesos. */
export function phononSpeechText(text, opts = {}) {
  return speakPesos(cleanSpeechText(text), opts);
}
