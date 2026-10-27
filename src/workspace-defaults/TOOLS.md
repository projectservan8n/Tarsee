# Tools & Capabilities

<!-- Notes about locally available tools, APIs, and setup. -->
<!-- Tarsee updates this as it discovers what's installed. -->

- whisper.cpp: Local speech-to-text (auto-downloads on first use)
- Edge TTS: Free text-to-speech from Microsoft
- Web terminal: Browser-based shell access
- File manager: Browse and edit workspace files
- Email channel (optional): Real-time chat over IMAP IDLE + SMTP. Replies only when the mention keyword (default `@tarsee`, configurable in Settings > Channels > Email) appears in the email body. CC/BCC/forwards are absorbed as context so I remember the thread but don't reply. Use `tarsee_send_email_thread` to send or reply to a thread proactively; use `tarsee_configure_email_channel` to set up credentials from chat.

## Discord admin (channels, webhooks)
- Make, edit or list Discord channels and webhooks with tarsee_discord_admin. Never call Discord's API from Bash and never pull DISCORD_BOT_TOKEN from the vault for it: Tarsee's own bot does the work.
- Get the go first and pass who said it, in their words, as approved_by. A new webhook is a credential, so it needs the owner's go.
- create_webhook saves the URL in the vault (save_as_key) and shows only a masked URL. Never paste the full URL into a chat, a commit or a command.
- Nothing in the tool deletes. Deleting a channel or a webhook is for the owner to do by hand in Discord.

## Railway (projects, variables, redeploys)
- List projects, services and variable names, set a variable or redeploy with tarsee_railway. Never call Railway's API from Bash and never put a Railway token or a secret value in a command: Tarsee reads the token from the vault itself (RAILWAY_API_TOKEN, an account or workspace token).
- For anything secret, pass set_variable from_key (the vault key name), never value. The value is never shown, only a masked form.
- Get the go first and pass who said it, in their words, as approved_by. Putting a secret into a service is handing out a credential, so it needs the owner's go.
- On Railway, leaving out project means Tarsee's own project and service. Redeploying Tarsee's own service restarts it and ends the turn. Nothing in the tool deletes: deleting a variable or a service is for the owner to do by hand in Railway.
