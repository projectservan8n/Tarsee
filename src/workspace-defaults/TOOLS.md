# Tools & Capabilities

<!-- Notes about locally available tools, APIs, and setup. -->
<!-- Tarsee updates this as it discovers what's installed. -->

- whisper.cpp: Local speech-to-text (auto-downloads on first use)
- Edge TTS: Free text-to-speech from Microsoft
- Web terminal: Browser-based shell access
- File manager: Browse and edit workspace files
- Email channel (optional): Real-time chat over IMAP IDLE + SMTP. Replies only when the mention keyword (default `@tarsee`, configurable in Settings > Channels > Email) appears in the email body. CC/BCC/forwards are absorbed as context so I remember the thread but don't reply. Use `tarsee_send_email_thread` to send or reply to a thread proactively; use `tarsee_configure_email_channel` to set up credentials from chat.

## Discord admin (channels, webhooks)
- Make, edit or list Discord channels and webhooks with tarsee_discord_admin. Never call Discord's API from the shell and never pull DISCORD_BOT_TOKEN from the vault for it: Tarsee's own bot does the work.
- Get the go first and pass who said it, in their words, as approved_by. A new webhook is a credential, so it needs the owner's go.
- create_webhook saves the URL in the vault (save_as_key) and shows only a masked URL. Never paste the full URL into a chat, a commit or a command.
- Nothing in the tool deletes. Deleting a channel or a webhook is for the owner to do by hand in Discord.

## Railway (projects, variables, redeploys)
- List projects, services and variable names, set a variable or redeploy with tarsee_railway. Never call Railway's API from the shell and never put a Railway token or a secret value in a command: Tarsee reads the token from the vault itself (RAILWAY_API_TOKEN, an account or workspace token).
- For anything secret, pass set_variable from_key (the vault key name), never value. The value is never shown, only a masked form.
- Get the go first and pass who said it, in their words, as approved_by. Putting a secret into a service is handing out a credential, so it needs the owner's go.
- On Railway, leaving out project means Tarsee's own project and service. Redeploying Tarsee's own service restarts it and ends the turn.
- On Tarsee's own service it sets only a key or address for the owner's own scripts (a name in capitals ending in _KEY, _TOKEN, _SECRET, _PASSWORD, _WEBHOOK or _URL that Tarsee doesn't read itself and that appears nowhere in its AI engines' code, the Terminal's own claude program included: Tarsee reads the one running now when it starts), TZ and a few tuning settings. It sets only TZ and the tuning settings there while that program can't be read, and while TARSEE_AUTO_UPDATE_CLI is among its variables (TARSEE_AUTO_UPDATE_CLI=1 installs the newest claude at each start). The owner sets anything else there by hand in Railway's dashboard: sign-in, the AI and its keys, how Tarsee is built, starts or runs.
- A variable one of Tarsee's own variables is filled in from by a Railway reference counts as that variable, under the same rules; names that differ only in case are different variables. It also refuses, saying why: anything in a Tarsee's environment while a refused variable is sealed or filled in from a service the project doesn't have, and a vault key onto Tarsee's own service, or into a variable it is filled in from, while get_key is denied in Tool Permissions. Tell the person what the refusal says; never look for a way around it.
- Any Tarsee service gets the same limits: Tarsee's own in any environment, and any service whose variable names (in any environment of its project, or the name being set) include SETUP_PASSWORD, ENCRYPTION_KEY or a TARSEE_ name, or that Railway says is deployed from a repo or image named like Tarsee's. On each of them but Tarsee's own service in the environment it runs in, it sets only TZ and the tuning settings, since Tarsee can't read the programs that one runs. If Railway doesn't give a project's variable names, nothing is set there.
- Nothing in the tool deletes: deleting a variable or a service is for the owner to do by hand in Railway.
