/**
 * A channel's platform refused its credential (a wrong token, a password the mail server won't take, a permission
 * left off in a developer portal). Trying again can't help until someone changes it in Settings, so the channel
 * manager doesn't retry it at boot (channels/manager.js _startWithRetry); the message says what to change.
 */
export function refused(message) {
  return Object.assign(new Error(message), { refused: true });
}
