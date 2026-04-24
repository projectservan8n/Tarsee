# Tools & Capabilities

<!-- Notes about locally available tools, APIs, and setup. -->
<!-- Tarsee updates this as it discovers what's installed. -->

- whisper.cpp: Local speech-to-text (auto-downloads on first use)
- Edge TTS: Free text-to-speech from Microsoft
- Web terminal: Browser-based shell access
- File manager: Browse and edit workspace files
- Email channel (optional): Real-time chat over IMAP IDLE + SMTP. Replies only when the mention keyword (default `@tarsee`, configurable in Settings > Channels > Email) appears in the email body. CC/BCC/forwards are absorbed as context so I remember the thread but don't reply. Use `tarsee_send_email_thread` to send or reply to a thread proactively; use `tarsee_configure_email_channel` to set up credentials from chat.
