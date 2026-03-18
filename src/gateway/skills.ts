import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type GatewaySkillScope = "one-shot" | "sticky";
export type GatewaySkillBackend = "pi" | "codex" | "local";

export interface GatewaySkillAdapter {
  enabled?: boolean;
  extraPrompt?: string;
}

export interface GatewaySkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  instructions: string;
  metadataPath?: string;
  disableModelInvocation: boolean;
  scope: GatewaySkillScope;
  triggers: string[];
  requires: string[];
  adapters: {
    pi?: GatewaySkillAdapter;
    codex?: GatewaySkillAdapter;
    local?: GatewaySkillAdapter;
  };
  source: "registry" | "project-pi" | "path";
}

export interface LoadGatewaySkillsOptions {
  cwd?: string;
  skillPaths?: string[];
}

export interface LoadGatewaySkillsResult {
  skills: GatewaySkill[];
  warnings: string[];
}

export interface SkillCommandResult {
  handled: boolean;
  response?: string;
}

export interface SkillResolutionResult {
  activeSkills: GatewaySkill[];
  command: SkillCommandResult;
}

interface RegistrySkillMetadata {
  name?: unknown;
  description?: unknown;
  scope?: unknown;
  triggers?: unknown;
  requires?: unknown;
  disableModelInvocation?: unknown;
  adapters?: unknown;
}

interface SkillState {
  stickySkillNames: string[];
  updatedAt: string;
}

const REGISTRY_SKILLS_DIR = "skills";
const PROJECT_PI_SKILLS_DIR = ".pi/skills";
const SKILL_FILE_NAME = "SKILL.md";
const REGISTRY_FILE_NAME = "skill.json";
const STATE_FILE_NAME = "active-skills.json";

export function loadGatewaySkills(
  options: LoadGatewaySkillsOptions = {},
): LoadGatewaySkillsResult {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const warnings: string[] = [];
  const byName = new Map<string, GatewaySkill>();
  const byRealPath = new Set<string>();

  const addSkill = (skill: GatewaySkill) => {
    let realPath = skill.filePath;
    try {
      realPath = realpathSync(skill.filePath);
    } catch {
      // Keep the original path if the real path cannot be resolved.
    }

    if (byRealPath.has(realPath)) {
      return;
    }

    const existing = byName.get(skill.name);
    if (existing) {
      warnings.push(
        `Skill name collision for "${skill.name}" between ${existing.filePath} and ${skill.filePath}; keeping ${existing.filePath}.`,
      );
      return;
    }

    byRealPath.add(realPath);
    byName.set(skill.name, skill);
  };

  for (const rawPath of options.skillPaths ?? []) {
    const resolvedPath = resolveSkillPath(rawPath, cwd);
    if (!existsSync(resolvedPath)) {
      warnings.push(`Skill path does not exist: ${resolvedPath}`);
      continue;
    }

    loadPath(resolvedPath, warnings, "path").forEach(addSkill);
  }

  const registryDir = resolve(cwd, REGISTRY_SKILLS_DIR);
  if (existsSync(registryDir)) {
    loadPath(registryDir, warnings, "registry").forEach(addSkill);
  }

  const projectPiSkillsDir = resolve(cwd, PROJECT_PI_SKILLS_DIR);
  if (existsSync(projectPiSkillsDir)) {
    loadPath(projectPiSkillsDir, warnings, "project-pi").forEach(addSkill);
  }

  return {
    skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  };
}

