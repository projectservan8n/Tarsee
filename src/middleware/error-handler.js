import { redactSecrets } from "../lib/redact.js";
import { recordError, shouldAutoHeal } from "../lib/self-heal.js";

/**
 * Global Express error handler.
 * Catches unhandled errors, logs them, and returns a safe JSON response.
 * Records errors for self-healing trend analysis.
 */
export function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? err.message : "Internal server error";

  // Log the full error (redacted) for debugging
  if (status >= 500) {
    console.error("[error]", redactSecrets(err.stack || err.message || String(err)));

    // Record for self-healing
    recordError(err, `${req.method} ${req.path}`);

    // If error rate is spiking, log a warning
    if (shouldAutoHeal()) {
      console.warn("[self-heal] Error threshold exceeded — run /doctor or console: doctor fix");
    }
  }

  // Don't leak internal details to clients
  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV !== "production" && status >= 500 ? { detail: redactSecrets(String(err.message)) } : {}),
  });
}
