import path from "node:path";

/**
 * Resolves a user-provided path and ensures it falls under one of the allowed root directories.
 * Throws if the resolved path escapes the allowed boundaries.
 *
 * @param {string} userPath - The user-provided path (relative or absolute)
 * @param {string[]} allowedRoots - Array of absolute directory paths that are allowed
 * @returns {string} The resolved, validated absolute path
 */
/**
 * Names that must never be readable or writable through a file API, even when
 * they sit inside an allowed root.
 *
 * Defence in depth behind the root check. The file routes used to allow
 * STATE_DIR, which is the parent of the workspace and holds the Claude OAuth
 * credentials, the encryption key, the master API token, the live SQLite
 * database and the hooks directory that is imported at boot — so "browse my
 * files" was also "read every credential and write code that runs on restart".
 * The roots are tightened now; this list means a future root change, a symlink,
 * or a nested copy cannot quietly re-open the same hole.
 */
const DENIED_SEGMENTS = [
  ".credentials.json",
  ".encryption-key",
  "api.token",
  ".claude-code-home",
  "vault.json",
];

/** Anything matching these is a database or its sidecars. */
const DENIED_PATTERNS = [/\.db$/i, /\.db-wal$/i, /\.db-shm$/i, /\.credentials\.json$/i];

/**
 * True when a resolved path points at something that must never be served.
 * @param {string} resolvedPath - an already-resolved absolute path
 * @returns {boolean}
 */
export function isSensitivePath(resolvedPath) {
  const segments = String(resolvedPath).split(/[\\/]/);
  if (segments.some((s) => DENIED_SEGMENTS.includes(s))) return true;
  return DENIED_PATTERNS.some((re) => re.test(resolvedPath));
}

export function safePath(userPath, allowedRoots) {
  if (!userPath || typeof userPath !== "string") {
    throw new Error("Invalid path");
  }

  if (!allowedRoots || allowedRoots.length === 0) {
    throw new Error("No allowed roots configured");
  }

  // Resolve relative to the first allowed root
  const resolved = path.resolve(allowedRoots[0], userPath);
  const normalised = path.normalize(resolved);

  for (const root of allowedRoots) {
    const absRoot = path.resolve(root);
    if (normalised === absRoot || normalised.startsWith(absRoot + path.sep)) {
      if (isSensitivePath(normalised)) {
        throw new Error("Path is not accessible");
      }
      return normalised;
    }
  }

  throw new Error("Path outside allowed directories");
}

/**
 * Sanitizes a filename for use in Content-Disposition headers.
 * Strips characters that could cause header injection.
 */
export function sanitizeFilename(name) {
  return String(name)
    .replace(/["\\\r\n]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")  // ASCII printable only
    .replace(/\s+/g, "_")
    .slice(0, 255) || "download";
}

/**
 * Checks if a tar entry path looks safe (no traversal, no absolute paths).
 */
export function looksSafeTarPath(p) {
  if (!p || typeof p !== "string") return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;  // Windows drive letters
  if (p.split("/").includes("..")) return false;
  if (p.split("\\").includes("..")) return false;
  return true;
}
