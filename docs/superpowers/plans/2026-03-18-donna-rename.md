# Donna Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename Donna to Donna across the codebase, migrate persisted memory to `~/.donna`, and reinitialize the repository with fresh history for a new public `donna` repo.

**Architecture:** Perform the rename in focused stages: first add migration coverage and update memory-path behavior, then rename source paths/imports and user-facing identity, then verify the codebase and replace git metadata. The migration logic must preserve existing data by copying from the old storage directory into the new one without destructive sync.

**Tech Stack:** TypeScript, Node.js, Vitest, git

---

### Task 1: Add Donna storage migration coverage

**Files:**
- Modify: `tests/memory.test.ts`
- Modify: `tests/shelf.test.ts`
- Test: `tests/memory.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests that verify Donna uses `~/.donna` as the default save directory and copies existing data from a simulated Donna directory when Donna storage is missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/memory.test.ts`
Expected: FAIL because default path and migration behavior still target Donna only.

- [ ] **Step 3: Write minimal implementation**

Update the memory layer to use Donna storage and add safe copy-forward migration logic from `~/.donna`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/memory.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/memory.test.ts src/donna/memory.ts
git commit -m "feat: migrate Donna storage to Donna"
```

### Task 2: Rename internal module paths and imports

**Files:**
- Move: `src/donna/*` to `src/donna/*`
- Modify: `.pi/extensions/donna.ts`
- Modify: `tests/core.test.ts`
- Modify: `tests/memory.test.ts`
- Modify: `tests/shelf.test.ts`
- Modify: any files importing `src/donna/*`

- [ ] **Step 1: Rename the directory and update imports**

Move the module directory to `src/donna` and update all internal imports and test imports accordingly.

- [ ] **Step 2: Run focused verification**

Run: `npm test -- tests/core.test.ts tests/memory.test.ts tests/shelf.test.ts`
Expected: PASS or import-related failures that identify missed rename sites.

- [ ] **Step 3: Fix missed references**

Update remaining imports and path-based strings until the focused tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/donna tests/core.test.ts tests/memory.test.ts tests/shelf.test.ts .pi/extensions/donna.ts
git commit -m "refactor: rename Donna modules to Donna"
```

### Task 3: Rename product identity and CLI references

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Move: `DONNA_INSTRUCTIONS.md` to `DONNA_INSTRUCTIONS.md`
- Modify: `src/gateway/*`
- Modify: `src/setup.ts`
- Modify: `skills/donna-memory/*`
- Modify: `.pi/extensions/donna.ts`

- [ ] **Step 1: Update user-facing identity strings**

Change project/product names, command examples, GitHub URLs, and visible labels from Donna to Donna.

- [ ] **Step 2: Rename instruction and skill artifacts**

Rename files and metadata where the artifact name itself includes Donna.

- [ ] **Step 3: Run broad verification**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Sweep for leftover references**

Run: `rg -n --hidden --glob '!.git' "Donna|donna|DONNA" .`
Expected: only intentionally preserved migration references, or no matches.

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat: rename product identity from Donna to Donna"
```

### Task 4: Reinitialize git history for the new repo

**Files:**
- Modify: `.git` metadata only

- [ ] **Step 1: Capture current remote info for reference**

Run: `git remote -v`
Expected: existing Donna remotes shown for reference before reset.

- [ ] **Step 2: Remove git metadata and reinitialize**

Run: `rm -rf .git && git init`
Expected: repository reinitialized with fresh history.

- [ ] **Step 3: Stage renamed project**

Run: `git add -A`
Expected: all current files staged as an initial commit.

- [ ] **Step 4: Create fresh initial commit**

Run: `git commit -m "feat: initialize donna"`
Expected: new root commit with Donna identity.

- [ ] **Step 5: Connect the new public repo**

Run: `git remote add origin <new-donna-repo-url>`
Expected: `origin` points to the new public Donna repository.

### Task 5: Final verification

**Files:**
- Verify entire workspace state

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 3: Confirm rename sweep**

Run: `rg -n --hidden --glob '!.git' "Donna|donna|DONNA" .`
Expected: no unexpected references remain.

- [ ] **Step 4: Record GitHub follow-up**

If remote creation cannot be completed locally, leave the repo reinitialized and document the exact `gh repo create` or remote-add step needed next.
