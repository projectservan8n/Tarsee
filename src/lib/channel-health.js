/**
 * Channel health monitor — auto-recovers a stuck Telegram poller.
 *
 * The failure it fixes: on boot (or after a network blip) the process starts
 * before DNS/egress is ready, so Telegram's getUpdates long-poll launches into
 * a dead network and gets stuck — "bot started" but never actually pulling
 * messages. They queue server-side (pending_update_count climbs) and never
 * reach the agent. On Railway this is worse than on a workstation: there is no
 * console to restart the channel by hand, so without this monitor the channel
 * stays dead until the next deploy.
 *
 * Detection (external, doesn't touch Telegraf internals): poll
 * getWebhookInfo. A HEALTHY poller keeps pending_update_count at ~0 (it
 * drains the queue immediately). A STUCK poller leaves it climbing. If
 * pending > 0 for STUCK_CHECKS consecutive checks (≈2 min — long enough
 * to not false-fire on a poller that's momentarily behind), relaunch the
 * channel. getWebhookInfo never consumes updates and doesn't conflict
 * with getUpdates, so the probe is side-effect-free.
 *
 * If Telegram is simply unreachable (network genuinely down), we do NOT
 * relaunch — that's not a poller bug, and relaunching wouldn't help.
 */

import { SettingsStore } from "../db/settings.js";

const CHECK_MS = Number(process.env.TARSEE_CHANNEL_HEALTH_MS) || 60_000;
const STUCK_CHECKS = 2;

let _timer = null;
let _deps = null;
let _tgStuck = 0;

export function startChannelHealth({ channelManager, db }) {
  _deps = { channelManager, db };
  _timer = setInterval(() => check().catch((e) => console.warn("[channel-health] check error:", e?.message)), CHECK_MS);
  _timer.unref?.();
  console.log(`[channel-health] started — watching channel pollers every ${Math.round(CHECK_MS / 1000)}s`);
}

export function stopChannelHealth() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

async function check() {
  await checkTelegram();
}

async function checkTelegram() {
  const { channelManager, db } = _deps || {};
  if (!channelManager) return;

  // Only monitor if telegram is configured + enabled + currently registered.
  let token;
  try {
    const cfg = new SettingsStore(db).get("channel.telegram");
    if (!cfg?.enabled || !cfg?.token) { _tgStuck = 0; return; }
    token = cfg.token;
  } catch { return; }
  if (!channelManager.channels?.get?.("telegram")) { _tgStuck = 0; return; }

  let pending = 0;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json();
    if (!json?.ok) return;
    pending = json.result?.pending_update_count || 0;
  } catch {
    // Can't reach Telegram → network down, not a poller bug. Don't relaunch.
    return;
  }

  if (pending > 0) {
    // A relaunch is ONLY warranted for a genuinely boot-wedged poller — one
    // that has pulled ZERO updates since launch and isn't mid-turn. A poller
    // that HAS received messages is proven working; pending>0 there just
    // means a long turn is blocking the poll loop. Relaunching that one would
    // (a) disrupt the in-flight turn and (b) make Telegram re-deliver the
    // last unconfirmed update as a DUPLICATE — the exact bug this guard fixes.
    const bot = channelManager.channels?.get?.("telegram")?.bot;
    const h = typeof bot?.health === "function" ? bot.health() : null;
    const bootWedged = h ? (h.updatesReceived === 0 && h.handlerActive === 0) : true;
    if (!bootWedged) {
      _tgStuck = 0; // working-but-busy (or mid-turn) — leave it alone
      return;
    }
    _tgStuck += 1;
    console.warn(`[channel-health] telegram boot-wedged: ${pending} un-pulled, 0 ever received — stuck check ${_tgStuck}/${STUCK_CHECKS}`);
    if (_tgStuck >= STUCK_CHECKS) {
      _tgStuck = 0;
      console.warn("[channel-health] telegram poller wedged from boot — relaunching to recover");
      try {
        // deliverPending: these queued updates are fresh messages the wedged
        // poller failed to pull — deliver them, don't drop them.
        await channelManager.restart("telegram", { deliverPending: true });
        console.log("[channel-health] telegram relaunched — poller should now drain the queue");
      } catch (e) {
        console.error("[channel-health] telegram relaunch failed:", e?.message);
      }
    }
  } else {
    _tgStuck = 0; // healthy: queue is draining
  }
}
