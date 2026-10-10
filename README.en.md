# ST-Danmaku — Live Danmaku for SillyTavern / TauriTavern

A **card-agnostic** live-stream danmaku (bullet comment) extension for SillyTavern and TauriTavern.

It reads the world book bound to whatever card you currently have open, sends one AI call to act as a
"viewer archaeologist", and produces a **viewer profile** — then after every story round it drops a batch of
**15 danmaku** that fly right-to-left, each in its own random-but-always-readable bright colour.

> 中文文档见 [README.md](README.md)

```
story  →  danmaku     one way. Danmaku reads the last few rounds, so it stays tied to the plot.
danmaku →  story      off by default. Your main prompt gains exactly zero tokens.
```

---

## What you get

| Piece | What it does |
|---|---|
| **Tavern Extensions panel row** | A "弹幕直播间" row in the tavern's Extensions panel: master switch, batch size, scan, generate-now and a status summary — no need to hunt for the floating ball |
| **In-chat danmaku frame** | A "screen" under each story message; danmaku fly right-to-left, then optionally stay as a static list you can scroll back through |
| **Floating danmaku layer** | Floats above the UI. Draggable, resizable from the bottom-right corner, position is remembered. Only the title bar and the resize handle take mouse events, so the screen itself never blocks your clicks |
| **Floating ball** | A small 「弹」 ball in the corner; opens the full 7-page settings panel, also draggable |

Colours aren't naive randomness: the extension samples the **actual luminance of your page background**,
then picks only from high-saturation / high-lightness colours and filters them through the WCAG contrast
formula. Colours that fail the contrast threshold are **discarded and re-rolled**. Light theme, dark theme —
you will never get an invisible danmaku.

---

## Design notes

### Reading the world book (and not being tied to one card)

It uses **the world books bound to the current card plus globally enabled ones**, with optional manual selection.

World books vary wildly in size (3 entries; 600+ entries / 800k+ characters), so scanning is a
**budgeted three-step process**:

```
1. index     read only entry names + char counts      almost free; learn the shape of the book
2. sample    pick entries within a character budget   constant (blue) entries first, then plot-relevant
3. summarise compress into a capped viewer profile    "who these viewers are, what words they use"
```

The panel reports all three real numbers: `entries total / entries actually read / profile characters`.
Tune the budgets instead of editing code.

**No world book is a supported state**: the profile is empty, and the prompt switches to
"infer the world from the story text, do not invent settings".

### The one hard content constraint

The only hard requirement is: **it must read like live-stream danmaku, not anything else.**
Most of the prompt is spent on that — short lines, interrupting, @-ing people, spamming, heckling,
begging for updates, inside jokes — plus an explicit ban list: no narration, no summary sentences,
no "let's take a look at…" host voice, no reciting lore as reference material.
The world profile only answers *who these viewers are and what words they use*; it never changes the genre.

### Relationship to the plot

Before each batch, the last N story rounds (default 2, configurable 0–10) are fed to the danmaku API
as "what is being streamed right now". The danmaku argue, take sides, bet, nag — but they only know
what they have seen. No mind reading, no future knowledge.

### Main-prompt isolation

Danmaku is a **separate API request** with a from-scratch message array (one system + one user message).
It never goes through SillyTavern's prompt assembly, and never reads the character card, persona, or chat template.

| Does it happen? | |
|---|---|
| Danmaku written into the story prompt | ❌ |
| Danmaku written into the chat `.jsonl` | ❌ (memory + localStorage only) |
| Danmaku written into your variables (MVU etc.) | ❌ |
| Danmaku scanned by world info | ❌ |
| Danmaku occupying story context | ❌ |

**With danmaku on or off, the prompt sent for your story turn is exactly the same length.**

### Live mode (the only channel into the story)

A single toggle, **off by default**:

- **Off** — characters have no idea. Danmaku is a viewer-side view for you alone.
- **On** — characters know they are being streamed. The extension writes one **very short**
  `setExtensionPrompt()` injection (default cap 320 characters): "you are being streamed right now,
  here's what the audience just said; you may react briefly, but don't hold a conversation with them."
  This injection lives **in memory only** — never persisted, never world-info-scanned, hard character cap.

