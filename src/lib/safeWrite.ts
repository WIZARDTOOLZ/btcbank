import { copyFile, rename, rm, writeFile } from "node:fs/promises";

const RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 40;

export async function safeAtomicWriteText(filePath: string, contents: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tempPath, contents, "utf8");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(tempPath, filePath);
      return;
    } catch (error) {
      if (!isRetryable(error) || attempt === MAX_ATTEMPTS) {
        break;
      }
      await delay(BASE_DELAY_MS * attempt);
    }
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await copyFile(tempPath, filePath);
      await rm(tempPath, { force: true });
      return;
    } catch (error) {
      if (!isRetryable(error) || attempt === MAX_ATTEMPTS) {
        throw error;
      }
      await delay(BASE_DELAY_MS * attempt);
    }
  }

  await rm(tempPath, { force: true });
}

function isRetryable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && RETRYABLE_CODES.has(code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