export function formatSkillsCatalogForPrompt(
  skills: GatewaySkill[],
  loadInstruction: string,
  backend: GatewaySkillBackend = "codex",
): string {
  const visibleSkills = filterSkillsForBackend(skills, backend)
    .filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) {
    return "";
  }

  const lines = [
    "",
    "",
    "Project skills available in this repo:",
    loadInstruction,
    "When a skill file references a relative path, resolve it against the skill directory.",
    "",
    "<available_skills>",
  ];

  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    if (skill.triggers.length > 0) {
      lines.push(`    <triggers>${escapeXml(skill.triggers.join(", "))}</triggers>`);
    }
    lines.push(`    <scope>${escapeXml(skill.scope)}</scope>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

export function formatInlineSkillsForPrompt(
  skills: GatewaySkill[],
  heading = "Active project skills for this request:",
  backend: GatewaySkillBackend = "local",
): string {
  const visibleSkills = filterSkillsForBackend(skills, backend)
    .filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) {
    return "";
  }

  const lines = ["", "", heading];
  for (const skill of visibleSkills) {
    lines.push("");
    lines.push(`## Skill: ${skill.name}`);
    lines.push(`Description: ${skill.description}`);
    lines.push(`Scope: ${skill.scope}`);
    if (skill.triggers.length > 0) {
      lines.push(`Triggers: ${skill.triggers.join(", ")}`);
    }
    lines.push(`Path: ${skill.filePath}`);
    lines.push("");
    lines.push(skill.instructions.trim());
    const extraPrompt = skill.adapters[backend]?.extraPrompt;
    if (extraPrompt) {
      lines.push("");
      lines.push(`Adapter note: ${extraPrompt}`);
    }
  }

  return lines.join("\n");
}

export function formatActiveSkillsNotice(skills: GatewaySkill[]): string {
  const visibleSkills = filterSkillsForBackend(skills, "pi")
    .filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) {
    return "";
  }

  const lines = ["Active project skills for this request:"];
  for (const skill of visibleSkills) {
    lines.push(`- ${skill.name}: ${skill.description}`);
    if (skill.adapters.pi?.extraPrompt) {
      lines.push(`  note: ${skill.adapters.pi.extraPrompt}`);
    }
  }
  return lines.join("\n");
}

export function resolveSkillsForMessage(
  skills: GatewaySkill[],
  sessionDir: string,
  messageText: string,
): SkillResolutionResult {
  mkdirSync(sessionDir, { recursive: true });
  const state = loadSkillState(sessionDir);
  const normalized = normalizeForMatch(messageText);
  const command = handleSkillCommand(skills, state, normalized, sessionDir);
  if (command.handled) {
    return { activeSkills: getStickySkills(skills, state), command };
  }

  const matched = skills.filter((skill) => matchesSkillTrigger(skill, normalized));
  let stateChanged = false;

  for (const skill of matched) {
    if (skill.scope === "sticky" && !state.stickySkillNames.includes(skill.name)) {
      state.stickySkillNames.push(skill.name);
      stateChanged = true;
    }
  }

  if (stateChanged) {
    saveSkillState(sessionDir, state);
  }

  const activeByName = new Map<string, GatewaySkill>();
  for (const skill of getStickySkills(skills, state)) {
    activeByName.set(skill.name, skill);
  }
  for (const skill of matched) {
    activeByName.set(skill.name, skill);
  }

  return {
    activeSkills: [...activeByName.values()],
    command,
  };
}

export function resolveSkillsForEvent(
  skills: GatewaySkill[],
  sessionDir: string,
): GatewaySkill[] {
  return getStickySkills(skills, loadSkillState(sessionDir));
}

export function filterSkillsForBackend(
  skills: GatewaySkill[],
  backend: GatewaySkillBackend,
): GatewaySkill[] {
  return skills.filter((skill) => skill.adapters[backend]?.enabled !== false);
}

