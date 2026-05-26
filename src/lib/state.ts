import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readJsonFileWithRecovery } from "./jsonRecovery.js";
import { safeAtomicWriteText } from "./safeWrite.js";

export interface PayoutRecipientState {
  owner: string;
  holderBalanceRaw: string;
  shareCount?: string;
  holdMultiplierBps?: number;
  holdTierLabel?: string;
  eligibleSince?: string;
  weightUnitsRaw?: string;
  isGrandfathered?: boolean;
  amountRaw: string;
  status: "pending" | "paid" | "dropped";
  attempts: number;
  lastAttemptAt?: string;
  paidAt?: string;
  droppedAt?: string;
  txSignature?: string;
  lastError?: string;
  dropReason?: string;
}

export interface PayoutRoundState {
  id: string;
  status: "awaiting_swap" | "pending" | "complete";
  createdAt: string;
  completedAt?: string;
  sourceWallet: string;
  holderMint: string;
  rewardMint: string;
  rewardTokenDecimals?: number;
  actualClaimedLamports?: string;
  snapshotOwnerCount: number;
  eligibleHolderCount: number;
  totalShareCount?: string;
  totalWeightUnitsRaw?: string;
  plannedRewardLamportsIn?: string;
  amountPerRecipientRaw?: string;
  amountPerShareRaw?: string;
  totalRewardRaw?: string;
  rewardUsdMicros?: string;
  rewardDustRaw?: string;
  nextSwapRetryAt?: string;
  nextPayoutRetryAt?: string;
  completionNote?: string;
  claimTx: string;
  swapTx?: string;
  treasuryTx?: string;
  recipients: PayoutRecipientState[];
}

export interface WorkerState {
  version: 1;
  carryForwardRewardLamports?: string;
  unreimbursedOpsLamports?: string;
  totalOpsFeeLamports?: string;
  totalAtaRentLamports?: string;
  totalTreasuryOffsetLamports?: string;
  rounds: PayoutRoundState[];
}

const EMPTY_STATE: WorkerState = {
  version: 1,
  carryForwardRewardLamports: "0",
  unreimbursedOpsLamports: "0",
  totalOpsFeeLamports: "0",
  totalAtaRentLamports: "0",
  totalTreasuryOffsetLamports: "0",
  rounds: [],
};

export class StateStore {
  public constructor(private readonly filePath: string) {}

  public async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await readFile(this.filePath, "utf8");
    } catch {
      await this.write(EMPTY_STATE);
    }
  }

  public async read(): Promise<WorkerState> {
    const parsed = await readJsonFileWithRecovery<WorkerState>(this.filePath);
    return {
      version: 1,
      carryForwardRewardLamports: parsed.carryForwardRewardLamports ?? "0",
      unreimbursedOpsLamports: parsed.unreimbursedOpsLamports ?? "0",
      totalOpsFeeLamports: parsed.totalOpsFeeLamports ?? "0",
      totalAtaRentLamports: parsed.totalAtaRentLamports ?? "0",
      totalTreasuryOffsetLamports: parsed.totalTreasuryOffsetLamports ?? "0",
      rounds: parsed.rounds ?? [],
    };
  }

  public async write(state: WorkerState): Promise<void> {
    await safeAtomicWriteText(this.filePath, JSON.stringify(state, null, 2));
  }
}
