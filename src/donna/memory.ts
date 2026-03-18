/**
 * Donna — a single holographic memory unit.
 *
 * Facts are still stored as key/value entries and recalled through the same
 * public API, but each fact is now mirrored into a Zettelkasten-style note
 * graph. The vector memory remains deterministic and seed-based, so the files
 * stay compact while richer note metadata lives in `graph/graph.json`.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  bind,
  corvacsLite,
  makeRoleKeys,
  makeVocabKeys,
  mulberry32,
  orthogonalize,
  seedFromName,
  sharpen,
  softmaxTemp,
  stackAndUnitNorm,
  type ComplexVector,
  unbind,
} from "./core.js";
import {
  type GraphNoteMetaInput,
  hasScopedKeyPrefix,
  DonnaGraph,
  type MemoryNote,
  type NoteFilterOptions,
  prefixScopedKey,
  type SearchNotesResult,
} from "./graph.js";

export const LEGACY_SAVE_DIR = join(homedir(), ".nuggets");
export const DEFAULT_SAVE_DIR = join(homedir(), ".donna");

function mapLegacyEntryName(name: string): string {
  return name.endsWith(".nugget.json")
    ? name.replace(/\.nugget\.json$/u, ".donna.json")
    : name;
}

function copyLegacyTree(legacyPath: string, donnaPath: string): void {
  const stats = statSync(legacyPath);
  if (stats.isDirectory()) {
    mkdirSync(donnaPath, { recursive: true });
    for (const entry of readdirSync(legacyPath)) {
      copyLegacyTree(
        join(legacyPath, entry),
        join(donnaPath, mapLegacyEntryName(entry)),
      );
    }
    return;
  }

  if (!existsSync(donnaPath)) {
    copyFileSync(legacyPath, donnaPath);
  }
}

export function migrateLegacySaveDir(
  saveDir: string,
  legacySaveDir = LEGACY_SAVE_DIR,
): void {
  if (saveDir === legacySaveDir || !existsSync(legacySaveDir)) {
    return;
  }

  mkdirSync(saveDir, { recursive: true });
  for (const entry of readdirSync(legacySaveDir)) {
    copyLegacyTree(
      join(legacySaveDir, entry),
      join(saveDir, mapLegacyEntryName(entry)),
    );
  }
}

interface Fact {
  key: string;
  value: string;
  hits: number;
  last_hit_session: string;
}

interface BankData {
  memory: ComplexVector;
  vocabKeys: ComplexVector[];
  vocabNorm: Float64Array[];
  sentKeys: ComplexVector[];
  roleKeys: ComplexVector[];
}

interface EnsembleData {
  banks: BankData[];
}

interface DonnaFile {
  version: number;
  name: string;
  D: number;
  banks: number;
  ensembles: number;
  max_facts: number;
  facts: Fact[];
  config: {
    sharpen_p: number;
    corvacs_a: number;
    temp_T: number;
    orth_iters: number;
  };
}

export class Donna {
  readonly name: string;
  readonly D: number;
  readonly banks: number;
  readonly ensembles: number;
  readonly graph: DonnaGraph;
  autoSave: boolean;
  saveDir: string;
  maxFacts: number;

  private _sharpenP = 1.0;
  private _corvacsA = 0.0;
  private _tempT = 0.9;
  private _orthIters = 1;
  private _orthStep = 0.4;
  private _fuzzyThreshold = 0.55;

  private _facts: Fact[] = [];
  private _E: EnsembleData[] | null = null;
  private _vocabWords: string[] = [];
  private _tagToPos: Map<string, number> = new Map();
  private _dirty = false;

  constructor(opts: {
    name: string;
    D?: number;
    banks?: number;
    ensembles?: number;
    autoSave?: boolean;
    saveDir?: string;
    maxFacts?: number;
  }) {
    this.name = opts.name;
    this.D = opts.D ?? 16384;
    this.banks = opts.banks ?? 4;
    this.ensembles = opts.ensembles ?? 1;
    this.autoSave = opts.autoSave ?? true;
    this.saveDir = opts.saveDir ?? DEFAULT_SAVE_DIR;
    if (!opts.saveDir || opts.saveDir === DEFAULT_SAVE_DIR) {
      migrateLegacySaveDir(this.saveDir);
    }
    this.maxFacts = opts.maxFacts ?? 0;
    this.graph = new DonnaGraph(this.saveDir, this.name, this.D);
  }

  remember(key: string, value: string, noteMeta?: GraphNoteMetaInput): void {
    key = key.trim();
    value = value.trim();
    if (!key || !value) return;

    let fact = this._facts.find((entry) => entry.key.toLowerCase() === key.toLowerCase());
    if (!fact) {
      fact = { key, value, hits: 0, last_hit_session: "" };
      this._facts.push(fact);
    } else {
      fact.key = key;
      fact.value = value;
    }

    if (this.maxFacts > 0 && this._facts.length > this.maxFacts) {
      const evicted = this._facts.slice(0, this._facts.length - this.maxFacts);
      this._facts = this._facts.slice(-this.maxFacts);
      for (const oldFact of evicted) {
        this.graph.removeFactNote(oldFact.key);
      }
    }

    this._syncFactNote(fact, noteMeta);
    this._dirty = true;
    if (this.autoSave) this.save();
  }

  recall(
    query: string,
    sessionId = "",
  ): { answer: string | null; confidence: number; margin: number; found: boolean; key: string } {
    const empty = { answer: null, confidence: 0, margin: 0, found: false, key: "" };
    if (this._facts.length === 0) return empty;

    if (this._dirty || this._E === null) {
      this._rebuild();
      this._dirty = false;
    }

    const tag = this._resolveTag(query);
    if (!tag || !this._tagToPos.has(tag)) return empty;

    const { word, probs } = this._decode(tag);

    let top1 = -Infinity;
    let top2 = -Infinity;
    for (let i = 0; i < probs.length; i++) {
      if (probs[i] > top1) {
        top2 = top1;
        top1 = probs[i];
      } else if (probs[i] > top2) {
        top2 = probs[i];
      }
    }
    const confidence = top1;
    const margin = top2 === -Infinity ? top1 : top1 - top2;

    if (sessionId) {
      const pos = this._tagToPos.get(tag)!;
      const fact = this._facts[pos];
      if (fact.last_hit_session !== sessionId) {
        fact.hits += 1;
        fact.last_hit_session = sessionId;
        this._syncFactNote(fact);
        if (this.autoSave) this.save();
      }
    }

    return { answer: word, confidence, margin, found: true, key: tag };
  }

  forget(key: string): boolean {
    const lower = key.toLowerCase().trim();
    const before = this._facts.length;
    this._facts = this._facts.filter((fact) => fact.key.toLowerCase() !== lower);
    const removed = this._facts.length < before;
    if (removed) {
      this.graph.removeFactNote(key);
      this._dirty = true;
      if (this.autoSave) this.save();
    }
    return removed;
  }

  facts(): Array<{ key: string; value: string; hits: number }> {
    return this._facts.map((fact) => ({
      key: fact.key,
      value: fact.value,
      hits: fact.hits || 0,
    }));
  }

  listNotes(opts?: NoteFilterOptions): MemoryNote[] {
    return this.graph.listNotes(opts);
  }

  getNote(noteId: string): MemoryNote | null {
    return this.graph.getNote(noteId);
  }

  createNote(
    title: string,
    content: string,
    tags: string[] = [],
    meta?: GraphNoteMetaInput,
  ): MemoryNote {
    return this.graph.createNote(title, content, tags, meta);
  }

  editNote(
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
    const previous = this.graph.getNote(noteId);
    const updated = this.graph.editNote(noteId, newContent, updates);
    if (!updated) return null;

    if (updated.kind === "fact") {
      const sourceKey = previous?.sourceKey || updated.sourceKey || updated.title;
      const fact = this._facts.find((entry) => entry.key.toLowerCase() === sourceKey.toLowerCase());
      if (fact) {
        fact.key = updated.title;
        fact.value = updated.content;
        this._dirty = true;
        if (this.autoSave) this.save();
      }
    }

    return updated;
  }

  updateNote(noteId: string, updates: Partial<Omit<MemoryNote, "id" | "donnaName">>): MemoryNote | null {
    const previous = this.graph.getNote(noteId);
    const updated = this.graph.updateNote(noteId, updates);
    if (!updated) return null;
    if (updated.kind === "fact") {
      const sourceKey = previous?.sourceKey || updated.sourceKey || updated.title;
      const fact = this._facts.find((entry) => entry.key.toLowerCase() === sourceKey.toLowerCase());
      if (fact) {
        fact.key = updated.title;
        fact.value = updated.content;
        fact.hits = updated.hits;
        fact.last_hit_session = updated.lastHitSession;
        this._dirty = true;
        if (this.autoSave) this.save();
      }
    }
    return updated;
  }

  deleteNote(noteId: string, hard = false): boolean {
    const note = this.graph.getNote(noteId);
    if (!note) return false;
    const deleted = this.graph.deleteNote(noteId, hard);
    if (!deleted) return false;

    if (note.kind === "fact" && note.sourceKey) {
      this._facts = this._facts.filter((fact) => fact.key.toLowerCase() !== note.sourceKey!.toLowerCase());
      this._dirty = true;
      if (this.autoSave) this.save();
    }

    return true;
  }

  addLink(note1: string, note2: string, reason: string): boolean {
    const from = this._resolveNoteRef(note1);
    const to = this._resolveNoteRef(note2);
    if (!from || !to) return false;
    return this.graph.addLink(from.id, to.id, reason);
  }

  mergeNotes(target: string, source: string, reason: string): MemoryNote | null {
    const targetNote = this._resolveNoteRef(target);
    const sourceNote = this._resolveNoteRef(source);
    if (!targetNote || !sourceNote) return null;

    const merged = this.graph.mergeNotes(targetNote.id, sourceNote.id, reason);
    if (!merged) return null;

    if (sourceNote.kind === "fact" && sourceNote.sourceKey) {
      this._facts = this._facts.filter((fact) =>
        fact.key.toLowerCase() !== sourceNote.sourceKey!.toLowerCase()
      );
    }

    if (merged.kind === "fact" && merged.sourceKey) {
      const fact = this._facts.find((entry) => entry.key.toLowerCase() === merged.sourceKey!.toLowerCase());
      if (fact) {
        fact.key = merged.title;
        fact.value = merged.content;
      }
    }

    this._dirty = true;
    if (this.autoSave) this.save();
    return merged;
  }

  searchNotes(query: string, limit = 5, opts?: NoteFilterOptions): SearchNotesResult[] {
    return this.graph.searchNotes(query, limit, opts);
  }

  clear(): void {
    this._facts = [];
    this._E = null;
    this._vocabWords = [];
    this._tagToPos = new Map();
    this._dirty = false;
    this.graph.removeAllNotes();
    if (this.autoSave) this.save();
  }

  status(): {
    name: string;
    fact_count: number;
    dimension: number;
    banks: number;
    ensembles: number;
    capacity_used_pct: number;
    capacity_warning: string;
    max_facts: number;
    note_count: number;
  } {
    const capacityEst = this.banks * Math.floor(Math.sqrt(this.D));
    const usedPct = capacityEst > 0 ? (this._facts.length / capacityEst) * 100 : 0;
    let capacityWarning = "";
    if (usedPct > 90) capacityWarning = "CRITICAL: nearly full";
    else if (usedPct > 80) capacityWarning = "WARNING: approaching capacity";

    return {
      name: this.name,
      fact_count: this._facts.length,
      dimension: this.D,
      banks: this.banks,
      ensembles: this.ensembles,
      capacity_used_pct: Math.round(usedPct * 10) / 10,
      capacity_warning: capacityWarning,
      max_facts: this.maxFacts,
      note_count: this.graph.listNotes({ includeHidden: true }).length,
    };
  }

  save(path?: string): string {
    if (!path) {
      mkdirSync(this.saveDir, { recursive: true });
      path = join(this.saveDir, `${this.name}.donna.json`);
    }

    const data: DonnaFile = {
      version: 4,
      name: this.name,
      D: this.D,
      banks: this.banks,
      ensembles: this.ensembles,
      max_facts: this.maxFacts,
      facts: this._facts,
      config: {
        sharpen_p: this._sharpenP,
        corvacs_a: this._corvacsA,
        temp_T: this._tempT,
        orth_iters: this._orthIters,
      },
    };

    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data));
    renameSync(tmpPath, path);
    return path;
  }

  static load(path: string, opts?: { autoSave?: boolean }): Donna {
    const raw = readFileSync(path, "utf-8");
    const data: DonnaFile = JSON.parse(raw);

    const donna = new Donna({
      name: data.name,
      D: data.D,
      banks: data.banks,
      ensembles: data.ensembles ?? 1,
      autoSave: opts?.autoSave ?? true,
      saveDir: join(path, ".."),
      maxFacts: data.max_facts ?? 0,
    });

    const cfg = data.config || ({} as Partial<DonnaFile["config"]>);
    donna._sharpenP = cfg.sharpen_p ?? donna._sharpenP;
    donna._corvacsA = cfg.corvacs_a ?? donna._corvacsA;
    donna._tempT = cfg.temp_T ?? donna._tempT;
    donna._orthIters = cfg.orth_iters ?? donna._orthIters;

    const migratedFacts = new Map<string, Fact>();
    let didMigrateKeys = false;
    for (const fact of data.facts || []) {
      const scopedKey = hasScopedKeyPrefix(fact.key)
        ? fact.key
        : prefixScopedKey(fact.key, fact.value);
      if (scopedKey !== fact.key) {
        didMigrateKeys = true;
        donna.graph.removeFactNote(fact.key);
      }

      const existing = migratedFacts.get(scopedKey.toLowerCase());
      if (!existing) {
        migratedFacts.set(scopedKey.toLowerCase(), {
          key: scopedKey,
          value: fact.value,
          hits: fact.hits ?? 0,
          last_hit_session: fact.last_hit_session ?? "",
        });
        continue;
      }

      existing.key = scopedKey;
      existing.value = fact.value;
      existing.hits = Math.max(existing.hits, fact.hits ?? 0);
      existing.last_hit_session = fact.last_hit_session || existing.last_hit_session;
    }

    donna._facts = [...migratedFacts.values()];

    donna._syncGraphFromFacts();
    if (donna._facts.length > 0) {
      donna._rebuild();
    }
    if (didMigrateKeys) {
      donna.save(path);
    }
    return donna;
  }

  private _syncFactNote(fact: Fact, noteMeta?: GraphNoteMetaInput): void {
    this.graph.upsertFactNote(fact.key, fact.value, {
      hits: fact.hits,
      lastHitSession: fact.last_hit_session,
      noteMeta,
    });
  }

  private _syncGraphFromFacts(): void {
    for (const fact of this._facts) {
      this._syncFactNote(fact);
    }
  }

  private _resolveNoteRef(ref: string): MemoryNote | null {
    return this.graph.getNote(ref) || this.graph.findNoteByTitle(ref);
  }

  private _rebuild(): void {
    if (this._facts.length === 0) {
      this._E = null;
      this._vocabWords = [];
      this._tagToPos = new Map();
      return;
    }

    const seen = new Set<string>();
    const vocab: string[] = [];
    for (const fact of this._facts) {
      if (!seen.has(fact.value)) {
        vocab.push(fact.value);
        seen.add(fact.value);
      }
    }
    this._vocabWords = vocab;

    this._tagToPos = new Map();
    for (let i = 0; i < this._facts.length; i++) {
      this._tagToPos.set(this._facts[i].key, i);
    }

    const L = this._facts.length;
    const seed = seedFromName(this.name);
    const rng = mulberry32(seed);
    const V = vocab.length;
    const idxByWord = new Map<string, number>();
    for (let i = 0; i < V; i++) idxByWord.set(vocab[i], i);

    const itemsByBank: Array<Array<{ sid: number; pos: number; word: string }>> = [];
    for (let bank = 0; bank < this.banks; bank++) itemsByBank.push([]);
    for (let i = 0; i < this._facts.length; i++) {
      itemsByBank[i % this.banks].push({
        sid: 0,
        pos: i,
        word: this._facts[i].value,
      });
    }

    const ensembles: EnsembleData[] = [];
    for (let e = 0; e < this.ensembles; e++) {
      let vocabKeys = makeVocabKeys(V, this.D, rng);
      if (this._orthIters > 0) {
        vocabKeys = orthogonalize(vocabKeys, this._orthIters, this._orthStep);
      }
      const vocabNorm = stackAndUnitNorm(vocabKeys);
      const sentKeys = makeVocabKeys(1, this.D, rng);
      const roleKeys = makeRoleKeys(this.D, L);

      const banks: BankData[] = [];
      for (let b = 0; b < this.banks; b++) {
        const bindings: ComplexVector[] = [];
        for (const item of itemsByBank[b]) {
          const sKey = sentKeys[item.sid];
          const rKey = roleKeys[item.pos];
          const wKey = vocabKeys[idxByWord.get(item.word)!];
          bindings.push(bind(bind(sKey, rKey), wKey));
        }

        let memory: ComplexVector;
        if (bindings.length > 0) {
          const re = new Float64Array(this.D);
          const im = new Float64Array(this.D);
          for (const binding of bindings) {
            for (let d = 0; d < this.D; d++) {
              re[d] += binding.re[d];
              im[d] += binding.im[d];
            }
          }
          const scale = 1 / Math.sqrt(bindings.length);
          for (let d = 0; d < this.D; d++) {
            re[d] *= scale;
            im[d] *= scale;
          }
          memory = { re, im };
        } else {
          memory = {
            re: new Float64Array(this.D),
            im: new Float64Array(this.D),
          };
        }

        banks.push({ memory, vocabKeys, vocabNorm, sentKeys, roleKeys });
      }

      ensembles.push({ banks });
    }

    this._E = ensembles;
  }

  private _decode(tag: string): { word: string; sims: Float64Array; probs: Float64Array } {
    const pos = this._tagToPos.get(tag)!;
    const sid = 0;
    const vocabSize = this._vocabWords.length;
    const simsSum = new Float64Array(vocabSize);

    for (const ensemble of this._E!) {
      for (const bank of ensemble.banks) {
        let recovered = unbind(unbind(bank.memory, bank.sentKeys[sid]), bank.roleKeys[pos]);
        recovered = corvacsLite(sharpen(recovered, this._sharpenP), this._corvacsA);

        const rec2 = new Float64Array(this.D * 2);
        rec2.set(recovered.re, 0);
        rec2.set(recovered.im, this.D);
        let norm = 0;
        for (let d = 0; d < this.D * 2; d++) norm += rec2[d] * rec2[d];
        norm = 1 / (Math.sqrt(norm) + 1e-12);
        for (let d = 0; d < this.D * 2; d++) rec2[d] *= norm;

        for (let v = 0; v < vocabSize; v++) {
          const row = bank.vocabNorm[v];
          let dot = 0;
          for (let d = 0; d < this.D * 2; d++) dot += row[d] * rec2[d];
          simsSum[v] += dot;
        }
      }
    }

    const probs = softmaxTemp(simsSum, this._tempT);
    let bestIdx = 0;
    for (let i = 1; i < vocabSize; i++) {
      if (probs[i] > probs[bestIdx]) bestIdx = i;
    }

    return {
      word: this._vocabWords[bestIdx],
      sims: simsSum,
      probs,
    };
  }

  private _resolveTag(query: string): string {
    if (this._tagToPos.size === 0) return "";
    const text = query.toLowerCase().trim();
    const tags = [...this._tagToPos.keys()];

    for (const tag of tags) {
      if (tag.toLowerCase() === text) return tag;
    }

    for (const tag of tags) {
      if (tag.toLowerCase().includes(text) || text.includes(tag.toLowerCase())) return tag;
    }

    let best = "";
    let bestScore = 0;
    for (const tag of tags) {
      const score = sequenceMatchRatio(text, tag.toLowerCase());
      if (score > bestScore) {
        best = tag;
        bestScore = score;
      }
    }

    return bestScore >= this._fuzzyThreshold ? best : "";
  }
}

function sequenceMatchRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const matches = countMatches(a, b);
  return (2 * matches) / (a.length + b.length);
}

function countMatches(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let total = 0;
  const usedA = new Set<number>();
  const usedB = new Set<number>();

  while (true) {
    let bestLen = 0;
    let bestI = 0;
    let bestJ = 0;

    for (let i = 0; i < m; i++) {
      if (usedA.has(i)) continue;
      for (let j = 0; j < n; j++) {
        if (usedB.has(j)) continue;
        let len = 0;
        while (
          i + len < m &&
          j + len < n &&
          !usedA.has(i + len) &&
          !usedB.has(j + len) &&
          a[i + len] === b[j + len]
        ) {
          len++;
        }
        if (len > bestLen) {
          bestLen = len;
          bestI = i;
          bestJ = j;
        }
      }
    }

    if (bestLen === 0) break;
    total += bestLen;
    for (let k = 0; k < bestLen; k++) {
      usedA.add(bestI + k);
      usedB.add(bestJ + k);
    }
  }

  return total;
}