function handleSkillCommand(
  skills: GatewaySkill[],
  state: SkillState,
  normalizedMessage: string,
  sessionDir: string,
): SkillCommandResult {
  if (!normalizedMessage.startsWith("/skill") && !normalizedMessage.startsWith("/skills")) {
    return { handled: false };
  }

  if (normalizedMessage === "/skill" || normalizedMessage === "/skills" || normalizedMessage === "/skill list" || normalizedMessage === "/skills list") {
    return {
      handled: true,
      response: listSkillsResponse(skills, state),
    };
  }

  if (normalizedMessage === "/skill clear" || normalizedMessage === "/skills clear") {
    state.stickySkillNames = [];
    saveSkillState(sessionDir, state);
    return {
      handled: true,
      response: "Cleared all sticky skills for this conversation.",
    };
  }

  const enableMatch = normalizedMessage.match(/^\/skills?\s+(?:use|add|on|enable)\s+(.+)$/);
  if (enableMatch) {
    const requested = parseRequestedNames(enableMatch[1]);
    const resolved = resolveRequestedSkills(skills, requested);
    if (resolved.missing.length > 0) {
      return {
        handled: true,
        response: `Unknown skill${resolved.missing.length > 1 ? "s" : ""}: ${resolved.missing.join(", ")}.`,
      };
    }

    for (const skill of resolved.skills) {
      if (!state.stickySkillNames.includes(skill.name)) {
        state.stickySkillNames.push(skill.name);
      }
    }
    saveSkillState(sessionDir, state);
    return {
      handled: true,
      response: `Enabled skill${resolved.skills.length > 1 ? "s" : ""}: ${resolved.skills.map((skill) => skill.name).join(", ")}.`,
    };
  }

  const disableMatch = normalizedMessage.match(/^\/skills?\s+(?:off|remove|disable)\s+(.+)$/);
  if (disableMatch) {
    const requested = parseRequestedNames(disableMatch[1]);
    const resolved = resolveRequestedSkills(skills, requested);
    if (resolved.missing.length > 0) {
      return {
        handled: true,
        response: `Unknown skill${resolved.missing.length > 1 ? "s" : ""}: ${resolved.missing.join(", ")}.`,
      };
    }

    state.stickySkillNames = state.stickySkillNames.filter(
      (name) => !resolved.skills.some((skill) => skill.name === name),
    );
    saveSkillState(sessionDir, state);
    return {
      handled: true,
      response: `Disabled skill${resolved.skills.length > 1 ? "s" : ""}: ${resolved.skills.map((skill) => skill.name).join(", ")}.`,
    };
  }

  return {
    handled: true,
    response: [
      "Skill commands:",
      "- `/skills` or `/skill list`",
      "- `/skill use reviewer`",
      "- `/skill remove reviewer`",
      "- `/skill clear`",
    ].join("\n"),
  };
}

function listSkillsResponse(skills: GatewaySkill[], state: SkillState): string {
  if (skills.length === 0) {
    return "No project skills are installed.";
  }

  const sticky = new Set(state.stickySkillNames);
  const lines = ["Available project skills:"];
  for (const skill of skills) {
    const flags: string[] = [skill.scope];
    if (sticky.has(skill.name)) {
      flags.push("active");
    }
    if (skill.triggers.length > 0) {
      flags.push(`triggers=${skill.triggers.join("|")}`);
    }
    lines.push(`- ${skill.name}: ${skill.description} [${flags.join(", ")}]`);
  }
  return lines.join("\n");
}

function parseRequestedNames(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveRequestedSkills(
  skills: GatewaySkill[],
  requestedNames: string[],
): { skills: GatewaySkill[]; missing: string[] } {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const resolved: GatewaySkill[] = [];
  const missing: string[] = [];

  for (const requestedName of requestedNames) {
    const exact = byName.get(requestedName);
    if (exact) {
      resolved.push(exact);
      continue;
    }

    const fuzzy = skills.find((skill) => skill.name.includes(requestedName));
    if (fuzzy) {
      resolved.push(fuzzy);
      continue;
    }

    missing.push(requestedName);
  }

  return {
    skills: dedupeSkills(resolved),
    missing,
  };
}

function dedupeSkills(skills: GatewaySkill[]): GatewaySkill[] {
  const byName = new Map<string, GatewaySkill>();
  for (const skill of skills) {
    byName.set(skill.name, skill);
  }
  return [...byName.values()];
}

function matchesSkillTrigger(skill: GatewaySkill, normalizedMessage: string): boolean {
  if (!normalizedMessage) {
    return false;
  }

  if (normalizedMessage.includes(skill.name.toLowerCase())) {
    return true;
  }

  return skill.triggers.some((trigger) => normalizedMessage.includes(normalizeForMatch(trigger)));
}

function getStickySkills(skills: GatewaySkill[], state: SkillState): GatewaySkill[] {
  const stickyNames = new Set(state.stickySkillNames);
  return skills.filter((skill) => stickyNames.has(skill.name));
}

function loadPath(
  fileOrDirPath: string,
  warnings: string[],
  source: GatewaySkill["source"],
): GatewaySkill[] {
  const stats = statSync(fileOrDirPath);
  if (stats.isDirectory()) {
    return loadSkillsFromDir(fileOrDirPath, warnings, source);
  }
  if (stats.isFile() && fileOrDirPath.endsWith(".md")) {
    const skill = loadSkillFromMarkdown(fileOrDirPath, warnings, source);
    return skill ? [skill] : [];
  }
  if (stats.isFile() && basename(fileOrDirPath) === REGISTRY_FILE_NAME) {
    const skill = loadSkillFromRegistry(dirname(fileOrDirPath), warnings, source);
    return skill ? [skill] : [];
  }

  warnings.push(`Skill path is not a skill directory, markdown file, or ${REGISTRY_FILE_NAME}: ${fileOrDirPath}`);
  return [];
}

function loadSkillsFromDir(
  dir: string,
  warnings: string[],
  source: GatewaySkill["source"],
): GatewaySkill[] {
  if (!existsSync(dir)) {
    return [];
  }

  const registryFile = join(dir, REGISTRY_FILE_NAME);
  const skillFile = join(dir, SKILL_FILE_NAME);
  if (existsSync(registryFile)) {
    const skill = loadSkillFromRegistry(dir, warnings, source);
    return skill ? [skill] : [];
  }
  if (existsSync(skillFile)) {
    const skill = loadSkillFromMarkdown(skillFile, warnings, source);
    return skill ? [skill] : [];
  }

  const skills: GatewaySkill[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }

    const fullPath = join(dir, entry.name);
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && safeStatIsDirectory(fullPath));
    const isFile = entry.isFile() || (entry.isSymbolicLink() && safeStatIsFile(fullPath));

    if (isDirectory) {
      skills.push(...loadSkillsFromDir(fullPath, warnings, source));
      continue;
    }

    if (isFile && entry.name.endsWith(".md")) {
      const skill = loadSkillFromMarkdown(fullPath, warnings, source);
      if (skill) {
        skills.push(skill);
      }
    }
  }

  return skills;
}

