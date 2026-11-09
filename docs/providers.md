# Choose your AI

Tarsee can run on seven kinds of AI account. You can connect several, pick one as the default, and let any chat use a different one. This guide has the same steps Tarsee shows in the setup wizard and in **Settings > AI**, plus what happens behind them.

You never choose an "engine". Tarsee runs Claude Code for some AIs and OpenAI's Codex for others, and picks the right one by itself. The only difference you may notice is that replies from Codex-run AIs arrive a message at a time instead of word by word.

## At a glance

| AI | What you need | What it costs | Runs on (Tarsee picks) | Replies | Good to know |
|---|---|---|---|---|---|
| **Claude plan** | A paid Claude plan (Pro, Max or a Team seat), signed in once from Tarsee's Terminal | No cost per message: it uses your plan's limits | Claude Code | Word by word | Pro runs out quickly with an agent; Max lasts much longer. For your own use |
| **ChatGPT plan** | A ChatGPT account (any plan, Free included) and a one-time code | No cost per message: it uses your plan's Codex limits. Free plans get a smaller model with limited use | Codex | A message at a time | The model list shows only what your account can use. For your own use |
| **Anthropic API key** | An API key from the Claude Console, with prepaid credit | Pay per use, billed by Anthropic | Claude Code | Word by word | Set a spend limit in the Console |
| **OpenAI API key** | An API key from the OpenAI Platform, in a project with a budget | Pay per use, billed by OpenAI | Codex | A message at a time | Give the project a hard spending limit |
| **OpenRouter** | One OpenRouter key, with a few dollars of credit | Pay per use at each model's price; models marked Free cost nothing | Claude Code for Claude models, Codex for OpenAI models, whichever passes **Verify** for the rest | Depends on the model | Hundreds of models with one key. Give the key a credit limit |
| **DeepSeek** | A DeepSeek API key and a small top-up | Pay per use from your prepaid balance: the cheapest of these | Claude Code, through DeepSeek's own Claude-compatible address | Word by word | DeepSeek Pro can't see pictures; PDFs are read as text |
| **Local AI** | A machine you run with Ollama or LM Studio, that Tarsee can reach | Free: it runs on your own hardware | Codex | A message at a time | The model you pick on its card works at once; verify any other before a chat can switch to it. Small models use tools poorly |

Every AI gets the same things: all of Tarsee's tools, every channel (web, Telegram, Discord, WhatsApp, Slack, email, voice), scheduled jobs, the live view, Stop and the queue, memory, and the Usage page.

## Plan or API key?

