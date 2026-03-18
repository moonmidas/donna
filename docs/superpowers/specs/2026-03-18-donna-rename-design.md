# Donna Rename Design

**Date:** 2026-03-18

## Goal

Transform the current Donna codebase into Donna with a full internal rename, a new public repository identity, and a storage migration from `~/.donna` to `~/.donna` while preserving existing user memory by copying it forward.

## Current Context

- The project currently exposes Donna branding in package metadata, docs, prompts, tests, skills, and gateway user-agent strings.
- Core memory code lives under `src/donna/`.
- The repository currently tracks an `origin` remote under `moonmidas/donna` and an `upstream` remote under `NeoVertex1/donna`.
- The worktree contains unrelated local edits that must not be reverted during the rename.

## Proposed Design

### 1. Full Product Rename

Rename the project from Donna to Donna everywhere it is part of the product identity:

- User-facing docs and instructions
- Package metadata and setup output
- CLI command references from `donna` to `donna`
- Prompt text and gateway identity strings
- File names such as `DONNA_INSTRUCTIONS.md`
- Skill metadata and references
- Internal module paths and imports from `src/donna` to `src/donna`

This is a true product rename rather than a cosmetic alias.

### 2. Storage Migration

Donna will use `~/.donna` as the canonical data directory.

On startup or on first memory access, Donna should detect an existing `~/.donna` directory and copy its contents into `~/.donna` when Donna storage is absent or incomplete. The migration must be safe to run repeatedly and must avoid destroying newer Donna data.

### 3. Fresh Repository History

After the codebase rename is complete and verified, replace the current git metadata with a brand-new repository history. The resulting directory should be ready to connect to a new public repository named `donna`, with no fork relationship and no inherited commit history.

## Testing Strategy

- Add or update tests for the Donna storage path and migration behavior.
- Run the existing Vitest suite to catch import or prompt regressions caused by the rename.
- Sweep the repository for leftover `donna` references and keep only intentional compatibility cases, if any remain.

## Risks And Mitigations

- Broad rename changes can break imports.
  - Mitigation: rename the directory and update imports mechanically, then run typecheck/tests.
- Storage migration can overwrite user data.
  - Mitigation: only copy forward into Donna storage and avoid destructive sync behavior.
- Existing dirty files may intersect the rename.
  - Mitigation: inspect overlapping files and adapt changes instead of reverting user work.

## Expected Outcome

The codebase presents itself as Donna, stores memory under `~/.donna`, carries forward existing Donna memory into the new location, and lives in a fresh git repository ready for a new public GitHub remote named `donna`.
