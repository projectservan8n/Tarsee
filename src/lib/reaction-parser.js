/**
 * Agent reaction parser.
 * Detects [react: emoji] markers in AI responses, strips them,
 * and returns the emojis for the channel to apply as reactions.
 *
 * Also detects [buttons: ...] markers for inline button support.
 */

const REACT_PATTERN = /\[react:\s*([^\]]+)\]/g;
const BUTTONS_PATTERN = /\[buttons:\s*(\[[\s\S]*?\])\]/;

/**
 * Parse and strip reaction markers from AI response text.
 * @param {string} text - The AI response text
 * @returns {{ cleanText: string, reactions: string[], buttons: Array<{text: string, data: string}>|null }}
 */
export function parseReactions(text) {
  if (!text) return { cleanText: text, reactions: [], buttons: null };

  const reactions = [];

  // Extract [react: emoji] markers
  let match;
  while ((match = REACT_PATTERN.exec(text)) !== null) {
    const emoji = match[1].trim();
    if (emoji) reactions.push(emoji);
  }

  // Strip reaction markers from text
  let cleanText = text.replace(REACT_PATTERN, "").trim();

  // Extract [buttons: [...]] marker
  let buttons = null;
  const btnMatch = cleanText.match(BUTTONS_PATTERN);
  if (btnMatch) {
    try {
      const parsed = JSON.parse(btnMatch[1]);
      if (Array.isArray(parsed)) {
        buttons = parsed.map((b) => {
          if (typeof b === "string") return { text: b, data: b.toLowerCase().replace(/\s+/g, "_") };
          return { text: b.text || b.label || "?", data: b.data || b.value || b.text || "?" };
        });
      }
    } catch {
      // Invalid JSON — ignore
    }
    cleanText = cleanText.replace(BUTTONS_PATTERN, "").trim();
  }

  return { cleanText, reactions, buttons };
}
