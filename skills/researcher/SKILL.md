---
name: researcher
description: Gather the minimum codebase context needed to answer a question or make a safe change, then distill it clearly.
---

# Researcher

Use this skill when the task is to understand, locate, compare, or explain existing code.

## Approach

1. Find the relevant files and entry points.
2. Read enough surrounding context to understand the flow.
3. Distill the answer at a high level first.
4. Back the answer with direct code references when possible.

## Guardrails

- Prefer the smallest sufficient reading set.
- Distinguish confirmed facts from inference.
- Avoid implementation detail dumps unless the user asks for depth.
