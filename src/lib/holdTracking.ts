import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readJsonFileWithRecovery } from "./jsonRecovery.js";
import { safeAtomicWriteText } from "./safeWrite.js";

export interface HoldTrackerEntry {
  eligibleSince: string;
  lastSeenAt: string;
  isGrandfathered: boolean;
}

export interface HoldTrackingState {
  version: 1;
  holders: Record<string, HoldTrackerEntry>;
}

const EMPTY_STATE: HoldTrackingState = {
  version: 1,
  holders: {},
};

export class HoldTrackingStore {
  public constructor(private readonly filePath: string) {}

  public async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await readFile(this.filePath, "utf8");
    } catch {
      await this.write(EMPTY_STATE);
    }
  }

  public async read(): Promise<HoldTrackingState> {
    const parsed = await readJsonFileWithRecovery<HoldTrackingState>(this.filePath);
    return {
      version: 1,
      holders: parsed.holders ?? {},
    };
  }

  public async write(state: HoldTrackingState): Promise<void> {
    await safeAtomicWriteText(this.filePath, JSON.stringify(state, null, 2));
  }
}
