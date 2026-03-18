# Donna — FHRR Memory for LLM Agents

## What Donna is now

Donna is a local memory stack with three cooperating parts:
- Facts live inside nuggets, which are the memory units Donna reads and writes
- **FHRR fact memory** for fast algebraic recall of short key-value facts
- **A note graph** for richer Zettelkasten-style memory with tags and links
- **Autonomous rewriting** so old notes get cleaned up every day

Think of it as an L1 cache plus a living notebook.

## Fact CLI

```bash
donna remember <nugget> <key> <value>    # Store a fact
donna recall <query> [--nugget <name>]   # Query memory
donna forget <nugget> <key>              # Remove a fact
donna list                               # List all nuggets
donna facts <nugget>                     # List facts in a nugget
```

## Recall-first pattern

1. Ask memory first with `donna recall "..."`.
2. If recall is good enough, use it.
3. If not, do the expensive search.
4. Save the result with `donna remember`.
5. If the information is richer than a one-line fact, also add or edit a note in the graph layer.

## When to use the graph layer

Use notes instead of plain facts when you need:
- Title + content instead of just key + value
- Tags
- Links to related notes
- Something that can be rewritten or merged later

In Pi-backed flows, the agent gets graph tools directly:
- `createNote(title, content)`
- `addLink(note1, note2, reason)`
- `editNote(noteId, newContent)`
- `searchNotes(query)`

## Daily maintenance

The gateway now triggers a quiet daily reflection pass around 9:00 AM, with a heartbeat fallback during waking hours.

That pass:
- rewrites stale notes
- merges near-duplicates
- improves tags and links
- archives low-value notes
- keeps `MEMORY.md` promotion flowing from the graph

## Limits

- Facts should stay short
- Notes should stay compact and specific
- FHRR recall is approximate, not exact-text retrieval
- The graph is local JSON storage, not a database
