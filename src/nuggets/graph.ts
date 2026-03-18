import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  bind,
  makeKeyFromText,
  makeRoleKeys,
  softmaxTemp,
  stackAndUnitNorm,
  type ComplexVector,
} from "./core.js";

export type MemoryScope = "self" | "user" | "shared" | "project" | "session";
export type MemoryType =
  | "fact"
  | "note"
  | "preference"
  | "reflection"
  | "self_model"
  | "project"
  | "relationship"
  | "style";
export type MemorySource =
  | "explicit_user"
  | "agent_reflection"
  | "tool_observation"
  | "inferred"
  | "system";
export type MemoryStability = "temporary" | "durable";

export interface NoteLink {
  to: string;
  reason: string;
  createdAt: string;
}

export interface NoteVectorSpec {
  seed: number;
  basis: string[];
}

export interface NoteMetadata {
  subject: string;
  scope: MemoryScope;
  type: MemoryType;
  source: MemorySource;
  confidence: number;
  stability: MemoryStability;
}

export interface MemoryNote extends NoteMetadata {
  id: string;
  nuggetName: string;
  title: string;
  content: string;
  tags: string[];
  links: NoteLink[];
  vector: NoteVectorSpec;
  hidden: boolean;
  kind: "fact" | "note";
  sourceKey?: string;
  hits: number;
  lastHitSession: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  lastRewrittenAt?: string;
  archivedAt?: string;
}

interface GraphFile {
  version: number;
  notes: MemoryNote[];
}

export interface NoteFilterOptions {
  includeHidden?: boolean;
  subject?: string;
  scope?: MemoryScope;
  type?: MemoryType;
}

export interface SearchNotesResult {
  note: MemoryNote;
  score: number;
  vectorScore: number;
  textScore: number;
}

export interface GraphNoteMetaInput {
  subject?: string;
  scope?: MemoryScope;
  type?: MemoryType;
  source?: MemorySource;
  confidence?: number;
  stability?: MemoryStability;
}

const SCOPED_KEY_PREFIX = /^(user|self|shared|project|session):/i;
const SELF_HINTS = [
  "assistant",
  "astra",
  "self",
  "identity",
  "persona",
];
const USER_HINTS = [
  "user",
  "esteban",
  "friend",
  "denis",
  "business",
  "preference",
  "likes",
  "avoid",
  "products",
];
const SHARED_HINTS = [
  "shared",
  "server",
  "project",
  "workspace",
  "repo",
  "memory_system",
  "system",
  "status",
  "reaction",
  "tool",
  "command",
  "cmd",
  "path",
  "file",
  "edited",
  "task",
];

function defaultGraph(): GraphFile {
  return { version: 3, notes: [] };
}

function normaliseWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, "-");
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "i",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "with",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9/_:-]{2,}/g) || [])
    .filter((token) => !STOP_WORDS.has(token));
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function clampConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0.7;
  return Math.max(0, Math.min(1, confidence));
}

function hasHint(text: string, hints: string[]): boolean {
  return hints.some((hint) => text.includes(hint));
}

export function hasScopedKeyPrefix(key: string): boolean {
  return SCOPED_KEY_PREFIX.test(key.trim());
}

export function inferScopeFromLegacyText(
  key: string,
  content = "",
  tags: string[] = [],
): MemoryScope {
  const lowerKey = key.trim().toLowerCase();
  if (lowerKey.startsWith("self:")) return "self";
  if (lowerKey.startsWith("user:")) return "user";
  if (lowerKey.startsWith("shared:")) return "shared";
  if (lowerKey.startsWith("project:")) return "project";
  if (lowerKey.startsWith("session:")) return "session";
  if (lowerKey.startsWith("_")) return "shared";

  const text = `${lowerKey} ${content.toLowerCase()} ${tags.join(" ").toLowerCase()}`;

  if (hasHint(lowerKey, ["assistant_name", "assistant_style", "assistant_tone", "assistant_voice"])) {
    return "self";
  }
  if (hasHint(lowerKey, ["user_name", "user_tone", "user_style", "user_voice"])) {
    return "user";
  }
  if (hasHint(text, SHARED_HINTS)) {
    return lowerKey.includes("project") ? "project" : "shared";
  }
  if (hasHint(text, SELF_HINTS)) {
    return "self";
  }
  if (hasHint(text, USER_HINTS)) {
    return "user";
  }

  return "user";
}

