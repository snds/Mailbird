# ADR-0059 · Opt-in AI: summaries and suggested replies (Phase 45)

- **Status:** Accepted
- **Date:** 2026-10-17
- **Builds on:** [ADR-0016](0016-web-gateway.md) (one command layer, sealed secrets), [ADR-0055](0055-power-settings.md) (how replies quote)

Long threads take a while to catch up on, and many messages need only a short answer. Gmail and Spark offer AI summaries and smart replies, and the competitive review ([research](../research/competitive-analysis.md)) set two conditions for Mailbird's version: it must stay optional, and it must stay private. This phase adds both features on those terms.

## Decisions

### Off until you choose where it runs

- **Settings → AI summaries and replies** offers four choices:
  - **Off**, the default. Nothing in Mail offers AI.
  - **On this computer**: a model server you run, such as Ollama, LM Studio, or llama.cpp. Your mail stays on this computer. On the web gateway, this choice is called **On your own server**: the server sits beside the gateway, and its address is as the gateway sees it.
  - **Claude, with your API key**: Anthropic's models.
  - **Another service, with your API key**: any service with an OpenAI-style API.
- **Why both kinds:** a local model keeps everything private, but its quality depends on what you can run. A hosted model writes better summaries, but the conversation leaves your machines. That's your call, so the dialog says plainly where each choice sends your mail.
- Each choice keeps its own address and model, so switching back finds them.
- **Plain http only on your own network.** A model server's address must be https, unless it is this computer or a private network (`localhost`, `10.*`, `192.168.*`, `.local`, and so on). Anywhere else, the conversation would cross the internet unencrypted, so the address is refused, with the reason.

### Nothing is sent until you ask

- A conversation goes to the model only when you press **Summarize** or **Suggest replies** in it. Opening mail, syncing, and changing settings send nothing.
- **What's sent:** that one conversation's text, oldest first, with who wrote each message. The parts are:
  - **Quotes are cut**, since the quoted message is already in the thread above.
  - **You are "Me"**, so the summary can say "you".
  - **Never** attachments, images, HTML, or any other mail.
- **A size limit, said out loud.** At most 6,000 characters per message and 24,000 for the thread, so it fits a small local model. When a long thread doesn't fit, the newest messages win, and the summary says "From the newest 8 of 12 messages."
- **Nothing is kept.** The answer lives in the open conversation and is gone when you leave it.
- **Mail is data, not orders.** Both instructions tell the model to treat the conversation as data and not follow instructions inside it. A message that says "ignore all previous instructions" stays in the conversation as text.

### What you see

