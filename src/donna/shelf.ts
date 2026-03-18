/**
 * DonnaShelf — multi-donna manager plus graph-aware helpers.
 */

import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type {
  GraphNoteMetaInput,
  MemoryNote,
  NoteFilterOptions,
  SearchNotesResult,
} from "./graph.js";
import { Donna, DEFAULT_SAVE_DIR } from "./memory.js";
import { reflectAndCleanMemory as reflectDonnaMemory, type ReflectionResult } from "./rewrite.js";

export class DonnaShelf {
  readonly saveDir: string;
  readonly autoSave: boolean;
  private _donna: Map<string, Donna> = new Map();

  constructor(opts?: { saveDir?: string; autoSave?: boolean }) {
    this.saveDir = opts?.saveDir ?? DEFAULT_SAVE_DIR;
    this.autoSave = opts?.autoSave ?? true;
  }

  create(
    name: string,
    opts?: { D?: number; banks?: number; ensembles?: number },
  ): Donna {
    if (this._donna.has(name)) {
      throw new Error(`Donna ${JSON.stringify(name)} already exists`);
    }
    const donna = new Donna({
      name,
      D: opts?.D ?? 16384,
      banks: opts?.banks ?? 4,
      ensembles: opts?.ensembles ?? 1,
      autoSave: this.autoSave,
      saveDir: this.saveDir,
    });
    this._donna.set(name, donna);
    return donna;
  }

  get(name: string): Donna {
    const donna = this._donna.get(name);
    if (!donna) throw new Error(`Donna ${JSON.stringify(name)} not found`);
    return donna;
  }

  getOrCreate(name: string): Donna {
    if (this._donna.has(name)) return this._donna.get(name)!;
    return this.create(name);
  }

  remove(name: string): void {
    if (!this._donna.has(name)) {
      throw new Error(`Donna ${JSON.stringify(name)} not found`);
    }
    const path = join(this.saveDir, `${name}.donna.json`);
    if (existsSync(path)) unlinkSync(path);
    this.get(name).graph.removeAllNotes();
    this._donna.delete(name);
  }

  list(): Array<ReturnType<Donna["status"]>> {
    return [...this._donna.values()].map((donna) => donna.status());
  }

  remember(donnaName: string, key: string, value: string, noteMeta?: GraphNoteMetaInput): void {
    this.getOrCreate(donnaName).remember(key, value, noteMeta);
  }

  recall(
    query: string,
    donnaName?: string,
    sessionId = "",
  ): ReturnType<Donna["recall"]> & { donna_name: string | null } {
    if (donnaName) {
      const result = this.get(donnaName).recall(query, sessionId);
      return { ...result, donna_name: donnaName };
    }

    let best: ReturnType<Donna["recall"]> & { donna_name: string | null } = {
      answer: null,
      confidence: 0,
      margin: 0,
      found: false,
      key: "",
      donna_name: null,
    };

    for (const [name, donna] of this._donna) {
      const result = donna.recall(query, sessionId);
      if (result.found && result.confidence > best.confidence) {
        best = { ...result, donna_name: name };
      }
    }

    return best;
  }

  forget(donnaName: string, key: string): boolean {
    return this.get(donnaName).forget(key);
  }

  createNote(
    donnaName: string,
    title: string,
    content: string,
    tags: string[] = [],
    meta?: GraphNoteMetaInput,
  ): MemoryNote {
    return this.getOrCreate(donnaName).createNote(title, content, tags, meta);
  }

  editNote(
    donnaName: string,
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
    return this.get(donnaName).editNote(noteId, newContent, updates);
  }

  addLink(donnaName: string, note1: string, note2: string, reason: string): boolean {
    return this.get(donnaName).addLink(note1, note2, reason);
  }

  searchNotes(
    query: string,
    donnaName?: string,
    limit = 5,
    opts?: NoteFilterOptions,
  ): Array<SearchNotesResult & { donna_name: string }> {
    if (donnaName) {
      return this.get(donnaName)
        .searchNotes(query, limit, opts)
        .map((result) => ({ ...result, donna_name: donnaName }));
    }

    const results: Array<SearchNotesResult & { donna_name: string }> = [];
    for (const [name, donna] of this._donna) {
      for (const result of donna.searchNotes(query, limit, opts)) {
        results.push({ ...result, donna_name: name });
      }
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  listNotes(donnaName?: string, opts?: NoteFilterOptions): Array<MemoryNote & { donna_name: string }> {
    if (donnaName) {
      return this.get(donnaName)
        .listNotes(opts)
        .map((note) => ({ ...note, donna_name: donnaName }));
    }

    const notes: Array<MemoryNote & { donna_name: string }> = [];
    for (const [name, donna] of this._donna) {
      for (const note of donna.listNotes(opts)) {
        notes.push({ ...note, donna_name: name });
      }
    }
    return notes;
  }

  reflectAndCleanMemory(donnaName?: string, limit = 10): ReflectionResult {
    return reflectDonnaMemory(this, { donnaName, limit });
  }

  loadAll(): void {
    if (!existsSync(this.saveDir)) return;
    for (const fname of readdirSync(this.saveDir)) {
      if (!fname.endsWith(".donna.json")) continue;
      const path = join(this.saveDir, fname);
      try {
        const donna = Donna.load(path, { autoSave: this.autoSave });
        this._donna.set(donna.name, donna);
      } catch {
        // skip corrupt files
      }
    }
  }

  saveAll(): void {
    for (const donna of this._donna.values()) {
      donna.save();
    }
  }

  has(name: string): boolean {
    return this._donna.has(name);
  }

  get size(): number {
    return this._donna.size;
  }
}
