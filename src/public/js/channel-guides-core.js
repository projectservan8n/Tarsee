/**
 * How to connect each chat platform, with no page: Settings → Channels (js/settings.js) and the setup wizard's
 * Channels step (js/setup.js) both draw from this, so the two never disagree. test/channel-guides-core.test.js
 * checks it in Node.
 *
 *   PLATFORMS        the platforms in the order they are offered: id, name, the Settings section it lives in,
 *                    what it takes (one line), the steps, and the tips for when it does not answer
 *   get(id)          one of them
 *   guideHtml(id)    its steps and tips as HTML (a <details> the page can open and close)
 *   statusLine(s)    a channel's status from GET /api/status → channels.<id>, as words and a tone
 *   EMAIL_PROVIDERS  where each mail provider makes an app password, for the email presets
 *
 * The steps are static, trusted text written here (HTML allowed); nothing a person types goes through them.
 * Loaded by index.html as a plain script (window.ChannelGuides) and by the tests as a module (globalThis.ChannelGuides).
 */
(function () {
  "use strict";

  const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

  const PLATFORMS = [
    {
      id: "telegram",
      name: "Telegram",
      section: "telegramChannelSection",
      needs: "A bot from @BotFather. About 2 minutes, all inside Telegram.",
      steps: [
        `In Telegram, open ${link("https://t.me/BotFather", "@BotFather")} (the official bot maker, with a blue tick), press <strong>Start</strong>, and send <code>/newbot</code>.`,
        "Send it a display name (anything, like <em>My Tarsee</em>), then a username that ends in <code>bot</code> (like <code>my_tarsee_bot</code>: letters, numbers and underscores; it can't be changed later).",
        "BotFather answers with a token that looks like <code>123456789:AAH…</code>. Copy it.",
        "Paste it in <strong>Bot token</strong> below and click <strong>Save Telegram</strong>. The status should turn to <em>Connected as @your_bot</em>.",
        "Open your bot in Telegram (BotFather sends its link), press <strong>Start</strong>, and say hello. A bot can't write to you first.",
      ],
      tips: [
        "In a group, add the bot as a member. It answers replies to its messages and @mentions.",
        "If it ignores @mentions in a group, or you want it to read every message (Bot Behavior → Mention mode off): make the bot a group admin, or send BotFather <code>/setprivacy</code>, pick your bot, choose <strong>Disable</strong>, then remove the bot from the group and add it again.",
        "Lost the token, or someone else saw it? Send BotFather <code>/token</code> for a new one, and paste that here.",
        "Only one program can read a bot's messages at a time. Running two Tarsees with the same token (say, on your laptop and on Railway) loses messages.",
      ],
    },
    {
      id: "discord",
      name: "Discord",
      section: "discordChannelSection",
      needs: "A bot from the Discord Developer Portal, invited to your server. About 5 minutes.",
      steps: [
        `Open the ${link("https://discord.com/developers/applications", "Discord Developer Portal")}, click <strong>New Application</strong> (or <strong>Create App</strong>), name it, and click <strong>Create</strong>.`,
        "In the left menu open <strong>Bot</strong>. Click <strong>Reset Token</strong>, confirm, and copy the token (Discord shows it only once).",
        "On the same page, under <strong>Privileged Gateway Intents</strong>, turn on <strong>Message Content Intent</strong> and save. Without it Discord won't let Tarsee read messages.",
        "Paste the token in <strong>Bot token</strong> below and click <strong>Save Discord</strong>. The status should turn to <em>Connected as …</em>.",
        "Click <strong>Add the bot to a server</strong> (it appears here once it's connected), pick your server, and click <strong>Authorize</strong>. You need the <em>Manage Server</em> permission there.",
        "In a channel the bot can see, @mention it. You can also DM it.",
      ],
      tips: [
        "It answers in a server only when @mentioned (Bot Behavior → Mention mode), and always in DMs and in threads it's in.",
        "If it doesn't answer in a channel, check the channel's permissions let the bot <em>View Channel</em>, <em>Send Messages</em>, <em>Send Messages in Threads</em> and <em>Read Message History</em>. A private channel needs the bot's role added to it.",
        "If adding it to a server says <em>Integration requires code grant</em>, turn off <strong>Requires OAuth2 Code Grant</strong> on the Bot page.",
        "To copy a channel or user ID for the allowlist: in Discord open User Settings (the cog) → Advanced, turn on <strong>Developer Mode</strong>, then right-click the channel or person (long-press on a phone) → <strong>Copy Channel ID</strong> / <strong>Copy User ID</strong>.",
        "To let Tarsee make channels and webhooks for you, give its role <em>Manage Channels</em>, <em>Manage Roles</em> and <em>Manage Webhooks</em> in Server Settings → Roles.",
      ],
    },
    {
      id: "slack",
      name: "Slack",
      section: "slackChannelSection",
      needs: "A Slack app made from Tarsee's manifest, plus its two tokens. About 5 minutes.",
      steps: [
        "Click <strong>Copy app manifest</strong> below.",
        `Open ${link("https://api.slack.com/apps?new_app=1", "api.slack.com/apps")} and click <strong>Create an App</strong> → <strong>Paste a manifest</strong> → <strong>Continue</strong>. Open the <strong>YAML</strong> tab, replace what's there with the copied manifest, choose your workspace, then <strong>Next</strong> → <strong>Create</strong>.`,
        "In the app's left menu open <strong>Install App</strong> → <strong>Install to <em>your workspace</em></strong> → <strong>Allow</strong>. Copy the <strong>Bot User OAuth Token</strong> (starts <code>xoxb-</code>) into box 1 below.",
        "Open <strong>Basic Information</strong> → <strong>App-Level Tokens</strong> → <strong>Generate Token and Scopes</strong>. Type any name, click <strong>Add Scope</strong> → <code>connections:write</code> → <strong>Generate</strong>, and copy the token (starts <code>xapp-</code>) into box 2.",
        "Click <strong>Save Slack</strong>. The status should turn to <em>Connected as @tarsee in <em>your workspace</em></em>.",
        "In Slack, open <strong>Tarsee</strong> under Apps and send it a DM. In a channel, add it (channel name → <strong>Add people or agents</strong>, or type <code>/invite @Tarsee</code>) and @mention it.",
      ],
      tips: [
        "Every reply goes in a thread, and each thread is its own conversation. Once Tarsee is in a thread it answers there without a mention.",
        "<code>/tarsee</code> works anywhere: <code>/tarsee help</code>, <code>/tarsee /model opus</code>, or <code>/tarsee</code> and a question. Slack's <strong>Stop</strong> button stops a reply.",
        "Tarsee connects out to Slack, so there's no URL to set up and it works on a laptop too. Don't run two Tarsees with the same tokens: Slack would split the messages between them.",
        "Your workspace may need an admin to approve new apps before <strong>Allow</strong> appears.",
      ],
    },
    {
      id: "whatsapp",
      name: "WhatsApp",
      section: "whatsappChannelSection",
      needs: "A WHAPI.Cloud account linked to a WhatsApp number, and a Tarsee reachable from the internet. About 10 minutes.",
      steps: [
        `Sign up at ${link("https://panel.whapi.cloud/register", "panel.whapi.cloud")}. A free trial channel is made for you: open it.`,
        "Link a WhatsApp number to it: the channel shows a QR code. On that phone open WhatsApp → <strong>Linked devices</strong> (iPhone: Settings; Android: the ⋮ menu) → <strong>Link a device</strong>, and scan it. This number becomes Tarsee's.",
        "Once the channel says it's connected, copy its <strong>API token</strong> into <strong>WHAPI token</strong> below and click <strong>Save WhatsApp</strong>. The webhook URL appears.",
        "Click <strong>Copy</strong> next to the webhook URL. In WHAPI, open the channel's <strong>Settings</strong> (top right). In the webhooks block paste it as the URL, set <strong>Mode</strong> to <strong>Body</strong>, turn on the <strong>messages</strong> event with <strong>POST</strong>, and save. <strong>Check webhook</strong> tests it.",
        "From your own phone, send a WhatsApp message to the linked number.",
      ],
      tips: [
        "WHAPI has to reach Tarsee, so the webhook URL must be a public address (your Railway URL works; <code>localhost</code> does not).",
        "Leave <strong>Mode</strong> on <strong>Body</strong>: the other modes change the URL, and Tarsee no longer recognises it.",
        "The free sandbox answers up to 5 different people a month and 150 messages a day.",
        "Direct messages only: group messages are ignored. Messages sent from the linked phone itself are ignored too, so write from another number.",
        "Open WhatsApp on the linked phone at least once every 14 days, or WhatsApp unlinks it.",
        "If you click <strong>Regenerate</strong>, paste the new URL into WHAPI again.",
      ],
    },
    {
      id: "email",
      name: "Email",
      section: "emailChannelSection",
      needs: "A mailbox for Tarsee and an app password for it (Gmail, iCloud, Yahoo, FastMail, Zoho or your own server). About 5 minutes.",
      steps: [
        "Pick the mailbox Tarsee will use. A separate one (like <em>tarsee@yourdomain</em>) is safest, since Tarsee reads it.",
        "Turn on two-step sign-in for that account and make an <strong>app password</strong>. Click your provider below to see where.",
        "Click your provider's button to fill in the server addresses. Enter the mailbox address in both <strong>User</strong> boxes and the app password in both <strong>App password</strong> boxes.",
        "Put your own address in <strong>Sender allowlist</strong>, so only you can make it answer.",
        "Tick <strong>Enable email channel</strong> and click <strong>Save Email</strong>. The status should turn to <em>Connected as tarsee@…</em>.",
        "Email the mailbox with <code>@tarsee</code> (your mention keyword) in the message. Mail without it is read and remembered, but not answered.",
      ],
      tips: [
        "Use the app password, not the account's normal password: most providers refuse the normal one.",
        "Outlook.com, Hotmail and Microsoft 365 mailboxes can't connect: Microsoft no longer accepts app passwords from other mail apps. Use a mailbox from another provider.",
        "Put <code>[reply-all]</code> in the subject to have Tarsee answer everyone on the email.",
        "Newsletters and auto-replies are never answered.",
      ],
    },
  ];

  /** Where each provider makes an app password, shown when its preset is clicked. */
  const EMAIL_PROVIDERS = {
    gmail: `Gmail: turn on 2-Step Verification (Google Account → Security), then make an app password at ${link("https://myaccount.google.com/apppasswords", "myaccount.google.com/apppasswords")}: type a name like <em>Tarsee</em>, click Create, and paste the 16 letters. IMAP is always on. Work and school accounts, and accounts with Advanced Protection, can't make app passwords.`,
    icloud: `iCloud: with two-factor authentication on, go to ${link("https://account.apple.com", "account.apple.com")} → <strong>Sign-In and Security</strong> → <strong>App-Specific Passwords</strong> → generate one. For the IMAP user Apple wants the part before @icloud.com (if that's refused, the full address); the SMTP user is the full address.`,
    zoho: `Zoho: in Zoho Mail, Settings → <strong>Mail Accounts</strong> → your address → tick <strong>IMAP Access</strong>. With two-factor sign-in on, make an app password at ${link("https://accounts.zoho.com", "accounts.zoho.com")} → Security → <strong>App Passwords</strong>. New free accounts don't get IMAP. A paid plan on your own domain uses imappro.zoho.com and smtppro.zoho.com; outside the US the servers are in your account's <em>Server Configurations</em>.`,
    fastmail: "FastMail: Settings → <strong>Privacy &amp; Security</strong> → <strong>Manage app passwords and access</strong> → <strong>New app password</strong>, access <em>Mail, Contacts &amp; Calendars</em>, then Generate. The Basic plan has no IMAP.",
    yahoo: `Yahoo: at ${link("https://login.yahoo.com/account/security", "login.yahoo.com/account/security")}, under External connections, <strong>Create app password</strong> → name it → <strong>Generate password</strong>. Do it in a browser you normally use for Yahoo: it can refuse otherwise.`,
    custom: "Your own server: ask your host for the IMAP and SMTP addresses and ports (usually 993, and 465 or 587).",
  };

  const byId = new Map(PLATFORMS.map((p) => [p.id, p]));
  const get = (id) => byId.get(id) || null;

  /** The steps and tips as a <details> (open: shown unfolded, for a platform not set up yet). */
  function guideHtml(id, { open = false } = {}) {
    const p = get(id);
    if (!p) return "";
    const steps = p.steps.map((s) => `<li>${s}</li>`).join("");
    const tips = p.tips.length
      ? `<div class="channel-guide-tips"><strong>If it doesn't answer</strong><ul>${p.tips.map((t) => `<li>${t}</li>`).join("")}</ul></div>`
      : "";
    return `<details class="channel-guide" data-guide="${p.id}"${open ? " open" : ""}>` +
      `<summary>How to connect ${p.name}</summary>` +
      `<ol class="channel-guide-steps">${steps}</ol>${tips}</details>`;
  }

  /**
   * A channel's status as words and a tone ("ok", "bad", "wait", "off").
   * s: GET /api/status → channels.<id> ({ status, error?, identity?, warning? }). enabled: its Enable box; configured:
   * whether a token (or mail server) is saved for it. With both known, a saved channel switched off says "Off".
   */
  function statusLine(s, { enabled, configured } = {}) {
    const status = s?.status || "not_configured";
    if (status === "running" && s.warning) return { text: s.warning, tone: "wait" };
    if (status === "running") return { text: s.identity ? `Connected as ${s.identity}` : "Connected", tone: "ok" };
    if (status === "starting") return { text: "Connecting…", tone: "wait" };
    if (status === "error") return { text: s.error || "Could not connect", tone: "bad" };
    if (configured && enabled === false) return { text: "Off", tone: "off" };
    if (status === "stopped") return { text: "Saved, not connected yet", tone: "wait" };
    return { text: "Not set up", tone: "off" };
  }

  globalThis.ChannelGuides = Object.freeze({ PLATFORMS, EMAIL_PROVIDERS, get, guideHtml, statusLine });
})();
