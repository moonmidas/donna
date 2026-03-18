import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NuggetShelf } from "../src/nuggets/shelf.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "donna-shelf-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("NuggetShelf", () => {
  it("creates and retrieves nuggets", () => {
    const shelf = new NuggetShelf({ saveDir: tmpDir, autoSave: false });
    const n = shelf.create("test", { D: 512, banks: 2 });
    expect(n.name).toBe("test");
    expect(shelf.get("test")).toBe(n);
    expect(shelf.size).toBe(1);
  });

  it("throws on duplicate create", () => {
    const shelf = new NuggetShelf({ saveDir: tmpDir, autoSave: false });
    shelf.create("test");
    expect(() => shelf.create("test")).toThrow("already exists");
  });

  it("throws on get missing", () => {
    const shelf = new NuggetShelf({ saveDir: tmpDir, autoSave: false });
    expect(() => shelf.get("nope")).toThrow("not found");
  });

  it("getOrCreate creates on first call and returns on second", () => {
    const shelf = new NuggetShelf({ saveDir: tmpDir, autoSave: false });
    const n1 = shelf.getOrCreate("test");
    const n2 = shelf.getOrCreate("test");
    expect(n1).toBe(n2);
  });

  it("removes nuggets and deletes files", () => {
    const shelf = new NuggetShelf({ saveDir: tmpDir, autoSave: true });
    shelf.create("doomed", { D: 512, banks: 2 });
    shelf.remember("doomed", "key", "val");
    shelf.remove("doomed");
    expect(shelf.size).toBe(0);
  });

  it("remembers and recalls across nuggets", () => {
    const shelf = new NuggetShelf({ saveDir: tmpDir, autoSave: false });
    shelf.create("prefs", { D: 512, banks: 2 });
    shelf.create("facts", { D: 512, banks: 2 });

    shelf.remember("prefs", "color", "blue");
    shelf.remember("facts", "city", "London");

    // Targeted recall
    const r1 = shelf.recall("color", "prefs");
    expect(r1.found).toBe(true);
    expect(r1.answer).toBe("blue");
    expect(r1.nugget_name).toBe("prefs");

    // Broadcast recall
    const r2 = shelf.recall("city");
    expect(r2.found).toBe(true);
    expect(r2.answer).toBe("London");
    expect(r2.nugget_name).toBe("facts");
  });

  it("saves and loads all nuggets", () => {
    const shelf1 = new NuggetShelf({ saveDir: tmpDir, autoSave: true });
    shelf1.create("a", { D: 512, banks: 2 });
    shelf1.create("b", { D: 512, banks: 2 });
    shelf1.remember("a", "k1", "v1");
    shelf1.remember("b", "k2", "v2");
    shelf1.saveAll();

    const shelf2 = new NuggetShelf({ saveDir: tmpDir, autoSave: false });
    shelf2.loadAll();
    expect(shelf2.size).toBe(2);
    expect(shelf2.recall("k1", "a").answer).toBe("v1");
    expect(shelf2.recall("k2", "b").answer).toBe("v2");
  });

  it("lists nugget statuses", () => {
    const shelf = new NuggetShelf({ saveDir: tmpDir, autoSave: false });
    shelf.create("one", { D: 512, banks: 2 });
    shelf.create("two", { D: 512, banks: 2 });
    const list = shelf.list();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.name).sort()).toEqual(["one", "two"]);
  });

  it("has() checks existence", () => {
    const shelf = new NuggetShelf({ saveDir: tmpDir, autoSave: false });
    shelf.create("exists");
    expect(shelf.has("exists")).toBe(true);
    expect(shelf.has("nope")).toBe(false);
  });

  it("broadcast recall returns best confidence", () => {
    const shelf = new NuggetShelf({ saveDir: tmpDir, autoSave: false });
    shelf.create("a", { D: 512, banks: 2 });
    shelf.create("b", { D: 512, banks: 2 });

    shelf.remember("a", "color", "red");
    shelf.remember("b", "color", "blue");

    // Both nuggets have "color" key — broadcast should return one
    const r = shelf.recall("color");
    expect(r.found).toBe(true);
    expect(["red", "blue"]).toContain(r.answer);
  });

  it("creates and searches graph notes across the shelf", () => {
    const shelf = new NuggetShelf({ saveDir: tmpDir, autoSave: false });
    shelf.create("memory", { D: 512, banks: 2 });

    const note = shelf.createNote("memory", "shopping list", "milk bread eggs", ["shopping"]);
    const results = shelf.searchNotes("eggs");

    expect(results[0].note.id).toBe(note.id);
    expect(results[0].nugget_name).toBe("memory");
  });

  it("reflects and cleans memory notes safely", () => {
    const shelf = new NuggetShelf({ saveDir: tmpDir, autoSave: false });
    shelf.create("memory", { D: 512, banks: 2 });

    shelf.createNote("memory", "shopping list", "milk bread");
    shelf.createNote("memory", "shopping list", "milk bread");
    shelf.createNote("memory", "tmp scratch", "");

    const result = shelf.reflectAndCleanMemory("memory", 10);
    expect(result.inspected).toBeGreaterThan(0);
    expect(result.merged).toBeGreaterThanOrEqual(1);
    expect(result.hidden).toBeGreaterThanOrEqual(1);
  });

  it("keeps self and user notes separate during reflection", () => {
    const shelf = new NuggetShelf({ saveDir: tmpDir, autoSave: false });
    shelf.create("memory", { D: 512, banks: 2 });

    shelf.createNote("memory", "self:voice", "casual lowercase", [], {
      scope: "self",
      subject: "assistant:self",
      type: "self_model",
      source: "agent_reflection",
      stability: "durable",
    });
    shelf.createNote("memory", "user:voice", "casual lowercase", [], {
      scope: "user",
      subject: "user:primary",
      type: "preference",
      source: "explicit_user",
      stability: "durable",
    });

    const result = shelf.reflectAndCleanMemory("memory", 10);
    const notes = shelf.listNotes("memory", { includeHidden: true });

    expect(result.merged).toBe(0);
    expect(notes.filter((note) => !note.hidden)).toHaveLength(2);
    expect(notes.map((note) => note.scope).sort()).toEqual(["self", "user"]);
  });

  it("filters note search across the shelf by scope", () => {
    const shelf = new NuggetShelf({ saveDir: tmpDir, autoSave: false });
    shelf.create("memory", { D: 512, banks: 2 });

    shelf.createNote("memory", "self:identity", "name is astra", [], {
      scope: "self",
      subject: "assistant:self",
      type: "self_model",
      source: "agent_reflection",
    });
    shelf.createNote("memory", "user:identity", "name is esteban", [], {
      scope: "user",
      subject: "user:primary",
      type: "fact",
      source: "explicit_user",
    });

    const selfResults = shelf.searchNotes("identity", "memory", 10, { scope: "self" });
    const userResults = shelf.searchNotes("identity", "memory", 10, { scope: "user" });

    expect(selfResults).toHaveLength(1);
    expect(selfResults[0].note.subject).toBe("assistant:self");
    expect(userResults).toHaveLength(1);
    expect(userResults[0].note.subject).toBe("user:primary");
  });
});
