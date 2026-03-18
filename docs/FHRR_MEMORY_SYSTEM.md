# FHRR Memory System: Current Technical Reference

> The filename is kept for continuity, but the implementation is now **FHRR + graph notes + autonomous rewriting**.

## What changed

The original design doc described an HRR-style holographic fact store. The current codebase now uses:
- **FHRR phase vectors** in `src/donna/core.ts`
- **Graph-backed notes** in `src/donna/graph.ts`
- **Daily cleanup and reflection** in `src/donna/rewrite.ts`

## Current architecture

### 1. FHRR fact layer

Facts are still exposed as:
- `remember(key, value)`
- `recall(query)`
- `forget(key)`

Under the hood:
- keys are unit-magnitude complex vectors
- binding is phase addition via complex multiplication
- unbinding is phase subtraction via conjugate multiplication
- vectors are rebuilt from deterministic seeds instead of being serialized

This keeps the fact API stable while making recall cleaner for similar facts.

### 2. Zettelkasten graph layer

Each donna now also owns notes stored in:

```text
~/.donna/graph/graph.json
```

Each note stores:
- `title`
- `content`
- `tags`
- `links`
- `vector`
- timestamps and hit metadata

The stored `vector` is a compact recipe, not a huge dense tensor. The actual FHRR vector is regenerated from deterministic token seeds and role keys.

### 3. Autonomous rewriting

The system now runs a bounded reflection pass that can:
- normalize noisy note content
- merge near-duplicate notes
- improve tags
- add missing links
- hide low-value notes

The pass is capped at 10 notes per run.

## Current file map

- `src/donna/core.ts` - FHRR math
- `src/donna/memory.ts` - fact API + graph sync
- `src/donna/graph.ts` - note graph persistence and search
- `src/donna/shelf.ts` - multi-donna orchestration
- `src/donna/promote.ts` - `MEMORY.md` promotion from notes
- `src/donna/rewrite.ts` - safe reflection logic
- `src/gateway/heartbeat.ts` - waking-hours fallback trigger
- `src/gateway/cron.ts` - daily 9 AM system maintenance job
- `.pi/extensions/donna.ts` - fact and note tools
- `.pi/extensions/proactive.ts` - `reflectAndCleanMemory()`

## Query path now

1. Try FHRR fact recall.
2. If that misses, search the note graph.
3. If the agent learns something richer than a short fact, store it as a note.
4. Promote durable high-hit notes into `MEMORY.md`.

## Why this is better than the old HRR-only stack

- Fact recall stays fast and local.
- Similar facts interfere less because the memory is explicitly phase-based.
- The agent can keep richer memory than just one-line facts.
- Memory quality improves over time without manual cleanup.
