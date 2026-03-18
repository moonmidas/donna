# Donna — FHRR Memory + Living Note Graph

This project uses `donna` for persistent memory.

The memory system now has three layers:
- FHRR-backed fact recall for fast `remember` / `recall` / `forget`
- A Zettelkasten-style graph in `~/.donna/graph/graph.json`
- A daily reflection pass that rewrites, merges, tags, and links notes

## When to use Donna

**Before searching for files or code patterns**, check memory first:
```bash
donna recall "what you're looking for"
```

**After discovering something useful**, cache it:
```bash
donna remember <donna> "<key>" "<value>"
```

## What to remember

- File locations: `donna remember locations "auth handler" "src/auth/middleware.ts:47"`
- Commands: `donna remember project "test cmd" "pytest tests/ -v"`
- Patterns: `donna remember project "error handling" "uses Result type, never throws"`
- User preferences: `donna remember prefs "style" "2-space indent, no semicolons"`
- Bug fixes: `donna remember debug "CORS error" "add origin to allowlist in config.ts"`

## When note-level memory is better

Use the graph layer when the memory is more than a one-line fact:
- A durable note with a title and paragraph of context
- Something that should link to other notes
- Something likely to be rewritten or merged later
- Something the agent should revisit during daily cleanup

## What NOT to remember

- Anything longer than a short paragraph in the fact layer
- Temporary context that will not matter next session
- Information already in this file

## Commands

```bash
donna remember <donna> <key> <value>   # Store or update a fact
donna recall <query>                     # Search all donna
donna recall <query> --donna <name>     # Search one donna
donna forget <donna> <key>              # Remove a fact
donna list                               # Show all donna
donna facts <donna>                     # Show facts in a donna
```
