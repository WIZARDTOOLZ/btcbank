import { copyFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";

import { safeAtomicWriteText } from "./safeWrite.js";

export async function readJsonFileWithRecovery<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const repaired = tryRepairTrailingJson<T>(raw);
    if (!repaired) {
      throw error;
    }

    const backupPath = `${filePath}.corrupt-${Date.now()}.bak`;
    await copyFile(filePath, backupPath);
    await safeAtomicWriteText(filePath, repaired.trimmed);
    return repaired.parsed;
  }
}

function tryRepairTrailingJson<T>(raw: string): { parsed: T; trimmed: string } | null {
  try {
    const end = findRootEnd(raw);
    const trimmed = `${raw.slice(0, end).trimEnd()}\n`;
    const trailing = raw.slice(end).trim();
    if (!trailing) {
      return null;
    }
    const parsed = JSON.parse(trimmed) as T;
    return { parsed, trimmed };
  } catch {
    return null;
  }
}

function findRootEnd(text: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  let started = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";

    if (!started) {
      if (/\s/.test(ch)) {
        continue;
      }
      if (ch !== "{" && ch !== "[") {
        throw new Error("JSON root must start with { or [");
      }
      started = true;
      depth = 1;
      continue;
    }

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }

  throw new Error("No complete JSON root found");
}