function loadSkillFromRegistry(
  dir: string,
  warnings: string[],
  source: GatewaySkill["source"],
): GatewaySkill | null {
  const registryPath = join(dir, REGISTRY_FILE_NAME);
  const skillPath = join(dir, SKILL_FILE_NAME);
  if (!existsSync(skillPath)) {
    warnings.push(`Skipping registry skill without ${SKILL_FILE_NAME}: ${registryPath}`);
    return null;
  }

  try {
    const metadata = JSON.parse(readFileSync(registryPath, "utf-8")) as RegistrySkillMetadata;
    const markdown = readFileSync(skillPath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(markdown);
    const name = normalizeName(metadata.name, basename(dir), registryPath, warnings);
    const description = normalizeDescription(metadata.description, registryPath, warnings);
    if (!name || !description) {
      return null;
    }

    // Pi still reads frontmatter from SKILL.md, so we validate it rather than ignoring it.
    validateMarkdownFrontmatter(frontmatter, name, description, skillPath, warnings);

    return {
      name,
      description,
      filePath: skillPath,
      baseDir: dir,
      instructions: body.trim(),
      metadataPath: registryPath,
      disableModelInvocation: Boolean(metadata.disableModelInvocation ?? frontmatter["disable-model-invocation"] === true),
      scope: normalizeScope(metadata.scope, registryPath, warnings),
      triggers: normalizeStringArray(metadata.triggers, "triggers", registryPath, warnings),
      requires: normalizeStringArray(metadata.requires, "requires", registryPath, warnings),
      adapters: normalizeAdapters(metadata.adapters, registryPath, warnings),
      source,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Failed to load registry skill ${registryPath}: ${message}`);
    return null;
  }
}

function loadSkillFromMarkdown(
  filePath: string,
  warnings: string[],
  source: GatewaySkill["source"],
): GatewaySkill | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const baseDir = dirname(filePath);
    const fallbackName = basename(baseDir);
    const name = normalizeName(frontmatter.name, fallbackName, filePath, warnings);
    const description = normalizeDescription(frontmatter.description, filePath, warnings);
    if (!name || !description) {
      return null;
    }

    return {
      name,
      description,
      filePath,
      baseDir,
      instructions: body.trim(),
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
      scope: "one-shot",
      triggers: [],
      requires: [],
      adapters: {},
      source,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Failed to load skill ${filePath}: ${message}`);
    return null;
  }
}

function validateMarkdownFrontmatter(
  frontmatter: Record<string, string | boolean>,
  expectedName: string,
  expectedDescription: string,
  skillPath: string,
  warnings: string[],
): void {
  const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const frontmatterDescription = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";

  if (!frontmatterName || !frontmatterDescription) {
    warnings.push(
      `Registry skill markdown should include name and description frontmatter for Pi compatibility: ${skillPath}`,
    );
    return;
  }

  if (frontmatterName !== expectedName || frontmatterDescription !== expectedDescription) {
    warnings.push(
      `Registry skill markdown frontmatter does not match ${REGISTRY_FILE_NAME}: ${skillPath}`,
    );
  }
}

function normalizeName(
  value: unknown,
  fallbackName: string,
  sourcePath: string,
  warnings: string[],
): string | null {
  const name = String(value || fallbackName).trim();
  if (!/^[a-z0-9-]+$/.test(name)) {
    warnings.push(`Skipping skill with invalid name "${name}": ${sourcePath}`);
    return null;
  }
  return name;
}

function normalizeDescription(
  value: unknown,
  sourcePath: string,
  warnings: string[],
): string | null {
  const description = String(value || "").trim();
  if (!description) {
    warnings.push(`Skipping skill without description: ${sourcePath}`);
    return null;
  }
  return description;
}

function normalizeScope(
  value: unknown,
  sourcePath: string,
  warnings: string[],
): GatewaySkillScope {
  if (value === "sticky" || value === "one-shot") {
    return value;
  }
  if (value != null) {
    warnings.push(`Invalid skill scope "${String(value)}" in ${sourcePath}; defaulting to one-shot.`);
  }
  return "one-shot";
}

function normalizeStringArray(
  value: unknown,
  fieldName: string,
  sourcePath: string,
  warnings: string[],
): string[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push(`Expected "${fieldName}" to be an array in ${sourcePath}.`);
    return [];
  }

  return value
    .map((item) => String(item).trim())
    .filter((item) => {
      if (!item) {
        warnings.push(`Ignoring empty "${fieldName}" entry in ${sourcePath}.`);
        return false;
      }
      return true;
    });
}