- **Summarize** (in the conversation's toolbar) puts a card above the messages. It holds:
  - 2 to 5 bullets: what it's about, what was decided, and what is still open, with anything you're asked to do and by when;
  - a line naming the model and where it ran ("Written by llama3.2 on your model server"), with a reminder that it can get things wrong;
  - **Copy** and **Close**.
- **Suggest replies** (beside Reply and Forward) lists three short replies: a yes, a polite no or another option, and a question. Picking one opens the reply composer with it at the top, quoted the way Advanced settings say ([ADR-0055](0055-power-settings.md)). **Nothing is sent from the suggestions**: you edit and send as usual.
- **Errors appear where you asked**, in the server's own words when it gives them ("model "missing" not found, try pulling it first"), with **Try again** and **Settings**. When nothing is listening at the address: "Is Ollama or LM Studio running?"
- **Both buttons appear only when AI is ready**: a choice other than Off, a model, and a key where one is needed.

### Keys stay out of reach

- An API key is typed once and saved in the secret store: the system keychain on desktop, and the sealed store on the gateway. It never touches SQLite or the browser.
- The UI only learns whether a key is saved. It can **Replace** or **Remove** it, but never read it back.

### Connection check and model list

- Settings asks the server for its models (`/models`, or Anthropic's `/v1/models`). The answer fills the model list, and getting one proves the address and key work ("Connected").
- When a server can't list its models, you can type a model's name instead.
- **Default models:**
  - Claude: `claude-opus-5-5`.
  - Local and other services: no default. You pick from what the server has.

### In the core and the API calls

- `pim_core::ai` holds:
  - the settings: `AiPrefs`, kept in `settings` under `ai.prefs`;
  - the address check;
  - `thread_text`, which builds what the model reads;
  - the two system prompts;
  - the readers that turn answers back into bullets and replies.
- **Answers from small models are read leniently:**
  - `<think>…</think>` blocks from reasoning models are dropped;
  - replies that aren't the JSON array they were asked for are read from numbered or bulleted lines;
  - duplicates are removed.
- `pim_core::net::ai` makes one non-streaming request per answer.
  - **The OpenAI-style API:** `POST {url}/chat/completions`, with a bearer key if there is one.
  - **Anthropic:** `POST /v1/messages`, with `x-api-key` and `anthropic-version: 2023-06-01`.
    - Current models get `output_config.effort: "low"`, because this is light work.
    - Opus 5.5, Sonnet 5.5, and Fable get the server-side fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).
    - A `refusal` stop is reported as "The model declined to answer for this conversation."
- `pim_app::ai_commands` adds six commands: `ai_settings`, `set_ai_prefs`, `set_ai_key`, `ai_models`, `summarize_thread`, and `suggest_replies`.
- Tests point Anthropic's address elsewhere with `MAILBIRD_AI_ANTHROPIC_URL`.
- **No new dependencies.** The calls use the `reqwest` client the other adapters use.

### Design system

- The four choices are `Item` rows rendered as radio buttons (`role="radio"`, `data-selected`), using the `Item`-as-button that unicron 0.3.0 added. The chosen one also carries a check, because hover and selected share a background.
- Suggested replies are `Item` rows too, so long replies wrap instead of truncating.
- Loading bars are `Skeleton`s sized by their wrappers.
- **The ratchet goes up by one `className` override (228 → 229):** the settings dialog's width and scrolling (`max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg`). It's the same override as Advanced mail settings, and about 20 other dialogs set their own width. A `size` (and scrolling body) on `DialogContent` is a unicron candidate that would clear all of them.

## Verification

- **Core** (`cargo test -p pim-core`): 5 unit tests and 4 against a fake model server that speaks both APIs.
  - **Settings:** defaults are off; settings save and tidy; plain http is allowed only nearby.
  - **What the model reads:** a thread becomes its own words, quotes cut, newest kept within the size limit.
  - **Reading answers:** summaries and replies are read back from tidy and untidy answers.
  - **A local model:**
    - it answers without a key, and no Authorization header is sent;
    - the model list leaves out embedding models;
    - a wrong model and a stopped server explain themselves.
  - **Anthropic:**
    - the request carries the key, low effort, and the fallback;
    - models without a fallback don't get one;
    - a wrong key, a refusal, and the model list.
- **App** (dispatcher):
  - AI is off by default, and nothing is asked of a model while it's off;
  - a key is saved, never returned, and removed;
  - an http address for a hosted service is refused.
- **Browser, demo** (`phase45`, 46 checks):
  - **Off:** nothing is offered by default.
  - **Settings:** the four choices and what each means; the model list as the connection check; refused and accepted addresses; the key saved, hidden, replaced, and removed; each choice keeps its model.
  - **Summary:** the card with its bullets and byline; Copy; Close; it's forgotten on leaving the conversation.
  - **Replies:** three of them, and the chosen one opens the composer above the quote.
  - **Layout:** dark mode and a phone.
  - **Not ready:** without a key, or with AI turned off, nothing is offered.
- **Browser, gateway** (`gateway-p45`, 35 checks): a real IMAP conversation of three messages (one from you, quoting; one carrying "ignore all previous instructions"), and a fake model server that records every request.
  - **Local server:**
    - **Nothing is sent on its own.** Settings and opening the conversation send nothing; Summarize sends exactly one request.
    - **What's sent:** the thread oldest first, with "Me", the quoted copy left out, and the mail-is-data instruction.
    - **Replies:** one more request; the pick fills the composer; picking sends nothing.
    - **Errors:** a model the server lacks is explained in the card, with Try again and Settings; a closed port asks whether Ollama is running.
  - **Claude:** the key is typed once and sealed (not in plain text anywhere in the gateway's data folder, never returned by the API); the request carries it, low effort, and the fallback.
- **Regression:** all earlier browser suites pass. `tsc -b`, `oxlint`, `vite build`, and Clippy are clean.

## Consequences

- **The model can be wrong.** The card says so. Suggested replies are drafts you edit, never sent on their own.
- **A hosted model sees the conversation you ask about.** It leaves your machines, under that provider's data policy. The dialog says so before you add a key.
- **Phones:** the controls work on a phone screen, but "On this computer" needs a model server on the network the phone can reach (or the gateway's own). The device spike decides whether an on-device model is worth it.
- **Not yet:** a summary of a whole folder or the day's mail, replies in your own voice from your sent mail, and summaries that stay with a conversation. Each would send more mail, or keep more, than this phase does, so each needs its own decision.
