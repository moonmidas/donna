import type { MemoryNote } from "./graph.js";
import type { NuggetShelf } from "./shelf.js";

export interface ReflectionChange {
  type: "rewrite" | "merge" | "hide" | "tag" | "link";
  nuggetName: string;
  noteId: string;
  detail: string;
}

export interface ReflectionResult {
  ranAt: string;
  inspected: number;
  rewritten: number;
  merged: number;
  hidden: number;
  tagged: number;
  linked: number;
  changes: ReflectionChange[];
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9/_:-]{2,}/g) || [])
    .filter((token) => !STOP_WORDS.has(token));
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function normalizeContent(text: string): string {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  return uniq(lines).join("\n").trim();
}

function ageScore(note: MemoryNote): number {
  const updated = Date.parse(note.updatedAt || note.createdAt);
  if (Number.isNaN(updated)) return 0;
  return Math.max(0, Date.now() - updated);
}

function qualityScore(note: MemoryNote): number {
  let score = ageScore(note);
  if (note.tags.length === 0) score += 3_600_000;
  if (note.links.length === 0) score += 3_600_000;
  if (note.hidden) score -= 86_400_000;
  return score;
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const union = new Set([...setA, ...setB]);
  let overlap = 0;
  for (const token of setA) {
    if (setB.has(token)) overlap++;
  }
  return union.size === 0 ? 0 : overlap / union.size;
}

function deriveTags(note: MemoryNote): string[] {
  const existing = note.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  const tokens = tokenize(`${note.title} ${note.content}`);
  const extra: string[] = [`scope:${note.scope}`, `type:${note.type}`];

  if (note.kind === "fact") extra.push("fact");
  if (note.title.toLowerCase().startsWith("pref:")) extra.push("preferences");
  if (note.title.toLowerCase().startsWith("learn")) extra.push("learnings");
  if (note.content.includes("/") || note.content.includes(".")) extra.push("files");
  if (note.scope === "self") extra.push("assistant-self");
  if (note.scope === "user") extra.push("user-memory");
  if (note.scope === "shared" || note.scope === "project") extra.push("shared-context");

  for (const token of tokens) {
    if (token.length < 4) continue;
    if (extra.length >= 4) break;
    extra.push(token);
  }

  return uniq([...existing, ...extra]).slice(0, 6);
}

function isLowValue(note: MemoryNote): boolean {
  const content = note.content.trim();
  if (!content) return true;
  if (content.length <= 2 && note.hits === 0) return true;
  if (/^(tmp|temp|scratch)/i.test(note.title) && note.hits === 0) return true;
  if (note.scope === "self" && note.stability === "durable") return false;
  return false;
}

function makeReason(shared: string[]): string {
  if (shared.length === 0) return "related note";
  return `shared context: ${shared.slice(0, 3).join(", ")}`;
}

export function reflectAndCleanMemory(
  shelf: NuggetShelf,
  opts?: { nuggetName?: string; limit?: number },
): ReflectionResult {
  const limit = Math.max(1, Math.min(opts?.limit ?? 10, 10));
  const notes = shelf
    .listNotes(opts?.nuggetName, { includeHidden: true })
    .sort((a, b) => qualityScore(b) - qualityScore(a))
    .slice(0, limit);

  const result: ReflectionResult = {
    ranAt: new Date().toISOString(),
    inspected: notes.length,
    rewritten: 0,
    merged: 0,
    hidden: 0,
    tagged: 0,
    linked: 0,
    changes: [],
  };

  const touched = new Set<string>();

  for (const entry of notes) {
    const nugget = shelf.get(entry.nugget_name);
    const note = nugget.getNote(entry.id);
    if (!note || note.hidden) continue;

    if (isLowValue(note)) {
      if (nugget.deleteNote(note.id, false)) {
        result.hidden += 1;
        result.changes.push({
          type: "hide",
          nuggetName: entry.nugget_name,
          noteId: note.id,
          detail: "Archived low-value note",
        });
        touched.add(note.id);
      }
      continue;
    }

    const normalized = normalizeContent(note.content);
    if (normalized && normalized !== note.content) {
      nugget.editNote(note.id, normalized, { rewrittenAt: result.ranAt });
      result.rewritten += 1;
      result.changes.push({
        type: "rewrite",
        nuggetName: entry.nugget_name,
        noteId: note.id,
        detail: "Normalized duplicated whitespace and repeated lines",
      });
    }

    const tags = deriveTags(note);
    if (tags.join("|") !== note.tags.join("|")) {
      nugget.updateNote(note.id, { tags, lastRewrittenAt: result.ranAt });
      result.tagged += 1;
      result.changes.push({
        type: "tag",
        nuggetName: entry.nugget_name,
        noteId: note.id,
        detail: `Tags -> ${tags.join(", ")}`,
      });
    }
  }

  const liveNotes = shelf.listNotes(opts?.nuggetName);
  for (let i = 0; i < liveNotes.length; i++) {
    if (result.merged >= limit) break;
    for (let j = i + 1; j < liveNotes.length; j++) {
      const a = liveNotes[i];
      const b = liveNotes[j];
      if (a.nugget_name !== b.nugget_name) continue;
      if (a.hidden || b.hidden) continue;
      if (touched.has(a.id) || touched.has(b.id)) continue;

      const score = jaccard(
        tokenize(`${a.title} ${a.content}`),
        tokenize(`${b.title} ${b.content}`),
      );
      if (a.subject !== b.subject || a.scope !== b.scope || a.type !== b.type) continue;
      if (score < 0.9) continue;

      const winner = a.content.length >= b.content.length ? a : b;
      const loser = winner.id === a.id ? b : a;
      const merged = shelf.get(winner.nugget_name).mergeNotes(
        winner.id,
        loser.id,
        "merged during daily memory reflection",
      );
      if (merged) {
        result.merged += 1;
        result.changes.push({
          type: "merge",
          nuggetName: winner.nugget_name,
          noteId: merged.id,
          detail: `Merged duplicate note ${loser.id}`,
        });
        touched.add(winner.id);
        touched.add(loser.id);
      }
    }
  }

  const refreshed = shelf.listNotes(opts?.nuggetName);
  for (const note of refreshed) {
    if (result.linked >= limit) break;
    if (note.hidden || note.links.length >= 2) continue;
    const baseTokens = tokenize(`${note.title} ${note.content}`);

    for (const other of refreshed) {
      if (other.id === note.id || other.nugget_name !== note.nugget_name || other.hidden) continue;
      if (
        other.subject !== note.subject &&
        note.scope !== "shared" &&
        other.scope !== "shared" &&
        note.scope !== "project" &&
        other.scope !== "project"
      ) {
        continue;
      }
      const otherTokens = tokenize(`${other.title} ${other.content}`);
      const overlap = uniq(baseTokens.filter((token) => otherTokens.includes(token)));
      if (overlap.length < 2) continue;

      const linked = shelf.addLink(note.nugget_name, note.id, other.id, makeReason(overlap));
      if (linked) {
        result.linked += 1;
        result.changes.push({
          type: "link",
          nuggetName: note.nugget_name,
          noteId: note.id,
          detail: `Linked to ${other.id}`,
        });
      }
      break;
    }
  }

  return result;
}