function normalizeAdapters(
  value: unknown,
  sourcePath: string,
  warnings: string[],
): GatewaySkill["adapters"] {
  if (value == null) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`Expected "adapters" to be an object in ${sourcePath}.`);
    return {};
  }

  const adapters: GatewaySkill["adapters"] = {};
  for (const key of ["pi", "codex", "local"] as const) {
    const rawAdapter = (value as Record<string, unknown>)[key];
    if (!rawAdapter) {
      continue;
    }
    if (typeof rawAdapter !== "object" || Array.isArray(rawAdapter)) {
      warnings.push(`Expected adapters.${key} to be an object in ${sourcePath}.`);
      continue;
    }
    const record = rawAdapter as Record<string, unknown>;
    adapters[key] = {
      enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
      extraPrompt: typeof record.extraPrompt === "string" ? record.extraPrompt.trim() : undefined,
    };
  }

  return adapters;
}

function loadSkillState(sessionDir: string): SkillState {
  const statePath = join(sessionDir, STATE_FILE_NAME);
  if (!existsSync(statePath)) {
    return {
      stickySkillNames: [],
      updatedAt: new Date(0).toISOString(),
    };
  }

  try {
    const raw = JSON.parse(readFileSync(statePath, "utf-8")) as { stickySkillNames?: unknown; updatedAt?: unknown };
    return {
      stickySkillNames: Array.isArray(raw.stickySkillNames)
        ? raw.stickySkillNames.map((entry) => String(entry)).filter(Boolean)
        : [],
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return {
      stickySkillNames: [],
      updatedAt: new Date(0).toISOString(),
    };
  }
}

function saveSkillState(sessionDir: string, state: SkillState): void {
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, STATE_FILE_NAME),
    JSON.stringify(
      {
        stickySkillNames: [...new Set(state.stickySkillNames)].sort(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string | boolean>;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }

  const frontmatter: Record<string, string | boolean> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    frontmatter[key] = parseFrontmatterValue(rawValue);
  }

  return {
    frontmatter,
    body: match[2],
  };
}

function parseFrontmatterValue(value: string): string | boolean {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function resolveSkillPath(input: string, cwd: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return cwd;
  }

  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return join(homedir(), trimmed.slice(2));
  }

  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function safeStatIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeStatIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
