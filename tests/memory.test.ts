import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_SAVE_DIR,
  LEGACY_SAVE_DIR,
  migrateLegacySaveDir,
  Nugget,
} from "../src/nuggets/memory.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "donna-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Nugget", () => {
  it("uses Donna as the default save directory while keeping Nuggets as the memory unit", () => {
    expect(DEFAULT_SAVE_DIR.endsWith(".donna")).toBe(true);
    expect(LEGACY_SAVE_DIR.endsWith(".nuggets")).toBe(true);
  });

  it("saves new memory files with the Donna extension", () => {
    const n = new Nugget({ name: "persist", D: 512, banks: 2, autoSave: false, saveDir: tmpDir });
    n.remember("lang", "typescript");

    const path = n.save();

    expect(path.endsWith("persist.donna.json")).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("copies legacy Nuggets storage into Donna storage without overwriting newer files", () => {
    const legacyDir = join(tmpDir, ".nuggets");
    const donnaDir = join(tmpDir, ".donna");
    mkdirSync(join(legacyDir, "graph"), { recursive: true });
    writeFileSync(join(legacyDir, "memory.nugget.json"), JSON.stringify({ hello: "world" }));
    writeFileSync(join(legacyDir, "graph", "graph.json"), JSON.stringify({ version: 3, notes: [] }));
    mkdirSync(donnaDir, { recursive: true });
    writeFileSync(join(donnaDir, "memory.donna.json"), JSON.stringify({ hello: "newer" }));

    migrateLegacySaveDir(donnaDir, legacyDir);

    expect(JSON.parse(readFileSync(join(donnaDir, "memory.donna.json"), "utf-8"))).toEqual({ hello: "newer" });
    expect(JSON.parse(readFileSync(join(donnaDir, "graph", "graph.json"), "utf-8"))).toEqual({
      version: 3,
      notes: [],
    });
  });

  it("remembers and recalls a fact", () => {
    const n = new Nugget({ name: "test", D: 512, banks: 2, autoSave: false, saveDir: tmpDir });
    n.remember("color", "blue");
    const result = n.recall("color");
    expect(result.found).toBe(true);
    expect(result.answer).toBe("blue");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("upserts on duplicate key", () => {
    const n = new Nugget({ name: "test", D: 512, banks: 2, autoSave: false, saveDir: tmpDir });
    n.remember("color", "blue");
    n.remember("color", "red");
    expect(n.facts()).toHaveLength(1);
    const result = n.recall("color");
    expect(result.answer).toBe("red");
  });

  it("forgets a fact", () => {
    const n = new Nugget({ name: "test", D: 512, banks: 2, autoSave: false, saveDir: tmpDir });
    n.remember("color", "blue");
    expect(n.forget("color")).toBe(true);
    expect(n.facts()).toHaveLength(0);
    expect(n.forget("nonexistent")).toBe(false);
  });

  it("clears all facts", () => {
    const n = new Nugget({ name: "test", D: 512, banks: 2, autoSave: false, saveDir: tmpDir });
    n.remember("a", "1");
    n.remember("b", "2");
    n.clear();
    expect(n.facts()).toHaveLength(0);
  });

  it("returns correct status", () => {
    const n = new Nugget({ name: "test", D: 512, banks: 2, autoSave: false, saveDir: tmpDir });
    n.remember("a", "1");
    const s = n.status();
    expect(s.name).toBe("test");
    expect(s.fact_count).toBe(1);
    expect(s.dimension).toBe(512);
    expect(s.banks).toBe(2);
  });

  it("saves and loads from JSON", () => {
    const n = new Nugget({ name: "persist", D: 512, banks: 2, autoSave: false, saveDir: tmpDir });
    n.remember("lang", "typescript");
    n.remember("color", "green");
    const path = n.save();

    const loaded = Nugget.load(path, { autoSave: false });
    expect(loaded.name).toBe("persist");
    expect(loaded.facts()).toHaveLength(2);

    const result = loaded.recall("lang");
    expect(result.found).toBe(true);
    expect(result.answer).toBe("typescript");
  });

  it("tracks hit counts per session", () => {
    const n = new Nugget({ name: "hits", D: 512, banks: 2, autoSave: false, saveDir: tmpDir });
    n.remember("key", "value");

    n.recall("key", "session-1");
    n.recall("key", "session-1"); // duplicate — should not increment
    expect(n.facts()[0].hits).toBe(1);

    n.recall("key", "session-2");
    expect(n.facts()[0].hits).toBe(2);
  });

  it("enforces max_facts limit", () => {
    const n = new Nugget({ name: "limited", D: 512, banks: 2, autoSave: false, maxFacts: 3, saveDir: tmpDir });
    n.remember("a", "1");
    n.remember("b", "2");
    n.remember("c", "3");
    n.remember("d", "4"); // should evict "a"
    expect(n.facts()).toHaveLength(3);
    expect(n.facts().map((f) => f.key)).toEqual(["b", "c", "d"]);
  });

  it("handles multiple facts with distinct values", () => {
    const n = new Nugget({ name: "multi", D: 1024, banks: 4, autoSave: false, saveDir: tmpDir });
    n.remember("name", "Alice");
    n.remember("pet", "cat");
    n.remember("city", "London");

    const r1 = n.recall("name");
    expect(r1.found).toBe(true);
    expect(r1.answer).toBe("Alice");

    const r2 = n.recall("pet");
    expect(r2.found).toBe(true);
    expect(r2.answer).toBe("cat");

    const r3 = n.recall("city");
    expect(r3.found).toBe(true);
    expect(r3.answer).toBe("London");
  });

  it("fuzzy matches keys", () => {
    const n = new Nugget({ name: "fuzzy", D: 512, banks: 2, autoSave: false, saveDir: tmpDir });
    n.remember("favorite color", "blue");

    // Substring match
    const r = n.recall("color");
    expect(r.found).toBe(true);
    expect(r.answer).toBe("blue");
  });

  it("returns not-found for unknown queries", () => {
    const n = new Nugget({ name: "empty", D: 512, banks: 2, autoSave: false, saveDir: tmpDir });
    const result = n.recall("anything");
    expect(result.found).toBe(false);
    expect(result.answer).toBeNull();
  });

  it("ignores empty key/value on remember", () => {
    const n = new Nugget({ name: "test", D: 512, banks: 2, autoSave: false, saveDir: tmpDir });
    n.remember("", "value");
    n.remember("key", "");
    n.remember("  ", "value");
    expect(n.facts()).toHaveLength(0);
  });

  it("mirrors facts into graph notes and can search them", () => {
    const n = new Nugget({ name: "graph", D: 512, banks: 2, autoSave: false, saveDir: tmpDir });
    n.remember("favorite color", "blue");

    const notes = n.listNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("favorite color");
    expect(notes[0].content).toBe("blue");

    const matches = n.searchNotes("color");
    expect(matches[0].note.id).toBe(notes[0].id);
  });

  it("edits fact notes and keeps the fact API in sync", () => {
    const n = new Nugget({ name: "graph", D: 512, banks: 2, autoSave: false, saveDir: tmpDir });
    n.remember("favorite color", "blue");
    const note = n.listNotes()[0];

    n.editNote(note.id, "green");
    expect(n.recall("favorite color").answer).toBe("green");
  });

  it("creates and updates free-form notes", () => {
    const n = new Nugget({ name: "graph", D: 512, banks: 2, autoSave: false, saveDir: tmpDir });
    const note = n.createNote("shopping list", "milk\nmilk\nbread", ["personal"]);
    const updated = n.editNote(note.id, "milk\nbread\neggs", { tags: ["personal", "shopping"] });

    expect(updated?.content).toBe("milk\nbread\neggs");
    expect(updated?.tags).toContain("shopping");
    expect(n.searchNotes("eggs")[0].note.id).toBe(note.id);
  });

  it("infers self/user/shared metadata from scoped fact keys", () => {
    const n = new Nugget({ name: "graph", D: 512, banks: 2, autoSave: false, saveDir: tmpDir });

    n.remember("self:name", "astra");
    n.remember("user:tone", "playful");
    n.remember("shared:project", "donna");

    const selfNotes = n.listNotes({ scope: "self" });
    const userNotes = n.listNotes({ scope: "user" });
    const sharedNotes = n.listNotes({ scope: "shared" });

    expect(selfNotes).toHaveLength(1);
    expect(selfNotes[0].subject).toBe("assistant:self");
    expect(selfNotes[0].type).toBe("self_model");

    expect(userNotes).toHaveLength(1);
    expect(userNotes[0].subject).toBe("user:primary");
    expect(userNotes[0].type).toBe("fact");

    expect(sharedNotes).toHaveLength(1);
    expect(sharedNotes[0].subject).toBe("shared:project");
  });

  it("filters note search by memory scope", () => {
    const n = new Nugget({ name: "graph", D: 512, banks: 2, autoSave: false, saveDir: tmpDir });

    n.createNote("self:voice", "casual lowercase guidance", [], {
      scope: "self",
      subject: "assistant:self",
      type: "self_model",
      source: "agent_reflection",
    });
    n.createNote("user:voice", "prefers playful direct explanations", [], {
      scope: "user",
      subject: "user:primary",
      type: "preference",
      source: "explicit_user",
    });

    const selfMatches = n.searchNotes("voice", 10, { scope: "self" });
    const userMatches = n.searchNotes("voice", 10, { scope: "user" });

    expect(selfMatches).toHaveLength(1);
    expect(selfMatches[0].note.scope).toBe("self");
    expect(userMatches).toHaveLength(1);
    expect(userMatches[0].note.scope).toBe("user");
  });

  it("migrates legacy unscoped fact keys on load", () => {
    const donnaPath = join(tmpDir, "memory.nugget.json");
    writeFileSync(
      donnaPath,
      JSON.stringify({
        version: 4,
        name: "memory",
        D: 512,
        banks: 2,
        ensembles: 1,
        max_facts: 0,
        facts: [
          { key: "user_name", value: "Esteban", hits: 0, last_hit_session: "" },
          { key: "assistant_name", value: "Astra", hits: 0, last_hit_session: "" },
          { key: "server_features", value: "dynamic reaction system", hits: 0, last_hit_session: "" },
        ],
        config: { sharpen_p: 1, corvacs_a: 0, temp_T: 0.9, orth_iters: 1 },
      }),
    );

    const loaded = Nugget.load(donnaPath, { autoSave: false });
    expect(loaded.facts().map((fact) => fact.key).sort()).toEqual([
      "self:assistant_name",
      "shared:server_features",
      "user:user_name",
    ]);
  });

  it("reclassifies legacy graph notes away from shared when possible", () => {
    const donnaPath = join(tmpDir, "memory.nugget.json");
    writeFileSync(
      donnaPath,
      JSON.stringify({
        version: 4,
        name: "memory",
        D: 512,
        banks: 2,
        ensembles: 1,
        max_facts: 0,
        facts: [],
        config: { sharpen_p: 1, corvacs_a: 0, temp_T: 0.9, orth_iters: 1 },
      }),
    );

    const graphDir = join(tmpDir, "graph");
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(
      join(graphDir, "graph.json"),
      JSON.stringify({
        version: 2,
        notes: [
          {
            id: "fact-memory-user",
            nuggetName: "memory",
            title: "user_name",
            content: "Esteban",
            tags: ["memory"],
            links: [],
            vector: { seed: 0, basis: [] },
            hidden: false,
            kind: "fact",
            sourceKey: "user_name",
            hits: 0,
            lastHitSession: "",
            createdAt: "2026-03-17T00:00:00.000Z",
            updatedAt: "2026-03-17T00:00:00.000Z",
            lastAccessedAt: "2026-03-17T00:00:00.000Z",
            subject: "shared:project",
            scope: "shared",
            type: "fact",
            source: "explicit_user",
            confidence: 0.9,
            stability: "durable",
          },
          {
            id: "fact-memory-self",
            nuggetName: "memory",
            title: "assistant_name",
            content: "Astra",
            tags: ["memory"],
            links: [],
            vector: { seed: 0, basis: [] },
            hidden: false,
            kind: "fact",
            sourceKey: "assistant_name",
            hits: 0,
            lastHitSession: "",
            createdAt: "2026-03-17T00:00:00.000Z",
            updatedAt: "2026-03-17T00:00:00.000Z",
            lastAccessedAt: "2026-03-17T00:00:00.000Z",
            subject: "shared:project",
            scope: "shared",
            type: "fact",
            source: "explicit_user",
            confidence: 0.9,
            stability: "durable",
          },
        ],
      }),
    );

    const loaded = Nugget.load(donnaPath, { autoSave: false });
    const notes = loaded.listNotes({ includeHidden: true }).sort((a, b) => a.title.localeCompare(b.title));

    expect(notes.map((note) => note.scope)).toEqual(["self", "user"]);
    expect(notes.map((note) => note.subject)).toEqual(["assistant:self", "user:primary"]);
    expect(notes.map((note) => note.title)).toEqual(["self:assistant_name", "user:user_name"]);
  });
});