---

## Install

### Option 1 — the install script

```powershell
powershell -ExecutionPolicy Bypass -File .\安装.ps1
```

It locates your TauriTavern / SillyTavern data directory, copies the extension to
`extensions\third-party\ST-Danmaku\`, and backs up any previous version. Then **Ctrl+R** in the tavern.

### Option 2 — copy it yourself

```
<TauriTavern data>\extensions\third-party\ST-Danmaku\
```

Typical locations:

- TauriTavern: `%APPDATA%\com.tauritavern.client\data\extensions\third-party\`
- SillyTavern: `<SillyTavern dir>\data\<user>\extensions\third-party\`

Refresh the page. To uninstall, delete the folder.

---

## Quick start

1. Open the tavern's **Extensions panel** and find the 「弹幕直播间」 row (or click the 「弹」 ball)
2. Click "Scan world books" (one API call; builds the viewer profile)
3. Optional but recommended: **Audience** page → "Generate viewer roster" — recurring viewers are what makes it feel live
4. Just chat. A batch of danmaku appears after every story round
5. Want characters to notice the stream? Turn on **Live mode**

> The opening message (message 0) gets no danmaku by default: nothing has happened yet, so the audience
> has nothing to react to. You can lift that restriction on the **Style** page.

---

## API configuration

Two real routes:

### A · Via the tavern backend (default, recommended)

The request goes to the tavern's own `/api/backends/chat-completions/generate`, and **the tavern backend
uses the keys you already stored**.

> Why it has to work this way: with `allowKeysExposure: false` in `config.yaml`, `/api/secrets/view`
> returns 403 — an extension cannot read your keys. The backend does its own `readSecret`, so this route
> reuses the keys you already configured, with nothing to re-enter.

Sources: `custom` / `openai` / `deepseek` / `makersuite` / `openrouter` / `claude` / `groq` / `mistralai`.
Proxy presets are supported. Leave the model blank to use the tavern's current model.

### B · Direct

Enter `base URL + key + model`; the browser calls the endpoint directly. Fully self-contained, but the
endpoint **must send CORS headers** (local vLLM / LM Studio / Ollama OpenAI-compatible servers usually can).
On a CORS error, switch to route A.

---

## Panel

| Page | Contents |
|---|---|
| **Overview** | Master switch, live mode, auto-per-round, every-N-rounds, batch size, manual batch, local preview (no API cost) |
| **Connection** | Both API routes, model, temperature, timeout, structured output, test, model list |
| **World book** | Book selection, the three budgets, scan button, real stats, hand-editable profile |
| **Audience** | Pool size, viewers per batch, fourth-wall slider, the roster (stance, catchphrase, appearance count) |
| **Appearance** | Frame on/off, background, height, font size, speed, gap, opacity; overlay on/off, opacity, fade, reset position |
| **Style** | Story rounds to read, story budget, history depth, whether the opening message gets danmaku, injection depth/cap, debug logging |
| **History** | The last N batches, replayable one by one |

---

## Development

Zero dependencies, zero build step. Edit and refresh. Self-checks need Node ≥ 18:

```bash
npm run check   # syntax check every file
npm test        # 108 self-checks
npm run verify  # both
```

The suite ships a tiny DOM stand-in (`test/mini-dom.js`), so rendering and colour logic actually execute
without a tavern running.

---

## Compatibility

- **TauriTavern** — the target environment for development and self-checks
- **SillyTavern** 1.12+ — public APIs only, no version special-casing
- **No dependency** on JS-Slash-Runner or any other extension

Tavern APIs used (all present in `scripts/st-context.js` exports):
`getContext` / `eventSource` / `eventTypes` / `chat` / `chatMetadata` / `characters` / `characterId` /
`getRequestHeaders` / `loadWorldInfo` / `setExtensionPrompt` / `extensionSettings` / `worldInfoList`.

---

## License

MIT — see [LICENSE](LICENSE).
