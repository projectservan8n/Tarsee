# Live testing with real keys

`scripts/e2e/live-smoke.mjs` checks every AI you have connected, for real, on a Tarsee that is running. For each one it does what you would do by hand: presses **Test** on the AI's card in Settings > AI, opens a new chat set to that AI, asks a question that needs Tarsee's calculator tool, waits for the answer, checks that the tool really ran, reads what the reply cost on the Usage page, and deletes the test chat. At the end it prints one table with a row per chat.

It only talks to Tarsee over the web address, like your browser does. It never reads Tarsee's files or database, and it never prints a key, a token, a cookie or your password. A short password, such as a 4-digit PIN, is never blanked out of the dates and numbers it prints either: the script never prints the password in the first place, and a gap where those digits were would give them away.

## 1. Start a local Tarsee for the test

Use a separate test Tarsee on your own computer, so nothing on Railway is touched. Open PowerShell in the Tarsee folder and run:

```powershell
$env:TARSEE_STATE_DIR = "$env:USERPROFILE\.tarsee-live-test"
$env:SETUP_PASSWORD = [System.Net.NetworkCredential]::new("", (Read-Host -AsSecureString "Choose a password for the test Tarsee")).Password
$env:ENCRYPTION_KEY = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
npm start
```

- `TARSEE_STATE_DIR` keeps everything for this test (its database, the saved keys, the ChatGPT sign-in) in its own folder, away from any other Tarsee.
- The password and the encryption key live only in this PowerShell window. Nothing is written to a file, and the password isn't saved in PowerShell's history.
- Leave this window open: it is the running Tarsee. When it says it is listening on port 3000, go on.

## 2. Connect the AIs

1. Open <http://localhost:3000> and sign in with the password you just chose.
2. Open **Settings > AI**. For each AI you want to test, paste its key into its card and click **Save key**:
   - **Anthropic API key**, **OpenAI API key**, **OpenRouter** and **DeepSeek**: one key each. Give each key a spending limit at the provider (see [docs/providers.md](providers.md)); the test itself costs a few cents at most.
   - **Local AI**: type your server's address (for example `http://localhost:11434/v1`) and choose a model on its card.
3. **ChatGPT plan**: on its card click **Sign in with ChatGPT**. Open the link it shows, sign in with your ChatGPT account and type the one-time code. (Device sign-in has to be switched on in ChatGPT > Settings > Security first.) The card turns to *Ready*.
4. The **Claude plan** is tested too if its card says *Ready*. It costs nothing per message.

Every card that says *Ready* is tested. You don't have to connect all of them.

## 3. Run the test

Open a **second** PowerShell window in the Tarsee folder (the first one is busy running Tarsee) and run:

```powershell
$env:TARSEE_URL = "http://localhost:3000"
$env:TARSEE_PASSWORD = [System.Net.NetworkCredential]::new("", (Read-Host -AsSecureString "Tarsee password")).Password
node scripts/e2e/live-smoke.mjs
```

In Git Bash or WSL the same is:

```bash
export TARSEE_URL=http://localhost:3000
read -rsp "Tarsee password: " TARSEE_PASSWORD; echo; export TARSEE_PASSWORD
node scripts/e2e/live-smoke.mjs
```

The address and password are read only from these two variables. They are never typed on the command line and never shown. A full run takes a few minutes.

Options, all optional:

| Option | What it does |
|---|---|
| `--only deepseek,openrouter` | Test only these AIs. The names are `claude`, `anthropic`, `chatgpt`, `openai`, `openrouter`, `deepseek`, `local`. |
| `--model openrouter=openai/gpt-5.5` | Chat with this model on that AI instead of the one chosen on its card. Repeat it, or separate several with commas. |
| `--verify` | Before chatting, run **Verify** on the OpenRouter and Local AI models it is about to use (four short test turns each, on your key). Tarsee allows six Verify runs per AI an hour. |
| `--verify openrouter=google/gemini-2.5-flash` | Verify that model, then add a chat on it. Use this to try an OpenRouter model by another maker, or another Local AI model. |
| `--keep` | Keep the test chats instead of deleting them, so you can open them in Tarsee. |
| `--timeout 600` | Wait up to this many seconds for one reply (the default is 300). |

OpenRouter gets two chats: one on its card's model (a Claude model, run by Claude Code) and one on an OpenAI model from OpenRouter's list (run by Codex), so both ways Tarsee runs OpenRouter are tested. `--model openrouter=...` replaces both with the model you name.

The ChatGPT chat names no model, so your account's default model answers, as it would in a new chat. Before it, the test lists the models your account can use, the same list the chat's model picker shows.

## 4. Reading the results

While it runs, it prints one line per step:

```
[  3.2s] PASS deepseek · test: Key works · Balance $4.20
[ 14.8s] PASS deepseek · deepseek-flash · tool: mcp__tarsee__tarsee_calculator worked out 48271 * 3917 = 189077507
[ 15.0s] PASS deepseek · deepseek-flash · turn: DeepSeek Flash · deepseek-flash answered "189077507" in 11.2 s
[ 17.5s] PASS deepseek · deepseek-flash · usage: DeepSeek · DeepSeek Flash (deepseek-flash) · claude-code · 18,342 tokens · $0.0028 est.
[ 17.6s] PASS deepseek · deepseek-flash · cleanup: the test chat is deleted
```

