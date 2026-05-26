import { readFile } from "node:fs/promises";

export interface GrandfatherWalletRecord {
  owner: string;
  snapshotRawBalance: string;
  snapshotUiBalance: string;
}

export interface GrandfatherSnapshot {
  createdAt: string;
  holderMint: string;
  normalMinimumTokens: number;
  grandfatherMinimumTokens: number;
  wallets: GrandfatherWalletRecord[];
}

export async function loadGrandfatherSnapshot(filePath: string): Promise<GrandfatherSnapshot | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as GrandfatherSnapshot;
    return {
      createdAt: parsed.createdAt,
      holderMint: parsed.holderMint,
      normalMinimumTokens: parsed.normalMinimumTokens,
      grandfatherMinimumTokens: parsed.grandfatherMinimumTokens,
      wallets: parsed.wallets ?? [],
    };
  } catch {
    return null;
  }
}
