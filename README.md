# Donna

A personal AI assistant that remembers. Donna combines fast local FHRR memory, a living note graph, and a multi-channel messaging gateway so your assistant can learn from conversations, reorganize its own memory, and keep working across restarts.

![Donna](images/donna.jpeg)

## Why Donna?

Donna is inspired by Donna from Suits.

Donna doesn't wait for someone to tell her. She already knows.

She knows what needs to happen before someone asks for it. She knows when something is wrong before anyone notices. She handles it, and she handles it well, because that's what she does.

That's the spirit behind this project: an assistant that remembers, notices, and acts with judgment.

Most agents forget between sessions. RAG fixes that, but it usually means embeddings, a vector database, and extra infrastructure. Donna takes a lighter approach:

- **FHRR fact memory** - short facts are stored as phase-based complex vectors and recalled algebraically in about a millisecond.
- **Living note graph** - richer memory lives in a Zettelkasten-style graph with titles, content, tags, links, and deterministic FHRR vectors.
- **Autonomous rewriting** - the assistant can clean, merge, relink, and retag its own notes every day.
- **Promotion to permanent memory** - notes that prove useful still flow into `MEMORY.md`.
- **Proactive messaging** - reminders, check-ins, and scheduled tasks still run through Telegram, WhatsApp, and Discord.

## What's Inside

### Soul

- `SOUL.md` defines Donna's shared voice, judgment, and working style across all backends.

### Memory Engine (`src/nuggets/`)

The memory stack is pure TypeScript and stays local.

- `core.ts` - FHRR math primitives: phase keys, bind, unbind, orthogonalize, sharpen
- `memory.ts` - `Nugget` fact API: `remember`, `recall`, `forget`
- `graph.ts` - graph note storage in `~/.donna/graph/graph.json`
- `rewrite.ts` - bounded reflection pass for cleanup and self-improvement
- `shelf.ts` - multi-nugget manager plus graph helpers
- `promote.ts` - promotion from graph notes to `MEMORY.md`

Each nugget still behaves like topic-scoped memory, but now it has two levels:
- **facts** for very short key-value memory
- **notes** for richer linked memory

### Messaging Gateway (`src/gateway/`)

The gateway still routes messages across channels and backends:

- Telegram
- WhatsApp
- Discord
- Pi, Codex, or a local OpenAI-compatible backend

The proactive system now does three things:
- heartbeat follow-ups
- user-created cron/timer reminders
- silent daily memory reflection around 9:00 AM, with a heartbeat fallback during waking hours

### Pi Extensions (`.pi/extensions/`)

- `donna.ts` - `donna`, `createNote`, `addLink`, `editNote`, `searchNotes`
- `proactive.ts` - `schedule` and `reflectAndCleanMemory`

### Project Skills (`skills/`)

- Skills live in a Donna-owned registry at `skills/<id>/skill.json` plus `SKILL.md`.
- `skill.json` stores metadata like `scope`, `triggers`, `requires`, and backend `adapters`.
- `SKILL.md` stays Pi-compatible, so Pi can still load the same skill directory directly.
- Pi receives the skills as real Pi skills via `--skill`.
- Codex gets the registry catalog plus any active skill instructions in the prompt.
- The local backend inlines active skill contents because it has no file tools.
- Plain Pi-style fallback skills in `.pi/skills/` still work for compatibility.
- Add extra skill files or directories with `AGENT_SKILL_PATHS=/abs/path/one,/another/skill-dir`.
- Manage sticky skills in chat with `/skills`, `/skill use reviewer`, `/skill remove reviewer`, and `/skill clear`.

## How Memory Works

### Fact layer

Facts use FHRR:
- keys are unit-magnitude complex vectors
- binding is phase addition
- unbinding is phase subtraction
- vectors are regenerated from deterministic seeds instead of being stored on disk

This keeps files small and recall fast.

### Graph layer

Notes are stored in JSON and carry:
- title
- content
- tags
- links
- a compact vector recipe
- timestamps and usage counters

