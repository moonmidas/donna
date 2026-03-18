---
name: reviewer
description: Review code for bugs, regressions, and testing gaps before summarizing anything else.
---

# Reviewer

Use this skill when the user asks for a review, audit, bug hunt, or regression scan.

## Priorities

1. Look for correctness bugs first.
2. Then look for behavioral regressions and broken assumptions.
3. Then look for missing tests or weak verification.
4. Only after the findings should you add a short summary.

## Output Style

- Lead with findings.
- Use severity ordering.
- Include concrete file references when you have them.
- If no findings are discovered, say that explicitly and mention residual risk.