Signing in with a Claude or ChatGPT plan is for your own personal use, under [Anthropic's](https://www.anthropic.com/legal/consumer-terms) and [OpenAI's](https://openai.com/policies/terms-of-use) terms. If other people talk to this Tarsee (a team, customers, a shared channel), use an API key, and switch on **Only use API keys** so Tarsee never uses a plan sign-in (see [Only use API keys](#only-use-api-keys)).

## Where keys go

- **Settings > AI.** Paste a key into its card and click **Save key**. It is stored encrypted in Tarsee's database, and only its last 4 characters are ever shown again.
- **Or a Railway variable.** Your service > Variables, with the name each guide below gives (for example `DEEPSEEK_API_KEY`). When both have a key, the one saved in Settings is used.
- **Never in a file.** Not in the repository, not in `.env.example`, `docker-compose.yml` or `railway.toml` (they hold names only), and not in a chat message to the agent.
- **Set `ENCRYPTION_KEY` first.** It encrypts what Tarsee stores. Make one with `openssl rand -hex 32`, set it as a Railway variable before you save any key in Settings, and keep the same one for good. Without it, Tarsee makes one and keeps it on the volume, next to the data it protects.

What Tarsee guarantees about keys:

- Each key is only ever sent to its own provider's address. The only address you can type in is Local AI's, and it only ever receives Local AI's own key.
- A key set as a variable never changes which AI answers or how you are billed by itself: only your choice in Settings > AI (or `TARSEE_AI_PROVIDER`) does. For example, `ANTHROPIC_API_KEY` is ignored while the Claude plan is the default.
- Each AI's sign-in and key lives in its own folder and reaches only its own turns, so the Claude plan's sign-in can never be used for another AI, and the other way round.

## The seven AIs

### Claude plan

**What it costs:** no cost per message: it uses your Claude plan's usage limits.

**You need:** your paid Claude plan (Pro, Max or a Team seat) and one sign-in from Tarsee's Terminal. About 2 minutes.

1. Open **Tarsee's Terminal** (the `>_` button at the top of the dashboard, or **Open the Terminal** on the Claude plan card). It runs on the server where Tarsee lives, not on your own computer.
2. Click inside it, type `claude auth login` and press Enter.
3. A link appears. Open it in your browser, sign in with your Claude account and approve. If the page shows a code instead, copy it and paste it back into the Terminal. (To copy from the Terminal, select the text and right-click → Copy: Ctrl+C doesn't copy there.)
4. When the Terminal says *Login successful*, come back to Settings > AI and click **Check**. The status turns to *Ready*.

**If it doesn't work:**

- No Terminal, or it won't open? On any computer with Claude Code, run `claude setup-token`, sign in, and put the token it prints in the Railway variable `CLAUDE_CODE_OAUTH_TOKEN`. It lasts a year.
- If the Terminal doesn't know `auth`, type `claude`, press Enter, then type `/login`.
- If Tarsee says the sign-in expired, run `claude auth login` again.
- Pro works, but an agent uses its limits quickly; Max lasts much longer. Your usage is at [claude.ai/settings/usage](https://claude.ai/settings/usage).
- A plan is for your own use. If other people talk to this Tarsee, use an Anthropic API key instead.

The sign-in is kept on the volume, so it survives restarts and redeploys. Tarsee never reads or refreshes the Claude sign-in itself; Claude Code does.

### ChatGPT plan

**What it costs:** no cost per message: it uses your ChatGPT plan's Codex limits. Free plans get a smaller model with limited use.

**You need:** your ChatGPT account (any plan, Free included) and a one-time code. About 3 minutes.

1. In ChatGPT, open [Settings → Security](https://chatgpt.com/#settings/Security) and, under **App security**, turn on **Enable device code sign-in for Codex** (the switch also names Excel, PowerPoint and Word). (In a work or school workspace, an admin turns it on in the workspace's permissions.)
2. In Tarsee, on the ChatGPT plan card in Settings > AI (or in the setup wizard), click **Sign in with ChatGPT**. Tarsee shows a link and a one-time code.
3. Open the link, sign in to ChatGPT and type the code. It works for 15 minutes.
4. Keep Tarsee's page open: it notices by itself when you're signed in, and the status turns to *Ready*.
5. Pick a model (the list shows only the ones your account can use) and click **Use this AI**.

**If it doesn't work:**

- If ChatGPT says device code sign-in isn't allowed, check the **Enable device code sign-in for Codex** switch from step 1: it has to be on before you click Sign in.
- Free plans run a smaller model with limited use; when you reach the limit, Tarsee says when it resets. Paid plans last much longer ([chatgpt.com/pricing](https://chatgpt.com/pricing)).
- You can also sign in from Tarsee's Terminal: run `codex login --device-auth` and follow the same steps. It is the same sign-in, kept in the same place.
- Replies from ChatGPT appear a message at a time, not word by word.
- A plan is for your own use. If other people talk to this Tarsee, use an OpenAI API key instead.

This is Codex's own sign-in. It is kept on the volume (only Tarsee's server can read it), and **Sign out** on the card removes it. Tarsee never names a ChatGPT model itself: it asks your account which models it can use, and when that list can't be read it lets Codex choose your account's default.

### Anthropic API key

**What it costs:** pay per use, billed by Anthropic. Set a spending limit so a busy day can't surprise you.

**You need:** an API key from the Claude Console, with some prepaid credit. About 5 minutes. Key page: [platform.claude.com/settings/keys](https://platform.claude.com/settings/keys). Railway variable: `ANTHROPIC_API_KEY`.

1. Sign in to the [Claude Console](https://platform.claude.com/). It's separate from a Claude plan, and billed separately.
2. Add credit on the [Billing](https://platform.claude.com/settings/billing) page. On the same page, under **Spend limits**, click **Set limit** (or **Adjust limit**) and choose a small monthly amount.
3. Open [API keys](https://platform.claude.com/settings/keys), create a key named *Tarsee*, and copy it. It starts with `sk-ant-api`, and the Console shows it only once.
4. Paste it in the key box on the Anthropic API key card and click **Save key**, then **Test**.
5. Pick a model and click **Use this AI**.

**If it doesn't work:**

- A key that starts with `sk-ant-oat` is a Claude plan sign-in token, not an API key. It belongs in the Railway variable `CLAUDE_CODE_OAUTH_TOKEN` (the Claude plan card). Tarsee refuses it in the key box.
- If Test says the credit has run out, add some on the Billing page. If it says you've reached your limit, raise it there.
- Instead of saving the key in Settings, you can set it as the Railway variable `ANTHROPIC_API_KEY`.

It runs the same Claude models as the Claude plan, with the cost of each reply shown on the Usage page. If the Claude plan is the default and `ANTHROPIC_API_KEY` is set, Settings > AI offers to switch to this key: the plan never uses it by itself.

### OpenAI API key

**What it costs:** pay per use, billed by OpenAI. Give the project a monthly budget with a hard limit.

**You need:** an API key from the OpenAI Platform, in a project with a budget, and some prepaid credit. About 5 minutes. Key page: [platform.openai.com/api-keys](https://platform.openai.com/api-keys). Railway variable: `OPENAI_API_KEY`.

1. Sign in to the [OpenAI Platform](https://platform.openai.com/) and add credit under [Billing](https://platform.openai.com/settings/organization/billing/overview).
2. Open your [project's settings](https://platform.openai.com/settings/) → **Limits**. Under **Spend**, click **Edit spend limit**, enter a small monthly amount, turn on **Enforce a hard limit** and click **Save**.
3. Open [API keys](https://platform.openai.com/api-keys), click **Create new secret key**, choose that project, and copy the key. It starts with `sk-proj-`, and it's shown only once.
4. Paste it in the key box on the OpenAI API key card and click **Save key**, then **Test**.
5. Pick a model and click **Use this AI**.

**If it doesn't work:**

- If Test says the project is over its budget, raise the spend limit from step 2, or add credit.
- The same key also does voice transcription, but only if you choose Whisper API in Settings → Voice.
- Replies appear a message at a time, not word by word.
- Instead of saving the key in Settings, you can set it as the Railway variable `OPENAI_API_KEY`.

The picker lists the models your key can use. Costs are worked out from OpenAI's prices and marked "est." on the Usage page.

### OpenRouter

**What it costs:** pay per use at each model's price; models marked Free cost nothing. A credit limit on the key caps what it can spend.

**You need:** one OpenRouter key for hundreds of models, with a few dollars of credit. About 5 minutes. Key page: [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys). Railway variable: `OPENROUTER_API_KEY`.

1. Sign in at [openrouter.ai](https://openrouter.ai/) and add a few dollars on the [Credits](https://openrouter.ai/settings/credits) page.
2. Open [Keys](https://openrouter.ai/settings/keys) and create a key named *Tarsee*. Give it a **credit limit** (say $5), so this key can never spend more than that.
3. Copy the key (it starts with `sk-or-v1-`, and it's shown only once). Paste it in the key box on the OpenRouter card, click **Save key**, then **Test**. Test shows how much of the limit is left.
4. Pick a model and click **Use this AI**. Claude and OpenAI models work straight away. Any other model: find it in the list and click **Verify** first, a short check that costs a few cents.

**If it doesn't work:**

- Free models allow about 50 requests a day, or 1,000 a day once you've bought at least $10 of credit.
- If Test says the limit is used up, raise the key's limit on the [Keys](https://openrouter.ai/settings/keys) page.
- For DeepSeek's models, connecting DeepSeek directly is cheaper and steadier than going through OpenRouter.
- Instead of saving the key in Settings, you can set it as the Railway variable `OPENROUTER_API_KEY`.

In the model menu under the message box, OpenRouter's models come in three lists: **Recommended**, **Verified by you**, and **All models** (Free ones are marked). On the card in Settings > AI you can search every model: **Verified by you**, **Ready to use**, and **Verify to use**. The cost of each reply comes from OpenRouter when it reports one, otherwise from the model's listed price, marked "est.". Settings > AI shows how much of the key's limit is left.

### DeepSeek

**What it costs:** pay per use from your prepaid balance, the cheapest of these. Tarsee shows the balance left.

**You need:** a DeepSeek API key and a small top-up (a couple of dollars goes a long way). About 5 minutes. Key page: [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys). Railway variable: `DEEPSEEK_API_KEY`.

1. Sign up or sign in at [platform.deepseek.com](https://platform.deepseek.com/).
2. Add a small amount on the [Top up](https://platform.deepseek.com/top_up) page. DeepSeek only spends what you've topped up, so that is your limit.
3. Open [API keys](https://platform.deepseek.com/api_keys), create a key named *Tarsee* and copy it (it's shown only once).
4. Paste it in the key box on the DeepSeek card, click **Save key**, then **Test**. Test shows your balance.
5. Pick a model (DeepSeek Flash for everyday use; DeepSeek Pro thinks harder but can't see pictures) and click **Use this AI**.

**If it doesn't work:**

- If Test says the balance is empty, top up again.
- DeepSeek can't open PDFs itself: Tarsee takes the text out of them first.
- Instead of saving the key in Settings, you can set it as the Railway variable `DEEPSEEK_API_KEY`.

DeepSeek runs inside Claude Code through DeepSeek's own Claude-compatible address, which DeepSeek documents; Anthropic doesn't support non-Claude models there, so Tarsee checks it rather than assuming. DeepSeek charges less outside its busy hours, and the Usage page's estimate ("est.") follows that.

### Local AI

**What it costs:** free: it runs on your own hardware. Small models use tools poorly, so pick a capable one.

**You need:** a machine you run with Ollama or LM Studio (or any server that speaks OpenAI's Responses API), that Tarsee can reach. Railway variables: `TARSEE_LOCAL_AI_URL`, and `TARSEE_LOCAL_AI_KEY` only if your server asks for a key.

1. Install [Ollama](https://ollama.com/download) or [LM Studio](https://lmstudio.ai/) on the machine that will run the AI.
2. Download a model. Ollama: in a terminal, run `ollama pull qwen3` (or another model). LM Studio: search for a model in the app and download it.
3. Start its server. Ollama runs one by itself. LM Studio: start the local server in the app's Developer section, or run `lms server start`.
4. Put the server's address in the box on the Local AI card (click **Ollama** for `http://localhost:11434/v1` or **LM Studio** for `http://localhost:1234/v1`), click **Save**, then **Test**. Test lists the models it has.
5. Pick a model and click **Use this AI**: that model is used at once. To use another of your server's models from a chat's model menu, click **Verify** on that model's row in the Local AI card first (it checks that the model can use Tarsee's tools, which is worth doing for small models).

**If it doesn't work:**

- `localhost` means the machine Tarsee itself runs on. If Tarsee is on Railway, run the AI as another Railway service and use its private address (like `http://ollama.railway.internal:11434/v1`), or a public address protected by a key. See [Local AI on Railway](#local-ai-on-railway).
- Ollama only answers the machine it runs on. To reach it from another machine, start it with `OLLAMA_HOST=0.0.0.0`.
- If your server asks for a key, paste it in the key box. Tarsee sends it only to this address.
- Replies appear a message at a time, not word by word.
- Instead of setting it in Settings, you can use the Railway variables `TARSEE_LOCAL_AI_URL` and, if needed, `TARSEE_LOCAL_AI_KEY`.

The card also asks how much the model can read at once, in tokens (128K by default; check your model's page). Local AI is counted as free on the Usage page.

## Keep spending under control

### A spending limit at the provider

This is the surest cap, because the provider itself enforces it, and it still holds if a command the agent runs reads the key (see [Tools on every AI](#tools-on-every-ai)). Each guide above shows where:

| AI | How to cap it |
|---|---|
| Anthropic API key | A monthly spend limit on the Console's Billing page (**Spend limits**) |
| OpenAI API key | A project budget with **Enforce a hard limit** on (project settings → **Limits**) |
| OpenRouter | A credit limit on the key itself, on the Keys page |
| DeepSeek | Only top up a small amount: DeepSeek spends only what you've topped up |

Tarsee shows OpenRouter's remaining limit and DeepSeek's balance on their cards.

### Monthly spending cap

Settings > AI has an optional **Monthly spending cap**, in US dollars. Tarsee adds up what the API-key AIs cost this month (plans aren't counted) and, at the cap, stops using them until next month, with a message that says so. It is off until you set it. It counts Tarsee's own figures, some of them estimates, so a limit at the provider is still the surest cap.

### Background work

Scheduled jobs, the heartbeat and the boot checklist run on the AI's background model (its smaller one, where it has one; you can change it on the card), with a time limit, a turn limit and a spend ceiling per job. A job that hits one is reported as failed.

### What the Usage page shows

Every AI's turns, tokens and cost: the exact cost where the provider reports it (Anthropic, OpenRouter when it says), an estimate marked "est." where Tarsee works it out from the price list, and "Included in plan" for the Claude and ChatGPT plans.

## Only use API keys

**Settings > AI → Only use API keys** turns off the Claude and ChatGPT plan sign-ins, so every message is billed to an API key. Switch it on when other people talk to this Tarsee. With it on, a chat set to a plan says so instead of answering, and the plan cards show *Off*.

To lock it on so it can't be switched off from the dashboard, set the Railway variable `TARSEE_KEYS_ONLY=1`.

## Verify

Some models have no tested path yet: most OpenRouter models from makers other than Anthropic and OpenAI, and every Local AI model except the one chosen on its card. Before you can use one, click **Verify** next to it in Settings > AI (the model menu under the message box points you there). Tarsee runs a few short test turns: a plain reply, one of Tarsee's tools, the shell, and picking a conversation back up. It takes up to a minute and costs a few cents on a paid AI, nothing on Local AI. When the model passes, it shows under **Verified by you** and the model menu lists it. If it doesn't pass, Tarsee says why, and the model stays out of the menu. A few checks an hour are allowed per AI, so a mistaken click can't run up a bill.

## Backup

Settings > AI has an optional **Backup if the default AI can't answer**. When the default AI is out of credit, signed out, busy or down before it has said anything, Tarsee answers with the backup once, posts a short note naming the AI that was unavailable, and starts the reply with a line naming the model that answered. Only ready AIs can be picked, and a plan can't be the backup while **Only use API keys** is on. It is never used when you press Stop or when a spending limit stops a turn.

## Local AI on Railway

`localhost` on Railway means Tarsee's own container, so a Local AI there needs its own service:

1. In the same Railway project, add a service that runs your AI server (for example from the `ollama/ollama` image), with a volume for its models.
2. Make it listen on all addresses (for Ollama, the variable `OLLAMA_HOST=0.0.0.0`) and pull a model into it.
3. In Tarsee, use the service's private address: `http://<service-name>.railway.internal:<port>/v1`, for example `http://ollama.railway.internal:11434/v1`. Private networking stays inside your project, so the server needs no public address and no key.
4. Click **Test**, then **Verify** the model you want.

A model that needs a GPU will be slow on Railway's CPUs; a server on your own machine, reached through a public address protected by a key, is the other option.

## Set up with Railway variables only

To deploy without clicking through the wizard, set `TARSEE_AI_PROVIDER` to `claude`, `anthropic`, `chatgpt`, `openai`, `openrouter`, `deepseek` or `local`, and that AI's key variable (or `TARSEE_LOCAL_AI_URL`, or `CLAUDE_CODE_OAUTH_TOKEN` for the Claude plan). `TARSEE_AI_MODEL` picks its model; empty means that AI's default (for Local AI, the first model its server lists; set it to pin one). When that AI is ready, the setup wizard is skipped. Anything chosen later in Settings > AI wins over these variables.

| Variable | What it does |
|---|---|
| `TARSEE_AI_PROVIDER` | The default AI when Settings hasn't chosen one |
| `TARSEE_AI_MODEL` | Its model when Settings hasn't chosen one; empty means that AI's default (for Local AI, the first model its server lists) |
| `TARSEE_KEYS_ONLY` | `1` locks **Only use API keys** on |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENROUTER_API_KEY` | OpenRouter key |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `TARSEE_LOCAL_AI_URL` | Local AI's server address |
| `TARSEE_LOCAL_AI_KEY` | Local AI's key, only if it asks for one |
| `CLAUDE_CODE_OAUTH_TOKEN` | The Claude plan's token from `claude setup-token` |
| `ENCRYPTION_KEY` | Encrypts what Tarsee stores; set it before saving any key in Settings |

## Switching AI

- **The default:** click **Use this AI** on a ready card in Settings > AI.
- **One chat:** the model menu under the message box lists every ready AI's models. The chat keeps its pick.
- **From any channel:** `/model deepseek`, `/model openrouter`, `/model chatgpt`, `/model opus`, or a provider and model together. `/model` alone lists what each ready AI offers.

When a chat moves to another AI, the new one can't continue the old one's session, so Tarsee gives it the recent conversation (about the last 10,000 characters) to pick up from. The chat's history stays as it was.

## Tools on every AI

Every AI gets Tarsee's own tools (messages and files to your channels, scheduling, memory, the vault, web search, canvases, the browser, PDFs and the rest) plus its engine's own file and shell tools. **Tool Permissions** (Settings > Security) apply to Tarsee's tools on every AI. The engines' built-in shell and file editing are not gated by them, on any AI.

The engine keeps an AI's key out of the environment of the commands the agent runs, so `env` won't show it. That is not a wall. On a Linux server those commands run as the same user as Tarsee and its engines, so they can still read the key: from the engine's or Tarsee's process (`/proc/<pid>/environ`), or from Tarsee's data folder, where keys saved in Settings are kept next to what unlocks them (the encryption key is in that folder, or in Tarsee's process when you set it as a variable). The same goes for the Claude and ChatGPT plan sign-ins. Give every key a credit limit or a small balance; that is the real guard on what it can spend. The vault's keys reach scripts by name, on purpose.

## When something goes wrong

Tarsee says what happened in plain words, the same on every channel, and the card in Settings > AI shows it too:

| Tarsee says | What to do |
|---|---|
| The Claude sign-in expired | Run `claude auth login` in Tarsee's Terminal (or set a fresh `CLAUDE_CODE_OAUTH_TOKEN`) |
| The ChatGPT sign-in expired | Click **Sign in with ChatGPT** on its card again, or run `codex login --device-auth` in the Terminal |
| A key was rejected | Paste a new key on the card (or update the Railway variable) |
| Out of credit, or the key's limit is reached | Top up, or raise the limit, at the link the message gives |
| The ChatGPT plan's limit is reached | Wait for the reset time Tarsee gives, or use another AI meanwhile |
| Can't reach your Local AI | Check the server is running and the address on the card is right |
| This model needs Verify first | Click **Verify** next to it in Settings > AI |

The Terminal fallbacks, for when the dashboard can't do it:

- Claude plan: `claude auth login` (or `claude`, then `/login`), and `claude setup-token` on any computer for a year-long token.
- ChatGPT plan: `codex login --device-auth`. Tarsee's Terminal already points `codex` at the same place the dashboard's sign-in uses.
