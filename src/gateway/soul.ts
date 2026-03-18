import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function readSoulPrompt(cwd: string): string {
  const soulPath = join(cwd, "SOUL.md");
  if (!existsSync(soulPath)) return "";

  const soul = readFileSync(soulPath, "utf-8").trim();
  if (!soul) return "";

  return [
    "Donna's voice and working style are defined in SOUL.md.",
    "Follow that soul while still obeying explicit user instructions and safety boundaries.",
    "",
    soul,
  ].join("\n");
}