Graph search uses both text overlap and regenerated FHRR similarity.

### Rewrite layer

The daily cleanup pass is deliberately conservative:
- inspect at most 10 notes
- normalize stale note content
- merge near-duplicates
- improve tags
- add related links
- hide low-value notes

## Setup

### Prerequisites

- Node.js 18+
- Node.js 22+ if you want zero-dependency Discord support
- One backend:
  - [Pi](https://github.com/mariozechner/pi) for Pi support
  - [Codex CLI](https://developers.openai.com/codex/cli) for Codex support
  - A local OpenAI-compatible server for direct local models
- Channel credentials for whichever chat platforms you want to enable

### Quick Start

```bash
git clone https://github.com/moonmidas/donna.git
cd donna
npm install
npm run setup
npm run dev
```

## Backend Modes

`AGENT_BACKEND=pi`
- Uses the Pi extensions in `.pi/extensions/`
- Loads registry skills from `skills/`, compatible fallback skills from `.pi/skills/`, and extra paths from `AGENT_SKILL_PATHS`
- Loads shared persona guidance from `SOUL.md`
- Exposes fact tools, graph tools, scheduling, and memory reflection

`AGENT_BACKEND=codex`
- Uses `codex exec` / `codex exec resume`
- Prompts Codex to use Donna recall-first behavior and gateway scheduling
- Loads shared persona guidance from `SOUL.md`
- Exposes the same project skills catalog so Codex can read the relevant `SKILL.md` files on demand

`AGENT_BACKEND=local`
- Talks directly to an OpenAI-compatible local server
- Conversational only, no local tool use
- Loads shared persona guidance from `SOUL.md`
- Inlines project skill contents into the system prompt

## How It Flows

```text
You (Telegram / WhatsApp / Discord)
  |
  v
Gateway -> router -> backend session
  |                    |
  |                    v
  |              nuggets memory stack
  |              - FHRR facts
  |              - graph notes
  |              - rewrite pass
  |
  +-> heartbeat
  +-> cron
  +-> maintenance events
  +-> sticky skill state per conversation
```

Normal path:
1. User sends a message.
2. Backend answers and can query nuggets first.
3. Useful facts or notes get stored.
4. High-value notes are promoted to `MEMORY.md`.

Proactive path:
1. Heartbeat or cron fires.
2. The agent checks if it should message the user.
3. A hidden maintenance job can also trigger `reflectAndCleanMemory`.

## Architecture

```text
src/
  nuggets/
    core.ts
    memory.ts
    graph.ts
    rewrite.ts
    shelf.ts
    promote.ts
    index.ts

  gateway/
    main.ts
    config.ts
    agent-pool.ts
    agent-session.ts
    router.ts
    pi-rpc.ts
    codex-rpc.ts
    local-model-rpc.ts
    telegram.ts
    discord.ts
    whatsapp.ts
    event-queue.ts
    cron.ts
    heartbeat.ts

.pi/extensions/
  donna.ts
  proactive.ts

skills/
  donna-memory/
    skill.json
    SKILL.md
  reviewer/
    skill.json
    SKILL.md
  planner/
    skill.json
    SKILL.md
  debugger/
    skill.json
    SKILL.md
  researcher/
    skill.json
    SKILL.md

.pi/skills/
  ... compatibility fallback skills ...
```

## Scripts

| Command | What it does |
|---|---|
| `npm run setup` | Interactive setup wizard |
| `npm run dev` | Start the gateway |
| `npm test` | Run tests |
| `npm run typecheck` | Type-check without emitting |
| `npm run build` | Compile to `dist/` |

## Testing

```bash
npm run typecheck
npm test
```

Tests cover:
- FHRR math
- fact remember/recall/forget
- graph sync and note search
- shelf reflection and cleanup
- gateway routing behavior

## Credit

Donna is a fresh public continuation with a new identity, but it builds on the original Nuggets project and its earlier groundwork. Credit where it's due.

## License

MIT