export function prefixScopedKey(
  key: string,
  content = "",
  tags: string[] = [],
): string {
  const trimmed = key.trim();
  if (!trimmed) return trimmed;
  if (hasScopedKeyPrefix(trimmed)) return trimmed;
  const scope = inferScopeFromLegacyText(trimmed, content, tags);
  return `${scope}:${trimmed}`;
}

function scoreTextMatch(note: MemoryNote, query: string): number {
  const haystack = [
    note.title,
    note.content,
    note.tags.join(" "),
    note.subject,
    note.scope,
    note.type,
  ].join("\n").toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 0;

  let score = 0;
  if (haystack.includes(q)) score += 0.75;
  const qTokens = unique(tokenize(q));
  const noteTokens = new Set(tokenize(haystack));
  let overlap = 0;
  for (const token of qTokens) {
    if (noteTokens.has(token)) overlap++;
  }
  if (qTokens.length > 0) {
    score += overlap / qTokens.length;
  }
  return score;
}

function cosineFromRows(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

function titleToTags(title: string): string[] {
  const lower = title.toLowerCase();
  const tags: string[] = [];
  if (lower.includes("pref:")) tags.push("preferences");
  if (lower.includes("learn")) tags.push("learnings");
  if (lower.includes("/") || lower.includes(".")) tags.push("files");
  if (lower.includes("reflect")) tags.push("reflection");
  if (lower.includes("style")) tags.push("style");
  return tags;
}

function dedupeLinks(links: NoteLink[]): NoteLink[] {
  const seen = new Set<string>();
  const result: NoteLink[] = [];
  for (const link of links) {
    const key = `${link.to}::${link.reason.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(link);
  }
  return result;
}

function inferMetadata(
  note: Pick<MemoryNote, "kind" | "title" | "content" | "tags" | "sourceKey">,
): NoteMetadata {
  const key = (note.sourceKey || note.title).trim().toLowerCase();
  let subject = "shared:project";
  let scope = inferScopeFromLegacyText(
    note.sourceKey || note.title,
    note.content,
    note.tags,
  );
  if (scope === "self") {
    subject = "assistant:self";
  } else if (scope === "user") {
    subject = "user:primary";
  } else if (scope === "session") {
    subject = "session:current";
  } else {
    subject = "shared:project";
  }

  let type: MemoryType = note.kind === "fact" ? "fact" : "note";
  if (key.includes(":pref:") || key.startsWith("pref:") || note.tags.includes("preferences")) {
    type = "preference";
  } else if (key.includes("reflect:") || note.tags.includes("reflection")) {
    type = "reflection";
  } else if (scope === "self") {
    type = key.includes("style") ? "style" : "self_model";
  } else if (scope === "project" || key.startsWith("project:")) {
    type = "project";
  }

  let source: MemorySource = "explicit_user";
  if (key.includes("file:") || key.includes("edited:")) {
    source = "tool_observation";
  } else if (type === "reflection" || type === "self_model" || type === "style") {
    source = scope === "self" ? "agent_reflection" : "inferred";
  }

  let stability: MemoryStability = "durable";
  if (scope === "session") stability = "temporary";
  if (key.startsWith("_") || key.includes("tmp") || key.includes("scratch")) {
    stability = "temporary";
  }

  let confidence = 0.9;
  if (source === "tool_observation") confidence = 0.98;
  if (source === "agent_reflection") confidence = 0.75;
  if (source === "inferred") confidence = 0.6;

  return {
    subject,
    scope,
    type,
    source,
    confidence,
    stability,
  };
}

function mergeMetadata(
  note: Pick<MemoryNote, "kind" | "title" | "content" | "tags" | "sourceKey">,
  current?: Partial<NoteMetadata>,
  updates?: GraphNoteMetaInput,
): NoteMetadata {
  const inferred = inferMetadata(note);
  return {
    subject: updates?.subject ?? current?.subject ?? inferred.subject,
    scope: updates?.scope ?? current?.scope ?? inferred.scope,
    type: updates?.type ?? current?.type ?? inferred.type,
    source: updates?.source ?? current?.source ?? inferred.source,
    confidence: clampConfidence(updates?.confidence ?? current?.confidence ?? inferred.confidence),
    stability: updates?.stability ?? current?.stability ?? inferred.stability,
  };
}

function matchesFilters(note: MemoryNote, opts?: NoteFilterOptions): boolean {
  if (!opts) return !note.hidden;
  if (!opts.includeHidden && note.hidden) return false;
  if (opts.subject && note.subject !== opts.subject) return false;
  if (opts.scope && note.scope !== opts.scope) return false;
  if (opts.type && note.type !== opts.type) return false;
  return true;
}

function normalizeGraph(graph: GraphFile): GraphFile {
  const notes = (graph.notes || []).map((rawNote) => {
    const legacyNote = rawNote as MemoryNote & { nuggetName?: string; donnaName?: string };
    const note = {
      ...legacyNote,
      nuggetName: legacyNote.nuggetName ?? legacyNote.donnaName ?? "",
    };
    const legacyUnscoped =
      graph.version < 3 &&
      !hasScopedKeyPrefix(note.sourceKey || note.title || "");
    const migratedTitle =
      legacyUnscoped && note.kind === "fact"
        ? prefixScopedKey(note.title || "", note.content, note.tags || [])
        : note.title?.trim?.() ?? "";
    const migratedSourceKey =
      legacyUnscoped && note.kind === "fact" && note.sourceKey
        ? prefixScopedKey(note.sourceKey, note.content, note.tags || [])
        : note.sourceKey;
    const metadata = legacyUnscoped
      ? mergeMetadata(
          {
            ...note,
            title: migratedTitle,
            sourceKey: migratedSourceKey,
          },
          undefined,
        )
      : mergeMetadata(note, note);
    return {
      ...note,
      nuggetName: note.nuggetName,
      title: migratedTitle,
      content: normaliseWhitespace(note.content ?? ""),
      tags: unique((note.tags || []).map(normalizeTag)).filter(Boolean),
      links: dedupeLinks(note.links || []),
      vector: note.vector || { seed: 0, basis: [] },
      hidden: !!note.hidden,
      kind: note.kind === "fact" ? "fact" : "note",
      sourceKey: migratedSourceKey,
      hits: note.hits ?? 0,
      lastHitSession: note.lastHitSession ?? "",
      createdAt: note.createdAt ?? new Date().toISOString(),
      updatedAt: note.updatedAt ?? note.createdAt ?? new Date().toISOString(),
      lastAccessedAt: note.lastAccessedAt ?? note.updatedAt ?? note.createdAt ?? new Date().toISOString(),
      ...metadata,
    } satisfies MemoryNote;
  });
  return { version: 3, notes };
}

export class NuggetGraph {
  private readonly graphDir: string;
  private readonly graphPath: string;

  constructor(
    private readonly saveDir: string,
    private readonly nuggetName: string,
    private readonly D: number,
  ) {
    this.graphDir = join(saveDir, "graph");
    this.graphPath = join(this.graphDir, "graph.json");
  }

  listNotes(opts?: NoteFilterOptions): MemoryNote[] {
    const graph = this.load();
    return graph.notes
      .filter((note) => note.nuggetName === this.nuggetName)
      .filter((note) => matchesFilters(note, opts))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  getNote(id: string): MemoryNote | null {
    return this.load().notes.find(
      (note) => note.nuggetName === this.nuggetName && note.id === id,
    ) || null;
  }

  findNoteByTitle(title: string): MemoryNote | null {
    const lower = title.trim().toLowerCase();
    return this.listNotes({ includeHidden: true }).find((note) => (
      note.title.trim().toLowerCase() === lower || note.id === title
    )) || null;
  }

  upsertFactNote(
    key: string,
    value: string,
    meta?: { hits?: number; lastHitSession?: string; noteMeta?: GraphNoteMetaInput },
  ): MemoryNote {
    const graph = this.load();
    const now = new Date().toISOString();
    const existing = graph.notes.find((note) =>
      note.nuggetName === this.nuggetName &&
      note.kind === "fact" &&
      note.sourceKey?.toLowerCase() === key.toLowerCase()
    );

    const base = existing ?? {
      id: `fact-${this.nuggetName}-${randomUUID().slice(0, 8)}`,
      nuggetName: this.nuggetName,
      title: key.trim(),
      content: "",
      tags: [],
      links: [],
      vector: { seed: 0, basis: [] },
      hidden: false,
      kind: "fact" as const,
      sourceKey: key.trim(),
      hits: 0,
      lastHitSession: "",
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      ...inferMetadata({
        kind: "fact",
        title: key.trim(),
        content: value,
        tags: [],
        sourceKey: key.trim(),
      }),
    };

    const metadata = mergeMetadata(
      {
        kind: "fact",
        title: key.trim(),
        content: value,
        tags: base.tags,
        sourceKey: key.trim(),
      },
      existing,
      meta?.noteMeta,
    );

    const note: MemoryNote = {
      ...base,
      title: key.trim(),
      content: normaliseWhitespace(value),
      hidden: false,
      sourceKey: key.trim(),
      tags: unique([
        ...base.tags,
        this.nuggetName,
        `scope:${metadata.scope}`,
        `type:${metadata.type}`,
        ...titleToTags(key),
      ]).map(normalizeTag).filter(Boolean),
      hits: meta?.hits ?? base.hits,
      lastHitSession: meta?.lastHitSession ?? base.lastHitSession,
      updatedAt: now,
      ...metadata,
      vector: { seed: 0, basis: [] },
    };
    note.vector = this.buildVectorSpec(note);

    if (!existing) {
      graph.notes.push(note);
    } else {
      Object.assign(existing, note);
    }

    this.save(graph);
    return note;
  }

  createNote(
    title: string,
    content: string,
    tags: string[] = [],
    meta?: GraphNoteMetaInput,
  ): MemoryNote {
    const graph = this.load();
    const now = new Date().toISOString();
    const baseNote = {
      kind: "note" as const,
      title: title.trim(),
      content: normaliseWhitespace(content),
      tags: unique([...titleToTags(title), ...tags.map(normalizeTag)]).filter(Boolean),
      sourceKey: undefined,
    };
    const metadata = mergeMetadata(baseNote, undefined, meta);

    const note: MemoryNote = {
      id: `note-${this.nuggetName}-${randomUUID().slice(0, 8)}`,
      nuggetName: this.nuggetName,
      title: baseNote.title,
      content: baseNote.content,
      tags: unique([
        this.nuggetName,
        ...baseNote.tags,
        `scope:${metadata.scope}`,
        `type:${metadata.type}`,
      ]).filter(Boolean),
      links: [],
      vector: { seed: 0, basis: [] },
      hidden: false,
      kind: "note",
      hits: 0,
      lastHitSession: "",
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      ...metadata,
    };
    note.vector = this.buildVectorSpec(note);
    graph.notes.push(note);
    this.save(graph);
    return note;
  }

  editNote(
    noteId: string,
    newContent: string,
    updates?: { tags?: string[]; title?: string; hidden?: boolean; rewrittenAt?: string; noteMeta?: GraphNoteMetaInput },
  ): MemoryNote | null {
    const graph = this.load();
    const note = graph.notes.find((entry) =>
      entry.nuggetName === this.nuggetName && entry.id === noteId
    );
    if (!note) return null;

    note.content = normaliseWhitespace(newContent);
    if (updates?.title) note.title = updates.title.trim();
    if (note.kind === "fact") note.sourceKey = note.title;
    if (updates?.tags) note.tags = unique(updates.tags.map(normalizeTag)).filter(Boolean);
    if (typeof updates?.hidden === "boolean") note.hidden = updates.hidden;
    if (updates?.rewrittenAt) note.lastRewrittenAt = updates.rewrittenAt;
    Object.assign(
      note,
      mergeMetadata(
        note,
        note,
        updates?.noteMeta,
      ),
    );
    note.tags = unique([
      ...note.tags,
      `scope:${note.scope}`,
      `type:${note.type}`,
    ]).map(normalizeTag).filter(Boolean);
    note.updatedAt = new Date().toISOString();
    note.vector = this.buildVectorSpec(note);
    this.save(graph);
    return note;
  }

  updateNote(noteId: string, updates: Partial<Omit<MemoryNote, "id" | "nuggetName">>): MemoryNote | null {
    const graph = this.load();
    const note = graph.notes.find((entry) =>
      entry.nuggetName === this.nuggetName && entry.id === noteId
    );
    if (!note) return null;

    if (typeof updates.title === "string") note.title = updates.title.trim();
    if (typeof updates.content === "string") note.content = normaliseWhitespace(updates.content);
    if (note.kind === "fact") note.sourceKey = note.title;
    if (updates.tags) note.tags = unique(updates.tags.map(normalizeTag)).filter(Boolean);
    if (updates.links) note.links = dedupeLinks(updates.links);
    if (typeof updates.hidden === "boolean") note.hidden = updates.hidden;
    if (typeof updates.hits === "number") note.hits = updates.hits;
    if (typeof updates.lastHitSession === "string") note.lastHitSession = updates.lastHitSession;
    if (typeof updates.lastAccessedAt === "string") note.lastAccessedAt = updates.lastAccessedAt;
    if (typeof updates.lastRewrittenAt === "string") note.lastRewrittenAt = updates.lastRewrittenAt;
    if (typeof updates.archivedAt === "string") note.archivedAt = updates.archivedAt;
    if (typeof updates.kind === "string") note.kind = updates.kind;
    if (typeof updates.sourceKey === "string") note.sourceKey = updates.sourceKey;
    if (typeof updates.subject === "string") note.subject = updates.subject;
    if (typeof updates.scope === "string") note.scope = updates.scope;
    if (typeof updates.type === "string") note.type = updates.type;
    if (typeof updates.source === "string") note.source = updates.source;
    if (typeof updates.confidence === "number") note.confidence = clampConfidence(updates.confidence);
    if (typeof updates.stability === "string") note.stability = updates.stability;

    note.tags = unique([
      ...note.tags,
      `scope:${note.scope}`,
      `type:${note.type}`,
    ]).map(normalizeTag).filter(Boolean);
    note.updatedAt = new Date().toISOString();
    note.vector = this.buildVectorSpec(note);
    this.save(graph);
    return note;
  }

  removeFactNote(key: string): boolean {
    const graph = this.load();
    const before = graph.notes.length;
    graph.notes = graph.notes.filter((note) => !(
      note.nuggetName === this.nuggetName &&
      note.kind === "fact" &&
      note.sourceKey?.toLowerCase() === key.toLowerCase()
    ));
    if (graph.notes.length === before) return false;
    this.removeDanglingLinks(graph);
    this.save(graph);
    return true;
  }

  addLink(fromId: string, toId: string, reason: string): boolean {
    if (fromId === toId) return false;
    const graph = this.load();
    const from = graph.notes.find((note) => note.nuggetName === this.nuggetName && note.id === fromId);
    const to = graph.notes.find((note) => note.nuggetName === this.nuggetName && note.id === toId);
    if (!from || !to) return false;

    const timestamp = new Date().toISOString();
    from.links = dedupeLinks([...from.links, { to: to.id, reason: normaliseWhitespace(reason), createdAt: timestamp }]);
    to.links = dedupeLinks([...to.links, { to: from.id, reason: normaliseWhitespace(reason), createdAt: timestamp }]);
    from.vector = this.buildVectorSpec(from);
    to.vector = this.buildVectorSpec(to);
    from.updatedAt = timestamp;
    to.updatedAt = timestamp;
    this.save(graph);
    return true;
  }

  deleteNote(noteId: string, hard = false): boolean {
    const graph = this.load();
    const note = graph.notes.find((entry) => entry.nuggetName === this.nuggetName && entry.id === noteId);
    if (!note) return false;

    if (hard) {
      graph.notes = graph.notes.filter((entry) => entry.id !== noteId);
      this.removeDanglingLinks(graph);
      this.save(graph);
      return true;
    }

    note.hidden = true;
    note.archivedAt = new Date().toISOString();
    note.updatedAt = note.archivedAt;
    note.vector = this.buildVectorSpec(note);
    this.save(graph);
    return true;
  }

  removeAllNotes(): void {
    const graph = this.load();
    graph.notes = graph.notes.filter((note) => note.nuggetName !== this.nuggetName);
    this.removeDanglingLinks(graph);
    this.save(graph);
  }

  recordHit(noteId: string, sessionId = ""): void {
    const graph = this.load();
    const note = graph.notes.find((entry) => entry.nuggetName === this.nuggetName && entry.id === noteId);
    if (!note) return;
    if (!sessionId || note.lastHitSession !== sessionId) {
      note.hits += 1;
      note.lastHitSession = sessionId;
    }
    note.lastAccessedAt = new Date().toISOString();
    note.updatedAt = note.lastAccessedAt;
    this.save(graph);
  }

  mergeNotes(targetId: string, sourceId: string, reason: string): MemoryNote | null {
    if (targetId === sourceId) return null;
    const graph = this.load();
    const target = graph.notes.find((note) => note.nuggetName === this.nuggetName && note.id === targetId);
    const source = graph.notes.find((note) => note.nuggetName === this.nuggetName && note.id === sourceId);
    if (!target || !source) return null;

    const mergedLines = unique([
      ...target.content.split("\n").map((line) => line.trim()).filter(Boolean),
      ...source.content.split("\n").map((line) => line.trim()).filter(Boolean),
    ]);
    target.content = mergedLines.join("\n");
    target.tags = unique([...target.tags, ...source.tags]).map(normalizeTag).filter(Boolean);
    target.links = dedupeLinks([
      ...target.links,
      ...source.links.filter((link) => link.to !== target.id && link.to !== source.id),
    ]);
    target.hits += source.hits;
    target.updatedAt = new Date().toISOString();
    target.lastRewrittenAt = target.updatedAt;
    target.vector = this.buildVectorSpec(target);

    source.hidden = true;
    source.archivedAt = target.updatedAt;
    source.updatedAt = target.updatedAt;
    source.links = dedupeLinks([
      ...source.links.filter((link) => link.to !== target.id),
      { to: target.id, reason: normaliseWhitespace(reason), createdAt: target.updatedAt },
    ]);
    source.vector = this.buildVectorSpec(source);

    for (const note of graph.notes) {
      if (note.nuggetName !== this.nuggetName) continue;
      note.links = note.links.map((link) =>
        link.to === source.id ? { ...link, to: target.id } : link
      );
      note.links = dedupeLinks(note.links);
      note.vector = this.buildVectorSpec(note);
    }

    this.save(graph);
    return target;
  }

  searchNotes(query: string, limit = 5, opts?: NoteFilterOptions): SearchNotesResult[] {
    const notes = this.listNotes(opts).filter((note) => !note.hidden);
    if (notes.length === 0) return [];

    const queryVector = this.vectorFromBasis(this.buildQueryBasis(query, opts));
    const queryRow = stackAndUnitNorm([queryVector])[0];

    const scored = notes.map((note) => {
      const noteVector = this.vectorFromSpec(note.vector);
      const noteRow = stackAndUnitNorm([noteVector])[0];
      const vectorScore = (cosineFromRows(queryRow, noteRow) + 1) / 2;
      const textScore = scoreTextMatch(note, query);
      const metadataBoost =
        (note.stability === "durable" ? 0.05 : 0) +
        (note.scope === "user" || note.scope === "self" ? 0.03 : 0) +
        (note.confidence * 0.05);
      const score = (vectorScore * 0.42) + (Math.min(textScore, 1.5) / 1.5 * 0.48) + metadataBoost;
      return { note, score, vectorScore, textScore };
    }).sort((a, b) => b.score - a.score);

    const probs = softmaxTemp(new Float64Array(scored.map((entry) => entry.score)), 0.35);
    return scored.slice(0, limit).map((entry, index) => ({
      ...entry,
      score: probs[index] ?? entry.score,
    }));
  }

  private buildVectorSpec(
    note: Pick<MemoryNote, "id" | "title" | "content" | "tags" | "links" | "kind" | "subject" | "scope" | "type" | "source" | "stability">,
  ): NoteVectorSpec {
    const basis = this.buildNoteBasis(note);
    return {
      seed: basis.join("|").length,
      basis,
    };
  }

  private buildNoteBasis(
    note: Pick<MemoryNote, "id" | "title" | "content" | "tags" | "links" | "kind" | "subject" | "scope" | "type" | "source" | "stability">,
  ): string[] {
    const titleTokens = tokenize(note.title).slice(0, 4).map((token) => `title:${token}`);
    const contentTokens = tokenize(note.content).slice(0, 6).map((token) => `content:${token}`);
    const tagTokens = note.tags.slice(0, 6).map((tag) => `tag:${normalizeTag(tag)}`);
    const linkTokens = note.links.slice(0, 4).map((link) => `link:${link.to}`);
    return unique([
      `kind:${note.kind}`,
      `subject:${note.subject}`,
      `scope:${note.scope}`,
      `type:${note.type}`,
      `source:${note.source}`,
      `stability:${note.stability}`,
      `note:${note.id}`,
      ...titleTokens,
      ...contentTokens,
      ...tagTokens,
      ...linkTokens,
    ]).slice(0, 20);
  }

  private buildQueryBasis(query: string, opts?: NoteFilterOptions): string[] {
    const queryTokens = tokenize(query).slice(0, 10);
    const basis = queryTokens.length === 0
      ? [`query:${query.trim().toLowerCase()}`]
      : unique(queryTokens.map((token) => `query:${token}`));
    if (opts?.subject) basis.push(`subject:${opts.subject}`);
    if (opts?.scope) basis.push(`scope:${opts.scope}`);
    if (opts?.type) basis.push(`type:${opts.type}`);
    return unique(basis);
  }

  private vectorFromSpec(spec: NoteVectorSpec): ComplexVector {
    return this.vectorFromBasis(spec.basis);
  }

  private vectorFromBasis(basis: string[]): ComplexVector {
    const terms = basis.length > 0 ? basis : ["empty"];
    const roleKeys = makeRoleKeys(this.D, terms.length);
    const re = new Float64Array(this.D);
    const im = new Float64Array(this.D);

    for (let i = 0; i < terms.length; i++) {
      const tokenKey = makeKeyFromText(terms[i], this.D);
      const bound = bind(roleKeys[i], tokenKey);
      for (let d = 0; d < this.D; d++) {
        re[d] += bound.re[d];
        im[d] += bound.im[d];
      }
    }

    const scale = 1 / Math.sqrt(terms.length);
    for (let d = 0; d < this.D; d++) {
      re[d] *= scale;
      im[d] *= scale;
    }
    return { re, im };
  }

  private load(): GraphFile {
    if (!existsSync(this.graphPath)) return defaultGraph();
    try {
      return normalizeGraph(JSON.parse(readFileSync(this.graphPath, "utf-8")) as GraphFile);
    } catch {
      return defaultGraph();
    }
  }

  private save(graph: GraphFile): void {
    mkdirSync(this.graphDir, { recursive: true });
    const tmpPath = `${this.graphPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(normalizeGraph(graph), null, 2) + "\n");
    renameSync(tmpPath, this.graphPath);
  }

  private removeDanglingLinks(graph: GraphFile): void {
    const validIds = new Set(graph.notes.map((note) => note.id));
    for (const note of graph.notes) {
      note.links = note.links.filter((link) => validIds.has(link.to) && link.to !== note.id);
      note.links = dedupeLinks(note.links);
      note.vector = this.buildVectorSpec(note);
    }
  }
}