- **PASS**: that step worked.
- **FAIL**: it didn't. The words after it say why, as Tarsee said it.
- **WARN**: worth knowing, but not a failure (for example, your ChatGPT account's model list couldn't be read, so Codex used the account's default).
- **INFO**: what it is doing.

At the end comes the table:

```
provider                              | test | turn | tool              | cost             | notes
------------------------------------- | ---- | ---- | ----------------- | ---------------- | -----
deepseek · deepseek-flash             | ok   | ok   | tarsee_calculator | $0.0028 est.     | 18,342 tokens (in 18,100, out 242); claude-code; Balance $4.20
chatgpt · (your account's default)    | ok   | ok   | tarsee_calculator | Included in plan | 9,876 tokens (in 9,800, out 76); codex
```

(The numbers here are only an example.)

| Column | What it means |
|---|---|
| **provider** | The AI, then the model that actually answered (from the Usage page). |
| **test** | The **Test** button on the AI's card: `ok`, or `FAIL` (a rejected key, an empty balance, a sign-in that has run out, an address that can't be reached). |
| **turn** | The chat: `ok` when a reply came back with no error and with the right answer in it. `FAIL` says what went wrong in the notes. `skipped` means Tarsee wouldn't start the chat (the AI isn't ready, or the model must be verified first). |
| **tool** | `tarsee_calculator` when Tarsee's calculator tool really ran and gave the right number. `none` means the AI answered without using it; `wrong answer` means it ran but the number didn't match. |
| **cost** | What this one reply cost, in the Usage page's words: an amount the provider reported (`$0.0021`), an estimate from the price list (`$0.0028 est.`), `Included in plan` for the Claude and ChatGPT plans, `Free` for Local AI. `FAIL` means the Usage page had no row for the chat, or the row looked wrong (for example a plan reply with a price). |
| **notes** | The tokens the reply used, which engine ran it (`claude-code` or `codex`), the balance or spending limit the card reports, and the reason for anything that failed. |

When the last line says *Every step passed*, everything worked. If anything failed, the script ends with exit code 1, so it can also be used in a script of your own.

What the test costs: one short chat per row, usually well under a cent each with a key. `--verify` adds about four to eight short turns per model it checks; the cost is shown before it starts. The plans cost nothing per message.

If a reply doesn't finish (it runs out of time, or the connection breaks), the test stops that chat's turn first, as the chat's **Stop** button would, and waits for it to end before deleting the chat. Tarsee keeps a reply going when the page that asked for it goes away, so without this the turn would keep running on your key in a chat you can no longer see. It says so in a line of its own:

```
[ 41.2s] FAIL deepseek · deepseek-flash · turn: the reply broke off: aborted (38.4 s)
[ 43.5s] INFO deepseek · deepseek-flash · cleanup: the reply didn't finish, so its turn was stopped first; it was over in 2.3 s
[ 43.6s] PASS deepseek · deepseek-flash · cleanup: the test chat is deleted
```

## 5. Afterwards

- The test chats are already deleted (unless you used `--keep`). Their cost stays on the test Tarsee's Usage page.
- To remove the keys: in Settings > AI, click **Remove key** on each card, and **Sign out** on the ChatGPT plan card. Or stop Tarsee (Ctrl+C in its window) and delete the whole test folder, which removes every key and sign-in it held:

  ```powershell
  Remove-Item -Recurse -Force "$env:USERPROFILE\.tarsee-live-test"
  ```

- Close both PowerShell windows. The password, the encryption key and the address go with them.
- If you'd like the keys to stay usable for good, revoke or rotate them at the provider later; nothing here ever copied them anywhere else.

## Testing a Tarsee on Railway

The same script works against your Railway Tarsee: set `TARSEE_URL` to its address (`https://...`) and `TARSEE_PASSWORD` to its `SETUP_PASSWORD`. It then uses the keys and sign-ins saved there, creates and deletes its test chats there, and its cost counts toward that Tarsee's month. Try the local test first.

## If something fails

| What it says | What to do |
|---|---|
| `TARSEE_PASSWORD was turned down` | The password isn't this Tarsee's `SETUP_PASSWORD`. Set the variable again. |
| `Tarsee didn't answer at ...` | Tarsee isn't running at that address, or it is still starting. Check the first window. |
| `no AI is ready` | No card says *Ready*. Connect one in Settings > AI, or name one with `--only` to see why it isn't. |
| `test: ... key was rejected` | The key is wrong or was revoked. Paste it again in Settings > AI. |
| `test: Key works, but the balance is empty` | Top up at the provider, or raise the key's spending limit. |
| `turn: ... hasn't been verified yet` | That model needs **Verify** first: add `--verify`. |
| `tool: the AI didn't use Tarsee's calculator` | The model answered from memory. Small Local AI models often do this; a larger model usually won't. |
| `usage: no usage row` | The reply finished but the Usage page didn't record it within a minute. Run again; if it keeps happening, it is worth reporting. |
| `turn: the reply broke off` or `no full reply in 300 s` | The connection to Tarsee broke, or the AI took too long (try `--timeout 600`). The test stopped that turn before deleting its chat. |
| `cleanup: the unfinished turn couldn't be stopped` | That turn may still be running on your key. The test chat is kept: open **Live test (live-smoke)** in Tarsee and press **Stop**, then delete the chat. |
| `Tarsee allows only a few of these a minute; waiting` | Not a failure: Tarsee limits how often **Test**, **Verify** and sign-in can run, and the script waits its turn. |

## For developers

`node scripts/e2e/live-smoke-fakes.mjs` proves this script without any real key: it starts a real Tarsee whose AIs are local fakes (the same ones `scripts/e2e/ai-api-e2e.mjs` uses), connects them as above, and runs `live-smoke.mjs` in every case it has to handle: all AIs passing, Verify, a key turned down at Test or mid-chat, an AI that isn't ready, a wrong password, a stray argument, a model that goes quiet while a proxy cuts the chat's connection (the turn must be stopped, and over, before its chat is deleted), and a 4-digit password (this year, with every chat's sum made to carry it: every date and number must print whole). It also checks that nothing the script printed carries a key, a token, a cookie or the password.
