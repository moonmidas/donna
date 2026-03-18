import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatInlineSkillsForPrompt,
  formatSkillsCatalogForPrompt,
  loadGatewaySkills,
  resolveSkillsForEvent,
  resolveSkillsForMessage,
} from "../src/gateway/skills.js";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

describe("gateway skill loading", () => {
  it("loads registry skills from skills/<id>/skill.json + SKILL.md", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "donna-skills-"));
    const skillDir = join(tmpRoot, "skills", "reviewer");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "skill.json"),
      JSON.stringify({
        name: "reviewer",
        description: "Review code for bugs and regressions.",
        scope: "sticky",
        triggers: ["review", "regression"],
        requires: ["files"],
        adapters: {
          codex: {
            extraPrompt: "Lead with findings.",
          },
        },
      }, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: reviewer",
        "description: Review code for bugs and regressions.",
        "---",
        "",
        "# Reviewer",
        "",
        "Look for behavioral regressions first.",
      ].join("\n"),
      "utf-8",
    );

    const result = loadGatewaySkills({ cwd: tmpRoot });

    expect(result.warnings).toEqual([]);
    expect(result.skills).toEqual([
      expect.objectContaining({
        name: "reviewer",
        scope: "sticky",
        triggers: ["review", "regression"],
        requires: ["files"],
        metadataPath: join(skillDir, "skill.json"),
      }),
    ]);
  });

  it("keeps compatibility with plain Pi-style .pi/skills entries", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "donna-skills-"));
    const skillDir = join(tmpRoot, ".pi", "skills", "researcher");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: researcher",
        "description: Investigate code paths.",
        "---",
        "",
        "# Researcher",
        "",
        "Follow code references before changing anything.",
      ].join("\n"),
      "utf-8",
    );

    const result = loadGatewaySkills({ cwd: tmpRoot });

    expect(result.warnings).toEqual([]);
    expect(result.skills).toEqual([
      expect.objectContaining({
        name: "researcher",
        scope: "one-shot",
        triggers: [],
        source: "project-pi",
      }),
    ]);
  });

  it("keeps hidden skills out of prompt catalogs", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "donna-skills-"));
    const skillDir = join(tmpRoot, "skills", "debugger");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "skill.json"),
      JSON.stringify({
        name: "debugger",
        description: "Debug issues step by step.",
        disableModelInvocation: true,
      }, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: debugger",
        "description: Debug issues step by step.",
        "---",
        "",
        "# Debugger",
      ].join("\n"),
      "utf-8",
    );

    const result = loadGatewaySkills({ cwd: tmpRoot });

    expect(
      formatSkillsCatalogForPrompt(
        result.skills,
        "Use your file tools to inspect the skill when relevant.",
        "codex",
      ),
    ).toBe("");
    expect(
      formatInlineSkillsForPrompt(
        result.skills,
        "Active project skills for this request:",
        "local",
      ),
    ).toBe("");
  });

  it("warns on malformed skill files", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "donna-skills-"));
    const skillDir = join(tmpRoot, "skills", "bad skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "skill.json"),
      JSON.stringify({
        description: "Missing a valid kebab-case name.",
      }, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: bad skill",
        "description: Missing a valid kebab-case name.",
        "---",
        "",
        "# Broken",
      ].join("\n"),
      "utf-8",
    );

    const result = loadGatewaySkills({ cwd: tmpRoot });

    expect(result.skills).toEqual([]);
    expect(result.warnings[0]).toContain("invalid name");
  });
});

describe("skill activation", () => {
  it("activates sticky skills from triggers and persists them for later events", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "donna-skills-"));
    const skillDir = join(tmpRoot, "skills", "planner");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "skill.json"),
      JSON.stringify({
        name: "planner",
        description: "Plan bigger changes in phases.",
        scope: "sticky",
        triggers: ["plan", "roadmap"],
      }, null, 2),
      "utf-8",
    );
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: planner",
        "description: Plan bigger changes in phases.",
        "---",
        "",
        "# Planner",
      ].join("\n"),
      "utf-8",
    );

    const skills = loadGatewaySkills({ cwd: tmpRoot }).skills;
    const sessionDir = join(tmpRoot, "sessions", "abc");

    const first = resolveSkillsForMessage(skills, sessionDir, "can you plan this refactor");
    expect(first.command.handled).toBe(false);
    expect(first.activeSkills.map((skill) => skill.name)).toEqual(["planner"]);

    const later = resolveSkillsForEvent(skills, sessionDir);
    expect(later.map((skill) => skill.name)).toEqual(["planner"]);
  });

  it("supports explicit skill commands", () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "donna-skills-"));
    for (const name of ["reviewer", "debugger"]) {
      const skillDir = join(tmpRoot, "skills", name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "skill.json"),
        JSON.stringify({
          name,
          description: `${name} description`,
          scope: "sticky",
        }, null, 2),
        "utf-8",
      );
      writeFileSync(
        join(skillDir, "SKILL.md"),
        [
          "---",
          `name: ${name}`,
          `description: ${name} description`,
          "---",
          "",
          `# ${name}`,
        ].join("\n"),
        "utf-8",
      );
    }

    const skills = loadGatewaySkills({ cwd: tmpRoot }).skills;
    const sessionDir = join(tmpRoot, "sessions", "xyz");

    const enable = resolveSkillsForMessage(skills, sessionDir, "/skill use reviewer debugger");
    expect(enable.command).toEqual({
      handled: true,
      response: "Enabled skills: reviewer, debugger.",
    });

    const list = resolveSkillsForMessage(skills, sessionDir, "/skills");
    expect(list.command.handled).toBe(true);
    expect(list.command.response).toContain("reviewer");
    expect(list.command.response).toContain("active");

    const disable = resolveSkillsForMessage(skills, sessionDir, "/skill remove reviewer");
    expect(disable.command.response).toBe("Disabled skill: reviewer.");

    const remaining = resolveSkillsForEvent(skills, sessionDir);
    expect(remaining.map((skill) => skill.name)).toEqual(["debugger"]);
  });
});
