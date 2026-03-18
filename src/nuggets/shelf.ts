/**
 * NuggetShelf — multi-nugget manager plus graph-aware helpers.
 */

import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type {
  GraphNoteMetaInput,
  MemoryNote,
  NoteFilterOptions,
  SearchNotesResult,
} from "./graph.js";
import { Nugget, DEFAULT_SAVE_DIR, LEGACY_SAVE_EXT, SAVE_EXT } from "./memory.js";
import { reflectAndCleanMemory as reflectNuggetMemory, type ReflectionResult } from "./rewrite.js";

export class NuggetShelf {
  readonly saveDir: string;
  readonly autoSave: boolean;
  private _nuggets: Map<string, Nugget> = new Map();

  constructor(opts?: { saveDir?: string; autoSave?: boolean }) {
    this.saveDir = opts?.saveDir ?? DEFAULT_SAVE_DIR;
    this.autoSave = opts?.autoSave ?? true;
  }

  create(
    name: string,
    opts?: { D?: number; banks?: number; ensembles?: number },
  ): Nugget {
    if (this._nuggets.has(name)) {
      throw new Error(`Nugget ${JSON.stringify(name)} already exists`);
    }
    const nugget = new Nugget({
      name,
      D: opts?.D ?? 16384,
      banks: opts?.banks ?? 4,
      ensembles: opts?.ensembles ?? 1,
      autoSave: this.autoSave,
      saveDir: this.saveDir,
    });
    this._nuggets.set(name, nugget);
    return nugget;
  }

  get(name: string): Nugget {
    const nugget = this._nuggets.get(name);
    if (!nugget) throw new Error(`Nugget ${JSON.stringify(name)} not found`);
    return nugget;
  }

  getOrCreate(name: string): Nugget {
    if (this._nuggets.has(name)) return this._nuggets.get(name)!;
    return this.create(name);
  }

  remove(name: string): void {
    if (!this._nuggets.has(name)) {
      throw new Error(`Nugget ${JSON.stringify(name)} not found`);
    }
    const currentPath = join(this.saveDir, `${name}${SAVE_EXT}`);
    const legacyPath = join(this.saveDir, `${name}${LEGACY_SAVE_EXT}`);
    if (existsSync(currentPath)) unlinkSync(currentPath);
    if (existsSync(legacyPath)) unlinkSync(legacyPath);
    this.get(name).graph.removeAllNotes();
    this._nuggets.delete(name);
  }

  list(): Array<ReturnType<Nugget["status"]>> {
    return [...this._nuggets.values()].map((nugget) => nugget.status());
  }

  remember(nuggetName: string, key: string, value: string, noteMeta?: GraphNoteMetaInput): void {
    this.getOrCreate(nuggetName).remember(key, value, noteMeta);
  }

  recall(
    query: string,
    nuggetName?: string,
    sessionId = "",
  ): ReturnType<Nugget["recall"]> & { nugget_name: string | null } {
    if (nuggetName) {
      const result = this.get(nuggetName).recall(query, sessionId);
      return { ...result, nugget_name: nuggetName };
    }

    let best: ReturnType<Nugget["recall"]> & { nugget_name: string | null } = {
      answer: null,
      confidence: 0,
      margin: 0,
      found: false,
      key: "",
      nugget_name: null,
    };

    for (const [name, nugget] of this._nuggets) {
      const result = nugget.recall(query, sessionId);
      if (result.found && result.confidence > best.confidence) {
        best = { ...result, nugget_name: name };
      }
    }

    return best;
  }

  forget(nuggetName: string, key: string): boolean {
    return this.get(nuggetName).forget(key);
  }

  createNote(
    nuggetName: string,
    title: string,
    content: string,
    tags: string[] = [],
    meta?: GraphNoteMetaInput,
  ): MemoryNote {
    return this.getOrCreate(nuggetName).createNote(title, content, tags, meta);
  }

  editNote(
    nuggetName: string,
    noteId: string,
    newContent: string,
    updates?: {
      tags?: string[];
      title?: string;
      hidden?: boolean;
      rewrittenAt?: string;
      noteMeta?: GraphNoteMetaInput;
    },
  ): MemoryNote | null {
    return this.get(nuggetName).editNote(noteId, newContent, updates);
  }

  addLink(nuggetName: string, note1: string, note2: string, reason: string): boolean {
    return this.get(nuggetName).addLink(note1, note2, reason);
  }

  searchNotes(
    query: string,
    nuggetName?: string,
    limit = 5,
    opts?: NoteFilterOptions,
  ): Array<SearchNotesResult & { nugget_name: string }> {
    if (nuggetName) {
      return this.get(nuggetName)
        .searchNotes(query, limit, opts)
        .map((result) => ({ ...result, nugget_name: nuggetName }));
    }

    const results: Array<SearchNotesResult & { nugget_name: string }> = [];
    for (const [name, nugget] of this._nuggets) {
      for (const result of nugget.searchNotes(query, limit, opts)) {
        results.push({ ...result, nugget_name: name });
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  listNotes(nuggetName?: string, opts?: NoteFilterOptions): Array<MemoryNote & { nugget_name: string }> {
    if (nuggetName) {
      return this.get(nuggetName)
        .listNotes(opts)
        .map((note) => ({ ...note, nugget_name: nuggetName }));
    }

    const notes: Array<MemoryNote & { nugget_name: string }> = [];
    for (const [name, nugget] of this._nuggets) {
      for (const note of nugget.listNotes(opts)) {
        notes.push({ ...note, nugget_name: name });
      }
    }
    return notes;
  }

  reflectAndCleanMemory(nuggetName?: string, limit = 10): ReflectionResult {
    return reflectNuggetMemory(this, { nuggetName, limit });
  }

  loadAll(): void {
    if (!existsSync(this.saveDir)) return;
    for (const fname of readdirSync(this.saveDir)) {
      const isCurrentFile = fname.endsWith(SAVE_EXT);
      const isLegacyFile = fname.endsWith(LEGACY_SAVE_EXT);
      if (!isCurrentFile && !isLegacyFile) continue;
      const path = join(this.saveDir, fname);
      try {
        const nugget = Nugget.load(path, { autoSave: this.autoSave });
        if (this._nuggets.has(nugget.name) && isLegacyFile) {
          continue;
        }
        this._nuggets.set(nugget.name, nugget);
      } catch {
        // skip corrupt files
      }
    }
  }

  saveAll(): void {
    for (const nugget of this._nuggets.values()) {
      nugget.save();
    }
  }

  has(name: string): boolean {
    return this._nuggets.has(name);
  }

  get size(): number {
    return this._nuggets.size;
  }
}
