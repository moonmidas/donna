/**
 * MEMORY.md promotion — now sourced from the note graph.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { MemoryNote } from "./graph.js";
import type { NuggetShelf } from "./shelf.js";

const PROMOTE_THRESHOLD = 3;

const MEMORY_MD_HEADER = `# Memory

Auto-promoted from nugget graph notes (3+ recalls across sessions).
`;

function detectMemoryDir(): string | null {
  const cwd = process.cwd();
  const safe = cwd.replace(/\//g, "-");
  const memoryDir = join(homedir(), ".claude", "projects", safe, "memory");
  const projectDir = dirname(memoryDir);
  if (!existsSync(projectDir)) return null;
  return memoryDir;
}

interface Sections {
  [section: string]: { [key: string]: string };
}

function parseMemoryMd(content: string): Sections {
  const sections: Sections = {};
  let currentSection = "";

  for (const line of content.split("\n")) {
    const stripped = line.trim();
    const sectionMatch = stripped.match(/^##\s+(.+)$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      sections[currentSection] ||= {};
      continue;
    }

    const factMatch = stripped.match(/^-\s+\*\*(.+?)\*\*:\s*(.+)$/);
    if (factMatch && currentSection) {
      sections[currentSection][factMatch[1].trim()] = factMatch[2].trim();
    }
  }

  return sections;
}

function renderMemoryMd(sections: Sections): string {
  const keys = Object.keys(sections);
  if (keys.length === 0) return MEMORY_MD_HEADER;

  const priority = ["learnings", "preferences"];
  const ordered: string[] = [];
  for (const item of priority) {
    if (item in sections) ordered.push(item);
  }
  ordered.push(...keys.filter((key) => !priority.includes(key)).sort());

  const lines = [MEMORY_MD_HEADER];
  for (const section of ordered) {
    const entries = Object.entries(sections[section]);
    if (entries.length === 0) continue;
    lines.push(`## ${section}\n`);
    for (const [key, value] of entries) {
      lines.push(`- **${key}**: ${value}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function sectionForNote(note: MemoryNote, fallback: string): string {
  if (note.subject === "assistant:self") return "assistant-self";
  if (note.subject.startsWith("user:")) return "user";
  if (note.scope === "shared" || note.scope === "project") return "shared-context";
  if (note.tags.includes("preferences")) return "preferences";
  if (note.tags.includes("learnings")) return "learnings";
  return fallback;
}

export function promoteFacts(shelf: NuggetShelf): number {
  const memoryDir = detectMemoryDir();
  if (!memoryDir) return 0;

  const candidates: Array<{ section: string; title: string; content: string }> = [];
  for (const info of shelf.list()) {
    const notes = shelf.get(info.name).listNotes();
    for (const note of notes) {
      if (note.hidden) continue;
      if ((note.hits || 0) < PROMOTE_THRESHOLD) continue;
      candidates.push({
        section: sectionForNote(note, info.name),
        title: note.title,
        content: note.content,
      });
    }
  }

  if (candidates.length === 0) return 0;

  const memoryPath = join(memoryDir, "MEMORY.md");
  const existingContent = existsSync(memoryPath)
    ? readFileSync(memoryPath, "utf-8")
    : "";
  const sections = existingContent ? parseMemoryMd(existingContent) : {};

  let newCount = 0;
  for (const candidate of candidates) {
    sections[candidate.section] ||= {};
    const existing = sections[candidate.section][candidate.title];
    if (existing !== candidate.content) {
      sections[candidate.section][candidate.title] = candidate.content;
      if (existing === undefined) newCount += 1;
    }
  }

  const rendered = renderMemoryMd(sections);
  if (rendered === existingContent) return newCount;

  mkdirSync(memoryDir, { recursive: true });
  const tmpPath = `${memoryPath}.tmp`;
  writeFileSync(tmpPath, rendered);
  renameSync(tmpPath, memoryPath);
  return newCount;
}
