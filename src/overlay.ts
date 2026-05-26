import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";

import { config } from "./config.js";
import { shorten } from "./lib/format.js";
import { HoldTrackingStore } from "./lib/holdTracking.js";
import { getHolderSummary } from "./lib/holders.js";
import { quoteTokenToUsd } from "./lib/jupiter.js";
import { readJsonFileWithRecovery } from "./lib/jsonRecovery.js";
import { installRuntimeNoiseFilter } from "./lib/runtimeNoiseFilter.js";
import type { PayoutRoundState, WorkerState } from "./lib/state.js";
import { loadKeypair } from "./lib/wallet.js";

installRuntimeNoiseFilter();

type OverlayRound = {
  id: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  claimSol: string;
  rewardWbtc: string;
  rewardUsd: number | null;
  holders: number;
  paidRecipients: number;
  pendingRecipients: number;
  pendingRewardWbtc: string;
  progressPct: number;
  tierMix: string;
  baseEntryPayoutWbtc: string;
  tierExamples: Array<{ label: string; amountWbtc: string }>;
  claimTx?: string;
  swapTx?: string;
  treasuryTx?: string;
};

type OverlayTx = {
  kind: string;
  at: string;
  sig: string;
  detail: string;
};

type OverlayQualification = {
  minimumTokens: string;
  approxUsd: number | null;
  approxSol: number | null;
  shareRule: string;
  holdRule: string;
  wbtcRule: string;
  resetRule: string;
};

type OverlayPayload = {
  projectName: string;
  wallet: string;
  holderMint: string;
  rewardMint: string;
  updatedAt: string;
  nextCheckAt: string | null;
  nextCheckSeconds: number | null;
  qualification: OverlayQualification;
  totals: {
    roundsTotal: number;
    roundsComplete: number;
    holdersPaidTotal: number;
    totalClaimedSol: string;
    totalPaidWbtc: string;
    totalPaidUsd: number | null;
    totalHandledUsd: number | null;
    carryForwardSol: string;
    txCount: number;
  };
  queue: {
    awaitingSwapRounds: number;
    pendingRounds: number;
    pendingEntries: number;
    pendingRewardWbtc: string;
    pendingEtaSeconds: number | null;
  };
  activeRound: OverlayRound | null;
  recentRounds: OverlayRound[];
  recentTxs: OverlayTx[];
};

type DashboardHolderRow = {
  owner: string;
  balanceTokens: string;
  shares: string;
  holdAge: string;
  holdTier: string;
  multiplier: string;
  rewardPower: string;
};

type DashboardReceiverRow = {
  owner: string;
  totalWbtc: string;
  payoutCount: number;
  lastPaidAt: string;
};

type DashboardRoundRow = {
  id: string;
  status: string;
  createdAt: string;
  claimSol: string;
  rewardWbtc: string;
  paidHolders: number;
};

type DashboardPayload = {
  projectName: string;
  wallet: string;
  holderMint: string;
  rewardMint: string;
  updatedAt: string;
  nextCheckAt: string | null;
  nextCheckSeconds: number | null;
  overview: {
    activeStatus: string;
    activeRoundId: string | null;
    activeQualifiedHolders: number;
    activePaidHolders: number;
    activeRewardWbtc: string;
  };
  live: {
    qualifiedHolders: number;
    payableHolders: number;
    missingRewardAccounts: number;
    totalOwnersScanned: number;
    totalShares: string;
    totalRewardPower: string;
    tierMix: string;
  };
  totals: {
    totalClaimedSol: string;
    totalPaidWbtc: string;
    totalHolderPayments: number;
    roundsTotal: number;
    roundsComplete: number;
    carryForwardSol: string;
  };
  topHolders: DashboardHolderRow[];
  topRewardPower: DashboardHolderRow[];
  topReceivers: DashboardReceiverRow[];
  recentRounds: DashboardRoundRow[];
  tierGuide: Array<{ label: string; multiplier: string; plain: string }>;
};

type WalletCheckPayload = {
  wallet: string;
  holderMint: string;
  rewardMint: string;
  minimumTokens: string;
  holderBalanceTokens: string;
  holderBalanceRaw: string;
  qualifiesNow: boolean;
  hasWbtcAccount: boolean;
  payableNow: boolean;
  message: string;
};

const port = Number(process.env.OVERLAY_PORT ?? "3030");
const signer = loadKeypair(config.devPrivateKey);
const statePath = resolve(config.stateFilePath);
const holdTrackingPath = resolve(config.holdTrackingFilePath);
const runtimeLogPath = resolve("data/logs/runtime.jsonl");
const holderGuideImagePath = resolve("data/site-assets/ryan-on-stream.png");
const holderGuideImageRoute = "/assets/ryan-on-stream.png";
const holdTrackingStore = new HoldTrackingStore(config.holdTrackingFilePath);
const sseClients = new Set<ServerResponse>();

let broadcastTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let lastGoodPayload: OverlayPayload | null = null;
let dashboardCache: { expiresAt: number; payload: DashboardPayload } | null = null;
let stateCache: { size: number; mtimeMs: number; state: WorkerState } | null = null;
let lastRuntimeTsCache: { size: number; mtimeMs: number; ts: string | null } | null = null;
let overlayPayloadCache: { expiresAt: number; payload: OverlayPayload } | null = null;
let overlayPayloadInFlight: Promise<OverlayPayload> | null = null;
let lastGoodMissingPaidUsdCache: { raw: string; usd: number } | null = null;
let lastGoodTotalPaidUsdCache: number | null = null;
let holderMintDecimalsCache: number | null = null;
let qualificationCache: { expiresAt: number; payload: OverlayQualification } | null = null;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const HOLD_TIERS = [
  { label: "30d+", minMs: 30 * DAY_MS, multiplierBps: 12_000, plain: "biggest loyalty bonus" },
  { label: "14d+", minMs: 14 * DAY_MS, multiplierBps: 11_200, plain: "strong loyalty bonus" },
  { label: "7d+", minMs: 7 * DAY_MS, multiplierBps: 10_700, plain: "solid loyalty bonus" },
  { label: "72h+", minMs: 3 * DAY_MS, multiplierBps: 10_300, plain: "small loyalty bonus" },
  { label: "24h+", minMs: DAY_MS, multiplierBps: 10_100, plain: "tiny loyalty bonus" },
  { label: "<24h", minMs: 0, multiplierBps: 10_000, plain: "base reward, no bonus yet" },
] as const;
const OVERLAY_PAYLOAD_CACHE_MS = 3_000;
const QUALIFICATION_CACHE_MS = 30_000;

function parseBigInt(value?: string): bigint {
  if (!value) {
    return 0n;
  }
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function formatSolAmount(lamports: bigint): string {
  return (Number(lamports) / 1e9).toFixed(6);
}

function formatTokenAmount(amount: bigint, decimals: number): string {
  if (amount === 0n) {
    return "0";
  }

  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const fraction = (amount % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

function fromUsdMicros(value?: string): number | null {
  if (!value) {
    return null;
  }
  try {
    return Number(BigInt(value)) / 1_000_000;
  } catch {
    return null;
  }
}

async function getMintDecimalsCached(mintAddress: string): Promise<number> {
  if (mintAddress === config.holderMint && holderMintDecimalsCache !== null) {
    return holderMintDecimalsCache;
  }

  const connection = new Connection(config.rpcUrls[0]!, "confirmed");
  const parsed = await connection.getParsedAccountInfo(new PublicKey(mintAddress), "confirmed");
  const decimals = Number(
    (parsed.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed?.info?.decimals
      ?? 6,
  );

  if (mintAddress === config.holderMint) {
    holderMintDecimalsCache = decimals;
  }

  return decimals;
}

async function buildQualificationSnapshot(): Promise<OverlayQualification> {
  const now = Date.now();
  if (qualificationCache && qualificationCache.expiresAt > now) {
    return qualificationCache.payload;
  }

  const holderDecimals = await getMintDecimalsCached(config.holderMint);
  const minimumRaw = BigInt(Math.floor(config.holderMinTokens * 10 ** holderDecimals));
  const [approxUsd, solUsd] = await Promise.all([
    quoteTokenToUsd(new PublicKey(config.holderMint), minimumRaw),
    quoteTokenToUsd(new PublicKey(SOL_MINT), 1_000_000_000n),
  ]);

  const payload: OverlayQualification = {
    minimumTokens: config.holderMinTokens.toLocaleString(),
    approxUsd,
    approxSol: approxUsd !== null && solUsd && solUsd > 0 ? approxUsd / solUsd : null,
    shareRule: `Every full ${config.holderMinTokens.toLocaleString()} = 1 share`,
    holdRule: "Hold longer = bigger bonus",
    wbtcRule: "No-WBTC accounts need WBTC once",
    resetRule: `Below ${config.holderMinTokens.toLocaleString()} = timer reset`,
  };

  qualificationCache = {
    expiresAt: now + QUALIFICATION_CACHE_MS,
    payload,
  };
  return payload;
}

async function readState(): Promise<WorkerState> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const fileStat = await stat(statePath);
      if (stateCache && stateCache.size === fileStat.size && stateCache.mtimeMs === fileStat.mtimeMs) {
        return stateCache.state;
      }

      const parsed = await readJsonFileWithRecovery<WorkerState>(statePath);
      const normalized: WorkerState = {
        version: 1,
        carryForwardRewardLamports: parsed.carryForwardRewardLamports ?? "0",
        rounds: parsed.rounds ?? [],
      };
      stateCache = {
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        state: normalized,
      };
      return normalized;
    } catch (error) {
      lastError = error;
      await sleep(80);
    }
  }

  throw lastError;
}

function buildRoundView(round: PayoutRoundState, rewardUsd: number | null): OverlayRound {
  const rewardDecimals = round.rewardTokenDecimals ?? 8;
  const paidRecipients = round.recipients.filter((recipient) => recipient.status === "paid").length;
  const pendingRecipients = round.recipients.filter((recipient) => recipient.status === "pending").length;
  const pendingRewardRaw = round.recipients.reduce((total, recipient) => {
    if (recipient.status !== "pending") {
      return total;
    }
    return total + parseBigInt(recipient.amountRaw);
  }, 0n);
  const holders = Math.max(round.eligibleHolderCount, 1);
  const totalRewardRaw = parseBigInt(round.totalRewardRaw);
  const totalWeightUnits = round.totalWeightUnitsRaw
    ? parseBigInt(round.totalWeightUnitsRaw)
    : BigInt(Math.max(round.eligibleHolderCount, 1)) * 10_000n;
  const tierExamples = [...HOLD_TIERS].reverse().map((tier) => ({
    label: tier.label,
    amountWbtc: formatTokenAmount(
      totalWeightUnits > 0n ? (totalRewardRaw * BigInt(tier.multiplierBps)) / totalWeightUnits : 0n,
      rewardDecimals,
    ),
  }));
  const tierCounts = new Map<string, number>();
  for (const recipient of round.recipients) {
    const key = recipient.holdTierLabel ?? "<24h";
    tierCounts.set(key, (tierCounts.get(key) ?? 0) + 1);
  }
  const tierMix = [...HOLD_TIERS]
    .reverse()
    .map((tier) => {
      const count = tierCounts.get(tier.label) ?? 0;
      return count > 0 ? `${tier.label}:${count}` : null;
    })
    .filter((value): value is string => value !== null)
    .join(" ");

  return {
    id: round.id,
    status: round.status,
    createdAt: round.createdAt,
    completedAt: round.completedAt,
    claimSol: formatSolAmount(parseBigInt(round.actualClaimedLamports)),
    rewardWbtc: formatTokenAmount(totalRewardRaw, rewardDecimals),
    rewardUsd,
    holders: round.eligibleHolderCount,
    paidRecipients,
    pendingRecipients,
    pendingRewardWbtc: formatTokenAmount(pendingRewardRaw, rewardDecimals),
    progressPct: Math.min(100, Math.round((paidRecipients / holders) * 100)),
    tierMix,
    baseEntryPayoutWbtc: formatTokenAmount(
      totalWeightUnits > 0n ? (totalRewardRaw * 10_000n) / totalWeightUnits : 0n,
      rewardDecimals,
    ),
    tierExamples,
    claimTx: round.claimTx,
    swapTx: round.swapTx,
    treasuryTx: round.treasuryTx,
  };
}

function buildRecentTransactions(rounds: PayoutRoundState[]): OverlayTx[] {
  const items: OverlayTx[] = [];

  for (const round of rounds) {
    if (round.claimTx) {
      items.push({
        kind: "Claim",
        at: round.createdAt,
        sig: round.claimTx,
        detail: `${formatSolAmount(parseBigInt(round.actualClaimedLamports))} SOL`,
      });
    }

    if (round.treasuryTx) {
      items.push({
        kind: "Ops",
        at: round.createdAt,
        sig: round.treasuryTx,
        detail: "SOL moved",
      });
    }

    if (round.swapTx) {
      items.push({
        kind: "Swap",
        at: round.completedAt ?? round.createdAt,
        sig: round.swapTx,
        detail: `${formatTokenAmount(parseBigInt(round.totalRewardRaw), round.rewardTokenDecimals ?? 8)} WBTC`,
      });
    }

    const distributionMap = new Map<string, { at: string; wallets: number }>();
    for (const recipient of round.recipients) {
      if (!recipient.txSignature || recipient.status !== "paid") {
        continue;
      }

      const existing = distributionMap.get(recipient.txSignature);
      if (existing) {
        existing.wallets += 1;
      } else {
        distributionMap.set(recipient.txSignature, {
          at: recipient.paidAt ?? round.completedAt ?? round.createdAt,
          wallets: 1,
        });
      }
    }

    for (const [sig, info] of distributionMap) {
      items.push({
        kind: "Payout",
        at: info.at,
        sig,
        detail: `${info.wallets} holder${info.wallets === 1 ? "" : "s"}`,
      });
    }
  }

  return items
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, 6);
}

async function buildOverlayPayload(): Promise<OverlayPayload> {
  const now = Date.now();
  if (overlayPayloadCache && overlayPayloadCache.expiresAt > now) {
    return overlayPayloadCache.payload;
  }

  if (overlayPayloadInFlight) {
    return overlayPayloadInFlight;
  }

  overlayPayloadInFlight = computeOverlayPayload();
  try {
    const payload = await overlayPayloadInFlight;
    overlayPayloadCache = {
      expiresAt: Date.now() + OVERLAY_PAYLOAD_CACHE_MS,
      payload,
    };
    return payload;
  } finally {
    overlayPayloadInFlight = null;
  }
}

async function computeOverlayPayload(): Promise<OverlayPayload> {
  try {
    const [state, lastRuntimeTs, qualification] = await Promise.all([
      readState(),
      readLastRuntimeTimestamp(),
      buildQualificationSnapshot(),
    ]);
    const rounds = [...state.rounds].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const totalClaimedLamports = state.rounds.reduce(
      (total, round) => total + parseBigInt(round.actualClaimedLamports),
      0n,
    );
    const totalPaidWbtcRaw = state.rounds.reduce(
      (total, round) => total + round.recipients.reduce((roundTotal, recipient) => {
        if (recipient.status !== "paid") {
          return roundTotal;
        }
        return roundTotal + parseBigInt(recipient.amountRaw);
      }, 0n),
      0n,
    );
    const totalPaidUsd = await getTotalPaidUsd(state);
    const totalHandledUsd = await quoteTokenToUsd(
      new PublicKey("So11111111111111111111111111111111111111112"),
      totalClaimedLamports,
    );
    const holdersPaidTotal = state.rounds.reduce(
      (total, round) => total + round.recipients.filter((recipient) => recipient.status === "paid").length,
      0,
    );
    const awaitingSwapRounds = state.rounds.filter((round) => round.status === "awaiting_swap").length;
    const pendingRounds = state.rounds.filter((round) => round.status === "pending");
    const pendingEntries = pendingRounds.reduce(
      (total, round) => total + round.recipients.filter((recipient) => recipient.status === "pending").length,
      0,
    );
    const pendingRewardRaw = pendingRounds.reduce((total, round) => {
      return total + round.recipients.reduce((roundTotal, recipient) => {
        if (recipient.status !== "pending") {
          return roundTotal;
        }
        return roundTotal + parseBigInt(recipient.amountRaw);
      }, 0n);
    }, 0n);
    const estimatedBatches = Math.ceil(pendingEntries / Math.max(config.maxRecipientsPerTx, 1));
    const pendingEtaSeconds = pendingEntries > 0
      ? estimatedBatches * 3
      : awaitingSwapRounds > 0
        ? 30
        : 0;
    const completeRounds = state.rounds.filter((round) => round.status === "complete").length;
    const recentTxs = buildRecentTransactions(rounds);
    const activeSource = rounds.find((round) => round.status !== "complete") ?? rounds[0];
    const recentRoundSources = rounds.slice(0, 3);
    const recentRounds = await Promise.all(
      recentRoundSources.map(async (round) => buildRoundView(round, await getRoundRewardUsd(round))),
    );
    const activeRound = activeSource
      ? buildRoundView(activeSource, await getRoundRewardUsd(activeSource))
      : null;
    const nextCheck = computeNextCheck(lastRuntimeTs ?? activeRound?.createdAt ?? null);

    const payload: OverlayPayload = {
      projectName: config.projectName,
      wallet: signer.publicKey.toBase58(),
      holderMint: config.holderMint,
      rewardMint: config.rewardMint,
      updatedAt: new Date().toISOString(),
      nextCheckAt: nextCheck.nextCheckAt,
      nextCheckSeconds: nextCheck.nextCheckSeconds,
      qualification,
      totals: {
        roundsTotal: state.rounds.length,
        roundsComplete: completeRounds,
        holdersPaidTotal,
        totalClaimedSol: formatSolAmount(totalClaimedLamports),
        totalPaidWbtc: formatTokenAmount(totalPaidWbtcRaw, 8),
        totalPaidUsd,
        totalHandledUsd,
        carryForwardSol: formatSolAmount(parseBigInt(state.carryForwardRewardLamports)),
        txCount: recentTxs.length,
      },
      queue: {
        awaitingSwapRounds,
        pendingRounds: pendingRounds.length,
        pendingEntries,
        pendingRewardWbtc: formatTokenAmount(pendingRewardRaw, 8),
        pendingEtaSeconds,
      },
      activeRound,
      recentRounds,
      recentTxs,
    };

    lastGoodPayload = payload;
    return payload;
  } catch (error) {
    if (lastGoodPayload) {
      return {
        ...lastGoodPayload,
        updatedAt: new Date().toISOString(),
      };
    }

    throw error;
  }
}

async function getRoundRewardUsd(round: PayoutRoundState): Promise<number | null> {
  const stored = fromUsdMicros(round.rewardUsdMicros);
  if (stored !== null) {
    return stored;
  }

  const totalRewardRaw = parseBigInt(round.totalRewardRaw);
  if (totalRewardRaw <= 0n) {
    return 0;
  }

  return quoteTokenToUsd(new PublicKey(round.rewardMint), totalRewardRaw);
}

async function getTotalPaidUsd(state: WorkerState): Promise<number | null> {
  let storedUsd = 0;
  let storedRewardRaw = 0n;
  let missingRewardRaw = 0n;

  for (const round of state.rounds) {
    const paidRewardRaw = round.recipients.reduce((roundTotal, recipient) => {
      if (recipient.status !== "paid") {
        return roundTotal;
      }
      return roundTotal + parseBigInt(recipient.amountRaw);
    }, 0n);
    const roundStoredUsd = fromUsdMicros(round.rewardUsdMicros);
    if (roundStoredUsd !== null) {
      const roundTotalRewardRaw = parseBigInt(round.totalRewardRaw);
      if (roundTotalRewardRaw > 0n && paidRewardRaw > 0n) {
        storedUsd += roundStoredUsd * (Number(paidRewardRaw) / Number(roundTotalRewardRaw));
        storedRewardRaw += paidRewardRaw;
      }
      continue;
    }

    missingRewardRaw += paidRewardRaw;
  }

  if (missingRewardRaw <= 0n) {
    lastGoodTotalPaidUsdCache = Math.max(lastGoodTotalPaidUsdCache ?? 0, storedUsd);
    return lastGoodTotalPaidUsdCache;
  }

  if (storedUsd > 0 && storedRewardRaw > 0n) {
    const impliedUsdPerRaw = storedUsd / Number(storedRewardRaw);
    const estimatedMissingUsd = Number(missingRewardRaw) * impliedUsdPerRaw;
    const estimatedTotal = storedUsd + estimatedMissingUsd;
    lastGoodTotalPaidUsdCache = Math.max(lastGoodTotalPaidUsdCache ?? 0, estimatedTotal);
    return lastGoodTotalPaidUsdCache;
  }

  const missingUsd = await quoteTokenToUsd(new PublicKey(config.rewardMint), missingRewardRaw);
  if (missingUsd === null) {
    if (lastGoodMissingPaidUsdCache && lastGoodMissingPaidUsdCache.raw === missingRewardRaw.toString()) {
      const recoveredTotal = storedUsd + lastGoodMissingPaidUsdCache.usd;
      lastGoodTotalPaidUsdCache = Math.max(lastGoodTotalPaidUsdCache ?? 0, recoveredTotal);
      return lastGoodTotalPaidUsdCache;
    }
    if (lastGoodTotalPaidUsdCache !== null) {
      return Math.max(lastGoodTotalPaidUsdCache, storedUsd);
    }
    return storedUsd > 0 ? storedUsd : null;
  }

  lastGoodMissingPaidUsdCache = {
    raw: missingRewardRaw.toString(),
    usd: missingUsd,
  };
  const totalPaidUsd = storedUsd + missingUsd;
  lastGoodTotalPaidUsdCache = Math.max(lastGoodTotalPaidUsdCache ?? 0, totalPaidUsd);
  return lastGoodTotalPaidUsdCache;
}

function formatWeightUnits(weightUnits: bigint): string {
  const whole = weightUnits / 10_000n;
  const fraction = (weightUnits % 10_000n).toString().padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function formatMultiplier(multiplierBps: number): string {
  return `${(multiplierBps / 10_000).toFixed(2)}x`;
}

function formatHoldAge(ageMs: number): string {
  if (ageMs >= DAY_MS) {
    return `${Math.floor(ageMs / DAY_MS)}d`;
  }
  if (ageMs >= HOUR_MS) {
    return `${Math.floor(ageMs / HOUR_MS)}h`;
  }
  const minutes = Math.max(0, Math.floor(ageMs / 60000));
  return `${minutes}m`;
}

function formatEta(seconds: number | null): string {
  if (seconds === null || seconds < 0) {
    return "n/a";
  }
  if (seconds < 60) {
    return `~${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) {
    return remSeconds > 0 ? `~${minutes}m ${remSeconds}s` : `~${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `~${hours}h ${remMinutes}m` : `~${hours}h`;
}

function getHoldTier(ageMs: number) {
  return HOLD_TIERS.find((tier) => ageMs >= tier.minMs) ?? HOLD_TIERS[HOLD_TIERS.length - 1]!;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function getRewardAccountPayability(params: {
  connection: Connection;
  rewardMint: PublicKey;
  owners: string[];
}): Promise<{ payableHolders: number; missingRewardAccounts: number }> {
  if (params.owners.length === 0) {
    return { payableHolders: 0, missingRewardAccounts: 0 };
  }

  const rewardMintAccount = await params.connection.getAccountInfo(params.rewardMint, "confirmed");
  if (!rewardMintAccount) {
    return { payableHolders: 0, missingRewardAccounts: params.owners.length };
  }

  const atas = params.owners.map((owner) =>
    getAssociatedTokenAddressSync(
      params.rewardMint,
      new PublicKey(owner),
      true,
      rewardMintAccount.owner,
    ),
  );

  let payableHolders = 0;
  for (const batch of chunkArray(atas, 100)) {
    const infos = await params.connection.getMultipleAccountsInfo(batch, "confirmed");
    payableHolders += infos.filter((info) => info !== null).length;
  }

  return {
    payableHolders,
    missingRewardAccounts: Math.max(0, params.owners.length - payableHolders),
  };
}

async function buildWalletCheckPayload(wallet: string): Promise<WalletCheckPayload> {
  const connection = new Connection(config.rpcUrls[0]!, "confirmed");
  const owner = new PublicKey(wallet);
  const holderMintKey = new PublicKey(config.holderMint);
  const rewardMintKey = new PublicKey(config.rewardMint);

  const holderMintAccount = await connection.getAccountInfo(holderMintKey, "confirmed");
  const rewardMintAccount = await connection.getAccountInfo(rewardMintKey, "confirmed");

  if (!holderMintAccount || !rewardMintAccount) {
    throw new Error("Mint account lookup failed");
  }

  const holderAccounts = await connection.getParsedTokenAccountsByOwner(
    owner,
    { programId: holderMintAccount.owner },
    "confirmed",
  );

  let holderBalanceRaw = 0n;
  for (const account of holderAccounts.value) {
    const parsed = account.account.data.parsed.info as {
      mint?: string;
      tokenAmount?: { amount?: string };
    };
    if (parsed.mint !== holderMintKey.toBase58()) {
      continue;
    }
    holderBalanceRaw += BigInt(parsed.tokenAmount?.amount ?? "0");
  }

  const holderDecimals = Number(
    (holderAccounts.value[0]?.account.data as { parsed?: { info?: { tokenAmount?: { decimals?: number } } } })?.parsed?.info?.tokenAmount?.decimals
      ?? 6,
  );
  const minimumRaw = BigInt(Math.floor(config.holderMinTokens * 10 ** holderDecimals));
  const qualifiesNow = holderBalanceRaw >= minimumRaw;

  const rewardAta = getAssociatedTokenAddressSync(
    rewardMintKey,
    owner,
    true,
    rewardMintAccount.owner,
  );
  const rewardAtaInfo = await connection.getAccountInfo(rewardAta, "confirmed");
  const hasWbtcAccount = rewardAtaInfo !== null;
  const payableNow = qualifiesNow && hasWbtcAccount;

  return {
    wallet,
    holderMint: config.holderMint,
    rewardMint: config.rewardMint,
    minimumTokens: config.holderMinTokens.toLocaleString(),
    holderBalanceTokens: formatTokenAmount(holderBalanceRaw, holderDecimals),
    holderBalanceRaw: holderBalanceRaw.toString(),
    qualifiesNow,
    hasWbtcAccount,
    payableNow,
    message: !qualifiesNow
      ? `This wallet is below ${config.holderMinTokens.toLocaleString()} tokens right now.`
      : hasWbtcAccount
        ? "This wallet is WBTC-ready and payable now."
        : "This wallet qualifies, but it is still a no-WBTC account right now.",
  };
}

async function readHoldTracking() {
  try {
    return await holdTrackingStore.read();
  } catch {
    return {
      version: 1 as const,
      holders: {},
    };
  }
}

async function readLastRuntimeTimestamp(): Promise<string | null> {
  try {
    const fileStat = await stat(runtimeLogPath);
    if (lastRuntimeTsCache && lastRuntimeTsCache.size === fileStat.size && lastRuntimeTsCache.mtimeMs === fileStat.mtimeMs) {
      return lastRuntimeTsCache.ts;
    }

    const raw = await readTailText(runtimeLogPath, 128 * 1024);
    const lines = raw.trim().split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index] ?? "{}") as { ts?: string };
        if (parsed.ts) {
          lastRuntimeTsCache = {
            size: fileStat.size,
            mtimeMs: fileStat.mtimeMs,
            ts: parsed.ts,
          };
          return parsed.ts;
        }
      } catch {}
    }
    lastRuntimeTsCache = {
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      ts: null,
    };
    return null;
  } catch {
    return null;
  }
}

async function readTailText(filePath: string, maxBytes: number): Promise<string> {
  const body = await readFile(filePath);
  if (body.byteLength <= maxBytes) {
    return body.toString("utf8");
  }
  return body.subarray(body.byteLength - maxBytes).toString("utf8");
}

function computeNextCheck(lastSeenAt: string | null): { nextCheckAt: string | null; nextCheckSeconds: number | null } {
  if (!lastSeenAt) {
    return { nextCheckAt: null, nextCheckSeconds: null };
  }

  const baseMs = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(baseMs)) {
    return { nextCheckAt: null, nextCheckSeconds: null };
  }

  const nextMs = baseMs + config.pollIntervalMs;
  return {
    nextCheckAt: new Date(nextMs).toISOString(),
    nextCheckSeconds: Math.max(0, Math.ceil((nextMs - Date.now()) / 1000)),
  };
}

async function buildDashboardPayload(): Promise<DashboardPayload> {
  const cacheNow = Date.now();
  if (dashboardCache && dashboardCache.expiresAt > cacheNow) {
    return dashboardCache.payload;
  }

  const [overlayPayload, state, holdTracking, lastRuntimeTs] = await Promise.all([
    buildOverlayPayload(),
    readState(),
    readHoldTracking(),
    readLastRuntimeTimestamp(),
  ]);
  const excludedOwners = new Set<string>([
    signer.publicKey.toBase58(),
    config.treasuryAddress,
    ...config.excludedHolderAddresses,
  ]);

  const connection = new Connection(config.rpcUrls[0]!, "confirmed");
  const holderSummary = await getHolderSummary(
    connection,
    new PublicKey(config.holderMint),
    config.holderMinTokens,
    excludedOwners,
    config.skipOffCurveOwners,
  );

  const now = Date.now();
  const holderRows = holderSummary.eligible.map((holder) => {
    const owner = holder.owner.toBase58();
    const tracked = holdTracking.holders[owner];
    const eligibleSinceMs = tracked ? new Date(tracked.eligibleSince).getTime() : now;
    const holdAgeMs = Number.isFinite(eligibleSinceMs) ? Math.max(0, now - eligibleSinceMs) : 0;
    const tier = getHoldTier(holdAgeMs);
    const rewardPower = holder.shareCount * BigInt(tier.multiplierBps);

    return {
      owner,
      balanceTokens: formatTokenAmount(holder.rawBalance, holderSummary.decimals),
      shares: holder.shareCount.toString(),
      holdAge: formatHoldAge(holdAgeMs),
      holdTier: tier.label,
      multiplier: formatMultiplier(tier.multiplierBps),
      rewardPower: formatWeightUnits(rewardPower),
      rewardPowerRaw: rewardPower,
      balanceRaw: holder.rawBalance,
    };
  });

  const topHolders = [...holderRows]
    .sort((left, right) => (left.balanceRaw === right.balanceRaw ? left.owner.localeCompare(right.owner) : left.balanceRaw > right.balanceRaw ? -1 : 1))
    .slice(0, 12)
    .map(stripDashboardHolderRow);

  const topRewardPower = [...holderRows]
    .sort((left, right) => (left.rewardPowerRaw === right.rewardPowerRaw ? left.owner.localeCompare(right.owner) : left.rewardPowerRaw > right.rewardPowerRaw ? -1 : 1))
    .slice(0, 12)
    .map(stripDashboardHolderRow);
  const payability = await getRewardAccountPayability({
    connection,
    rewardMint: new PublicKey(config.rewardMint),
    owners: holderRows.map((holder) => holder.owner),
  });

  const topReceivers = buildTopReceivers(state.rounds);
  const recentRounds = [...state.rounds]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 8)
    .map((round) => ({
      id: round.id,
      status: round.status,
      createdAt: round.createdAt,
      claimSol: formatSolAmount(parseBigInt(round.actualClaimedLamports)),
      rewardWbtc: formatTokenAmount(parseBigInt(round.totalRewardRaw), round.rewardTokenDecimals ?? 8),
      paidHolders: round.recipients.filter((recipient) => recipient.status === "paid").length,
    }));

  const activeRound = overlayPayload.activeRound;
  const tierMix = summarizeTierMix(holderRows);
  const totalRewardPowerRaw = holderRows.reduce((total, holder) => total + holder.rewardPowerRaw, 0n);
  const nextCheck = computeNextCheck(lastRuntimeTs ?? activeRound?.createdAt ?? null);

  const payload: DashboardPayload = {
    projectName: config.projectName,
    wallet: signer.publicKey.toBase58(),
    holderMint: config.holderMint,
    rewardMint: config.rewardMint,
    updatedAt: new Date().toISOString(),
    nextCheckAt: nextCheck.nextCheckAt,
    nextCheckSeconds: nextCheck.nextCheckSeconds,
    overview: {
      activeStatus: activeRound?.status ?? "idle",
      activeRoundId: activeRound?.id ?? null,
      activeQualifiedHolders: activeRound?.holders ?? 0,
      activePaidHolders: activeRound?.paidRecipients ?? 0,
      activeRewardWbtc: activeRound?.rewardWbtc ?? "0",
    },
    live: {
      qualifiedHolders: holderRows.length,
      payableHolders: payability.payableHolders,
      missingRewardAccounts: payability.missingRewardAccounts,
      totalOwnersScanned: holderSummary.totalOwners,
      totalShares: holderSummary.totalShares.toString(),
      totalRewardPower: formatWeightUnits(totalRewardPowerRaw),
      tierMix,
    },
    totals: {
      totalClaimedSol: overlayPayload.totals.totalClaimedSol,
      totalPaidWbtc: overlayPayload.totals.totalPaidWbtc,
      totalHolderPayments: overlayPayload.totals.holdersPaidTotal,
      roundsTotal: overlayPayload.totals.roundsTotal,
      roundsComplete: overlayPayload.totals.roundsComplete,
      carryForwardSol: overlayPayload.totals.carryForwardSol,
    },
    topHolders,
    topRewardPower,
    topReceivers,
    recentRounds,
    tierGuide: [...HOLD_TIERS].reverse().map((tier) => ({
      label: tier.label,
      multiplier: formatMultiplier(tier.multiplierBps),
      plain: tier.plain,
    })),
  };

  dashboardCache = {
    expiresAt: Date.now() + 30_000,
    payload,
  };
  return payload;
}

function stripDashboardHolderRow(row: DashboardHolderRow & { rewardPowerRaw: bigint; balanceRaw: bigint }): DashboardHolderRow {
  return {
    owner: row.owner,
    balanceTokens: row.balanceTokens,
    shares: row.shares,
    holdAge: row.holdAge,
    holdTier: row.holdTier,
    multiplier: row.multiplier,
    rewardPower: row.rewardPower,
  };
}

function summarizeTierMix(rows: Array<{ holdTier: string }>): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.holdTier, (counts.get(row.holdTier) ?? 0) + 1);
  }

  return [...HOLD_TIERS]
    .reverse()
    .map((tier) => {
      const count = counts.get(tier.label) ?? 0;
      return count > 0 ? `${tier.label}:${count}` : null;
    })
    .filter((value): value is string => value !== null)
    .join(" ");
}

function buildTopReceivers(rounds: PayoutRoundState[]): DashboardReceiverRow[] {
  const totals = new Map<string, { amountRaw: bigint; payoutCount: number; lastPaidAt: string }>();

  for (const round of rounds) {
    for (const recipient of round.recipients) {
      if (recipient.status !== "paid") {
        continue;
      }

      const current = totals.get(recipient.owner) ?? {
        amountRaw: 0n,
        payoutCount: 0,
        lastPaidAt: "",
      };
      current.amountRaw += parseBigInt(recipient.amountRaw);
      current.payoutCount += 1;
      if ((recipient.paidAt ?? "") > current.lastPaidAt) {
        current.lastPaidAt = recipient.paidAt ?? "";
      }
      totals.set(recipient.owner, current);
    }
  }

  return [...totals.entries()]
    .sort((left, right) => {
      if (left[1].amountRaw === right[1].amountRaw) {
        return left[0].localeCompare(right[0]);
      }
      return left[1].amountRaw > right[1].amountRaw ? -1 : 1;
    })
    .slice(0, 12)
    .map(([owner, info]) => ({
      owner,
      totalWbtc: formatTokenAmount(info.amountRaw, 8),
      payoutCount: info.payoutCount,
      lastPaidAt: info.lastPaidAt,
    }));
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(renderOverlayHtml());
}

function sendPaidSummaryHtml(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(renderPaidSummaryHtml());
}

function sendDashboardHtml(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(renderDashboardHtml());
}

function sendWalletCheckHtml(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(renderWalletCheckHtml());
}

async function sendPngFile(res: ServerResponse, filePath: string): Promise<void> {
  const body = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=3600",
    "Content-Length": body.byteLength,
  });
  res.end(body);
}

function sendSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("\n");
}

async function pushPayload(res: ServerResponse): Promise<void> {
  try {
    const payload = await buildOverlayPayload();
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {}
}

function scheduleBroadcast(): void {
  if (broadcastTimer) {
    clearTimeout(broadcastTimer);
  }

  dashboardCache = null;
  overlayPayloadCache = null;

  broadcastTimer = setTimeout(() => {
    void broadcastUpdate();
  }, 500);
}

async function broadcastUpdate(): Promise<void> {
  if (sseClients.size === 0) {
    return;
  }

  try {
    const payload = await buildOverlayPayload();
    const chunk = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of [...sseClients]) {
      try {
        client.write(chunk);
      } catch {
        sseClients.delete(client);
      }
    }
  } catch {
    for (const client of [...sseClients]) {
      try {
        client.write("event: keepalive\ndata: {}\n\n");
      } catch {
        sseClients.delete(client);
      }
    }
  }
}

function startHeartbeat(): void {
  heartbeatTimer = setInterval(() => {
    void broadcastUpdate();
  }, 10_000);
}

function startFileWatch(filePath: string): void {
  try {
    watch(filePath, () => {
      if (filePath === statePath) {
        stateCache = null;
      }
      if (filePath === runtimeLogPath) {
        lastRuntimeTsCache = null;
      }
      scheduleBroadcast();
    });
  } catch {}
}

function startDirectoryWatch(filePath: string): void {
  try {
    watch(dirname(filePath), () => {
      if (filePath === statePath) {
        stateCache = null;
      }
      if (filePath === runtimeLogPath) {
        lastRuntimeTsCache = null;
      }
      scheduleBroadcast();
    });
  } catch {}
}

function renderOverlayHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(config.projectName)} Overlay</title>
  <style>
    :root {
      --bg: rgba(8, 7, 6, 0.84);
      --panel: rgba(16, 13, 10, 0.92);
      --panel-2: rgba(11, 9, 7, 0.95);
      --line: rgba(255, 166, 0, 0.18);
      --text: #fff7e6;
      --muted: #c5b8a0;
      --green: #6de01f;
      --cyan: #69d4ff;
      --gold: #ffb11b;
      --orange: #ff8c00;
      --amber: #ffd15a;
      --shadow: 0 22px 62px rgba(0, 0, 0, 0.44);
      --mono: Consolas, "SFMono-Regular", Menlo, monospace;
      --sans: "Trebuchet MS", "Segoe UI", Tahoma, sans-serif;
      --display: Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif;
    }

    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; overflow: hidden; color: var(--text); font-family: var(--sans); }
    body {
      background:
        radial-gradient(circle at top left, rgba(255, 140, 0, 0.16), transparent 26%),
        radial-gradient(circle at top right, rgba(109, 224, 31, 0.12), transparent 22%),
        #040404;
      padding: 8px;
    }
    body.transparent { background: transparent; }
    .scene {
      width: min(1120px, 100%);
      height: calc(100vh - 16px);
      margin: 0 auto;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 8px;
      overflow: hidden;
    }
    .shell, .panel {
      background: var(--bg);
      backdrop-filter: blur(16px);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      border-radius: 18px;
      overflow: hidden;
    }
    .shell {
      padding: 9px 11px 10px;
      position: relative;
    }
    .shell::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      border: 1px solid rgba(255,255,255,0.02);
      border-radius: 18px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: flex-end;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .eyebrow {
      font-family: var(--mono);
      font-size: 10px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--green);
      margin-bottom: 4px;
      font-weight: 800;
    }
    h1 {
      margin: 0;
      line-height: 0.95;
      font-size: clamp(22px, 3vw, 36px);
      font-family: var(--display);
      color: var(--orange);
      letter-spacing: 0.04em;
    }
    .subline {
      margin-top: 4px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 11px;
    }
    .live-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid rgba(255,166,0,0.26);
      background: rgba(255,166,0,0.08);
      color: var(--amber);
      border-radius: 999px;
      padding: 7px 11px;
      font-weight: 700;
      white-space: nowrap;
      font-family: var(--mono);
      transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease;
    }
    .live-chip.bump {
      transform: translateY(-1px) scale(1.015);
      box-shadow: 0 0 0 1px rgba(255,166,0,0.15), 0 0 24px rgba(255,166,0,0.12);
      border-color: rgba(255,166,0,0.4);
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 14px rgba(109,224,31,0.7);
      animation: pulse 1.3s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(0.9); opacity: 0.75; }
      50% { transform: scale(1.15); opacity: 1; }
      100% { transform: scale(0.9); opacity: 0.75; }
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 6px;
    }
    .stat {
      background: var(--panel);
      border: 1px solid rgba(255,166,0,0.12);
      border-radius: 14px;
      padding: 9px 10px;
      min-height: 64px;
      position: relative;
      overflow: hidden;
      transition: border-color 160ms ease, box-shadow 160ms ease;
    }
    .stat.bump {
      border-color: rgba(255,166,0,0.28);
      box-shadow: 0 0 0 1px rgba(255,166,0,0.06);
    }
    .stat::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      top: 0;
      height: 2px;
      background: linear-gradient(90deg, rgba(255,140,0,0.95), rgba(109,224,31,0.55));
      opacity: 0.75;
    }
    .label {
      color: var(--muted);
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      font-family: var(--mono);
    }
    .value {
      margin-top: 6px;
      font-size: clamp(15px, 1.5vw, 22px);
      font-weight: 800;
      line-height: 1;
    }
    .note {
      margin-top: 3px;
      color: var(--muted);
      font-size: 9px;
    }
    .layout {
      display: grid;
      grid-template-columns: 1.05fr 0.95fr;
      gap: 10px;
      min-height: 0;
    }
    .panel {
      padding: 9px;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .panel-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: baseline;
      margin-bottom: 8px;
      font-family: var(--mono);
    }
    .panel-title {
      font-size: 14px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--amber);
    }
    .panel-meta {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .current-round {
      display: grid;
      gap: 8px;
    }
    .round-strip {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
      padding: 9px 10px;
      background: var(--panel-2);
      border: 1px solid rgba(255,166,0,0.12);
      border-radius: 12px;
    }
    .round-id {
      color: var(--amber);
      font-weight: 800;
      font-family: var(--mono);
      font-size: 13px;
    }
    .status {
      border-radius: 999px;
      padding: 5px 8px;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-family: var(--mono);
      border: 1px solid rgba(109,224,31,0.2);
      color: var(--green);
      background: rgba(109,224,31,0.08);
    }
    .status.pending { color: var(--gold); border-color: rgba(255,177,27,0.22); background: rgba(255,177,27,0.08); }
    .status.awaiting_swap { color: var(--cyan); border-color: rgba(118,231,255,0.2); background: rgba(118,231,255,0.08); }
    .status.complete { color: var(--green); }
    .metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }
    .metric {
      background: rgba(255,255,255,0.03);
      border-radius: 12px;
      padding: 7px;
      border: 1px solid rgba(255,166,0,0.08);
    }
    .metric .value {
      font-size: 13px;
      margin-top: 4px;
    }
    .status-note {
      padding: 8px 10px;
      background: rgba(109,224,31,0.05);
      border: 1px solid rgba(109,224,31,0.12);
      border-radius: 12px;
      color: #e9ffd5;
      font-size: 12px;
      line-height: 1.25;
    }
    .progress-box {
      padding: 7px 9px;
      background: var(--panel-2);
      border: 1px solid rgba(255,166,0,0.1);
      border-radius: 12px;
    }
    .progress-top {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 6px;
      font-family: var(--mono);
      color: var(--muted);
      font-size: 11px;
    }
    .bar {
      width: 100%;
      height: 12px;
      border-radius: 999px;
      background: rgba(255,255,255,0.05);
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.06);
    }
    .bar-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, var(--orange), var(--gold), var(--green));
      box-shadow: 0 0 20px rgba(255,140,0,0.22);
      transition: width 320ms ease;
    }
    .flash {
      animation: liveFlash 0.55s ease;
    }
    @keyframes liveFlash {
      0% { box-shadow: 0 0 0 0 rgba(126,255,189,0.28); }
      40% { box-shadow: 0 0 0 7px rgba(126,255,189,0.12); }
      100% { box-shadow: 0 0 0 0 rgba(126,255,189,0); }
    }
    .tick {
      color: var(--gold);
      font-weight: 800;
    }
    .rows, .txs {
      display: grid;
      gap: 7px;
      min-height: 0;
      overflow: hidden;
    }
    .image-frame {
      overflow: hidden;
      border-radius: 16px;
      border: 1px solid rgba(255,255,255,0.07);
      background: #040708;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02);
    }
    .image-frame img {
      display: block;
      width: 100%;
      height: auto;
    }
    .guide-notes {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px;
      margin-top: 8px;
    }
    .guide-mini {
      background: var(--panel-2);
      border: 1px solid rgba(255,166,0,0.1);
      border-radius: 12px;
      padding: 8px 9px;
    }
    .guide-mini .k {
      color: var(--gold);
      font-family: var(--mono);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 4px;
      font-weight: 800;
    }
    .guide-mini .v {
      color: var(--text);
      font-size: 12px;
      line-height: 1.15;
    }
    .row-card, .tx-card {
      background: var(--panel-2);
      border: 1px solid rgba(255,166,0,0.1);
      border-radius: 12px;
      padding: 7px 9px;
    }
    .row-head, .tx-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      font-family: var(--mono);
    }
    .row-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
      margin-top: 7px;
    }
    .mini {
      background: rgba(255,255,255,0.03);
      border-radius: 10px;
      padding: 5px 7px;
    }
    .mini .value {
      font-size: 12px;
      margin-top: 3px;
    }
    .sig {
      color: var(--muted);
      font-family: var(--mono);
      font-size: 12px;
    }
    .tx-kind {
      font-weight: 800;
      color: var(--green);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 11px;
    }
    .friendly {
      color: var(--muted);
      font-size: 11px;
      margin-top: 5px;
      line-height: 1.15;
    }
    .text {
      margin-top: 4px;
      color: var(--text);
      font-size: 11px;
      line-height: 1.15;
    }
    .muted { color: var(--muted); }
    .empty {
      text-align: center;
      color: var(--muted);
      border: 1px dashed rgba(255,255,255,0.12);
      border-radius: 16px;
      padding: 14px;
      font-family: var(--mono);
    }
    @media (max-height: 900px) {
      .stats { gap: 5px; }
      .value { font-size: clamp(14px, 1.3vw, 20px); }
      .status-note { font-size: 11px; }
      .row-grid, .metrics { gap: 5px; }
      .txs { gap: 6px; }
    }
    @media (max-width: 1260px) {
      .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .layout { grid-template-columns: 1fr; }
    }
    @media (max-width: 760px) {
      body { padding: 8px; }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metrics, .row-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .guide-notes { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="scene">
    <section class="shell">
      <div class="header">
        <div>
          <div class="eyebrow">Live Reward Board</div>
          <h1 id="projectName">Bitcoin Bank</h1>
          <div class="subline" id="subline">Loading overlay feed...</div>
        </div>
        <div class="live-chip" id="liveChip"><span class="dot"></span><span id="updatedAt">Waiting for live data</span></div>
      </div>

      <div class="stats">
        <div class="stat" id="statValue">
          <div class="label">All-Time Value Sent</div>
          <div class="value" id="totalUsd">0</div>
          <div class="note">What holders have already received</div>
        </div>
        <div class="stat" id="statWbtc">
          <div class="label">WBTC Paid Total</div>
          <div class="value" id="totalWbtc">0</div>
          <div class="note">All completed holder payouts</div>
        </div>
        <div class="stat" id="statHolders">
          <div class="label">Holder Deliveries</div>
          <div class="value" id="holdersPaid">0</div>
          <div class="note">Equal-share sends landed</div>
        </div>
        <div class="stat" id="statRounds">
          <div class="label">Rounds Complete</div>
          <div class="value" id="roundsComplete">0</div>
          <div class="note">Closed payout rounds</div>
        </div>
        <div class="stat" id="statQualify">
          <div class="label">Qualify Now</div>
          <div class="value" id="qualifyNow">0</div>
          <div class="note">Current token line for rewards</div>
        </div>
        <div class="stat" id="statCost">
          <div class="label">Approx Entry Cost</div>
          <div class="value" id="qualifyCost">0</div>
          <div class="note">Updates with live market pricing</div>
        </div>
      </div>
    </section>

    <section class="layout">
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">Live Payouts</div>
          <div class="panel-meta" id="walletShort"></div>
        </div>
        <div id="activeRound" class="current-round"></div>
        <div class="panel-head" style="margin-top: 10px;">
          <div class="panel-title">Recent Reward Rounds</div>
          <div class="panel-meta">Last 2</div>
        </div>
        <div id="rounds" class="rows"></div>
        <div class="panel-head" style="margin-top: 10px;">
          <div class="panel-title">Latest Activity</div>
          <div class="panel-meta">Live but calmer</div>
        </div>
        <div id="txs" class="txs"></div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">Holder Guide</div>
          <div class="panel-meta">One-screen explainer</div>
        </div>
        <div class="image-frame">
          <img src="${holderGuideImageRoute}" alt="Bitcoin Bank live stream holder reward guide" />
        </div>
        <div class="guide-notes">
          <div class="guide-mini"><div class="k">Entry Line</div><div class="v" id="guideEntry">Loading current qualify line...</div></div>
          <div class="guide-mini"><div class="k">Share Rule</div><div class="v" id="guideShares">Every full bag step adds reward shares.</div></div>
          <div class="guide-mini"><div class="k">Hold Bonus</div><div class="v" id="guideHold">Holding longer increases reward power.</div></div>
          <div class="guide-mini"><div class="k">Wallet Setup</div><div class="v" id="guideWbtc">No-WBTC accounts need WBTC once before future drops can land.</div></div>
        </div>
      </div>
    </section>
  </div>

  <script>
    const transparent = new URLSearchParams(window.location.search).get("transparent");
    if (transparent === "1" || transparent === "true") {
      document.body.classList.add("transparent");
    }

    const fmtTime = (iso) => {
      try {
        return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      } catch {
        return iso;
      }
    };

    const short = (value, left = 8, right = 8) => {
      if (!value || value.length <= left + right + 3) return value || "";
      return value.slice(0, left) + "..." + value.slice(-right);
    };

    const formatEta = (seconds) => {
      if (seconds === null || seconds === undefined) return "calculating";
      if (seconds <= 0) return "now";
      if (seconds < 60) return "~" + seconds + "s";
      const minutes = Math.floor(seconds / 60);
      const remSeconds = seconds % 60;
      if (minutes < 60) return remSeconds > 0 ? "~" + minutes + "m " + remSeconds + "s" : "~" + minutes + "m";
      const hours = Math.floor(minutes / 60);
      const remMinutes = minutes % 60;
      return remMinutes > 0 ? "~" + hours + "h " + remMinutes + "m" : "~" + hours + "h";
    };

    function renderActiveRound(round) {
      const root = document.getElementById("activeRound");
      if (!round) {
        root.innerHTML = '<div class="empty">No rounds yet. Start the bot and this board will fill itself.</div>';
        return;
      }

      const remaining = Math.max(0, round.holders - round.paidRecipients);
      const statusCopy = round.status === "awaiting_swap"
        ? "This round is waiting for the SOL to WBTC swap to land before holder payouts can continue."
        : round.status === "pending"
          ? "This round is actively paying holders now. Some wallets may still be waiting because they are still no-WBTC accounts."
          : "This round is fully settled and every saved payout for it has already landed.";

      root.innerHTML = \`
        <div class="round-strip">
          <div class="round-id">\${round.id}</div>
          <div class="status \${round.status}">\${round.status.replaceAll("_", " ")}</div>
        </div>
        <div class="status-note">\${statusCopy}</div>
        <div class="metrics">
          <div class="metric"><div class="label">Claimed</div><div class="value">\${round.claimSol} SOL</div></div>
          <div class="metric"><div class="label">WBTC For Holders</div><div class="value">\${round.rewardWbtc}</div></div>
          <div class="metric"><div class="label">Qualified / Paid</div><div class="value">\${round.holders} / \${round.paidRecipients}</div></div>
          <div class="metric"><div class="label">Still Owed</div><div class="value">\${round.pendingRewardWbtc} WBTC</div></div>
        </div>
        <div class="progress-box">
          <div class="progress-top">
            <span>Round progress</span>
            <span>\${remaining} left</span>
          </div>
          <div class="bar"><div class="bar-fill" style="width:\${round.progressPct}%"></div></div>
        </div>
      \`;
    }

    function renderRounds(rounds) {
      const root = document.getElementById("rounds");
      if (!rounds.length) {
        root.innerHTML = '<div class="empty">No payout rounds recorded yet.</div>';
        return;
      }

      root.innerHTML = rounds.slice(0, 2).map((round) => \`
        <div class="row-card">
          <div class="row-head">
            <div class="round-id">\${round.id}</div>
            <div class="status \${round.status}">\${round.status.replaceAll("_", " ")}</div>
          </div>
          <div class="row-grid">
            <div class="mini"><div class="label">Claimed</div><div class="value">\${round.claimSol} SOL</div></div>
            <div class="mini"><div class="label">WBTC Out</div><div class="value">\${round.rewardWbtc}</div></div>
            <div class="mini"><div class="label">Qualified</div><div class="value">\${round.holders}</div></div>
            <div class="mini"><div class="label">Paid</div><div class="value">\${round.paidRecipients}</div></div>
          </div>
          <div class="progress-box" style="margin-top:10px;">
            <div class="progress-top">
              <span>Round progress</span>
              <span>\${round.progressPct}%</span>
            </div>
            <div class="bar"><div class="bar-fill" style="width:\${round.progressPct}%"></div></div>
          </div>
          <div class="subline">Started \${fmtTime(round.createdAt)}\${round.completedAt ? " | Settled " + fmtTime(round.completedAt) : ""}</div>
        </div>
      \`).join("");
    }

    function renderTxs(txs) {
      const root = document.getElementById("txs");
      if (!txs.length) {
        root.innerHTML = '<div class="empty">Waiting for live transactions...</div>';
        return;
      }

      const explainKind = (kind) => {
        if (kind === "Claim") return "Creator rewards were claimed into the bot wallet.";
        if (kind === "Ops") return "Treasury share was sent out.";
        if (kind === "Swap") return "Holder-side SOL was turned into WBTC.";
        if (kind === "Payout") return "A holder payout batch landed.";
        return "Live wallet activity.";
      };

      root.innerHTML = txs.slice(0, 3).map((tx) => \`
        <div class="tx-card">
          <div class="tx-head">
            <div class="tx-kind">\${tx.kind}</div>
            <div class="muted">\${fmtTime(tx.at)}</div>
          </div>
          <div class="text">\${tx.detail}</div>
          <div class="friendly">\${explainKind(tx.kind)}</div>
          <div class="sig">\${short(tx.sig, 12, 12)}</div>
        </div>
      \`).join("");
    }

    function escapeHtmlJs(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    let packetCount = 0;
    let lastPushMs = 0;
    let nextCheckAtMs = null;
    let currentWalletShort = "";
    let currentRewardMintShort = "";
    let ageTimer = null;

    function bump(el) {
      if (!el) return;
      el.classList.remove("bump");
      void el.offsetWidth;
      el.classList.add("bump");
      setTimeout(() => {
        el.classList.remove("bump");
      }, 700);
    }

    function startAgeTicker() {
      if (ageTimer) clearInterval(ageTimer);
      ageTimer = setInterval(updateLiveStamp, 1000);
    }

    function updateLiveStamp() {
      if (!lastPushMs) return;
      const seconds = Math.max(0, Math.floor((Date.now() - lastPushMs) / 1000));
      const idle = seconds === 0 ? "just now" : seconds === 1 ? "1s ago" : seconds + "s ago";
      const stale = seconds >= 15;
      document.getElementById("updatedAt").innerHTML = stale
        ? '<span class="tick" style="background:#7f1d1d;color:#fecaca;">STALE</span> | last sync ' + idle + ' | reconnecting'
        : '<span class="tick">SYNC OK</span> | last sync ' + idle + ' | push ' + packetCount;
      const nextCycle = nextCheckAtMs === null
        ? "calculating"
        : Math.max(0, Math.ceil((nextCheckAtMs - Date.now()) / 1000)) <= 0
          ? "now"
          : formatEta(Math.max(0, Math.ceil((nextCheckAtMs - Date.now()) / 1000)));
      if (currentWalletShort && currentRewardMintShort) {
        document.getElementById("subline").textContent =
          "Wallet " + currentWalletShort + " | Next main cycle " + nextCycle + " | Reward mint " + currentRewardMintShort;
      }
    }

    function applyPayload(data) {
      packetCount += 1;
      lastPushMs = Date.now();
      nextCheckAtMs = data.nextCheckAt ? new Date(data.nextCheckAt).getTime() : null;
      currentWalletShort = short(data.wallet, 10, 10);
      currentRewardMintShort = short(data.rewardMint, 8, 8);
      document.getElementById("projectName").textContent = data.projectName;
      document.getElementById("subline").textContent =
        "Wallet " + currentWalletShort + " | Next main cycle " + (data.nextCheckSeconds === null ? "calculating" : data.nextCheckSeconds <= 0 ? "now" : formatEta(data.nextCheckSeconds)) + " | Reward mint " + currentRewardMintShort;
      updateLiveStamp();
      document.getElementById("walletShort").textContent = short(data.wallet, 12, 12);
      document.getElementById("totalUsd").textContent = data.totals.totalPaidUsd === null
        ? "pricing..."
        : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(data.totals.totalPaidUsd);
      document.getElementById("totalWbtc").textContent = data.totals.totalPaidWbtc;
      document.getElementById("holdersPaid").textContent = String(data.totals.holdersPaidTotal);
      document.getElementById("roundsComplete").textContent = data.totals.roundsComplete + " / " + data.totals.roundsTotal;
      document.getElementById("qualifyNow").textContent = data.qualification.minimumTokens;
      document.getElementById("qualifyCost").textContent = data.qualification.approxUsd === null
        ? "pricing..."
        : "~" + usdFormatter.format(data.qualification.approxUsd) + (data.qualification.approxSol === null ? "" : " • ~" + data.qualification.approxSol.toFixed(3) + " SOL");
      document.getElementById("guideEntry").innerHTML =
        "<strong>" + escapeHtmlJs(data.qualification.minimumTokens) + " BTCBANK</strong> qualifies right now.";
      document.getElementById("guideShares").textContent = data.qualification.shareRule + ".";
      document.getElementById("guideHold").textContent = data.qualification.holdRule + ".";
      document.getElementById("guideWbtc").textContent = data.qualification.wbtcRule + ". " + data.qualification.resetRule + ".";
      bump(document.getElementById("liveChip"));
      renderActiveRound(data.activeRound);
      renderRounds(data.recentRounds);
      renderTxs(data.recentTxs);
    }

    let staleRecoverAt = 0;

    async function loadOnce() {
      const res = await fetch("/api/overlay?_ts=" + Date.now(), { cache: "no-store" });
      const data = await res.json();
      applyPayload(data);
    }

    function connectLive() {
      const stream = new EventSource("/api/stream");
      stream.onmessage = (event) => {
        try {
          applyPayload(JSON.parse(event.data));
        } catch {}
      };
      stream.onerror = () => {
        stream.close();
        setTimeout(connectLive, 1500);
      };
    }

    loadOnce().catch((error) => {
      document.getElementById("subline").textContent = "Overlay load failed: " + error;
    });
    startAgeTicker();
    connectLive();
    setInterval(() => {
      loadOnce().catch(() => {});
    }, 5000);
    setInterval(() => {
      if (!lastPushMs) return;
      const ageMs = Date.now() - lastPushMs;
      if (ageMs < 15000) return;
      if (Date.now() - staleRecoverAt < 5000) return;
      staleRecoverAt = Date.now();
      loadOnce().catch(() => {});
    }, 3000);
  </script>
</body>
</html>`;
}

function renderWalletCheckHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(config.projectName)} Wallet Check</title>
  <style>
    :root {
      --bg: #090705;
      --panel: rgba(16, 13, 10, 0.95);
      --line: rgba(255, 166, 0, 0.18);
      --text: #fff7e6;
      --muted: #c5b8a0;
      --green: #6de01f;
      --orange: #ff8c00;
      --amber: #ffd15a;
      --red: #f87171;
      --mono: Consolas, "SFMono-Regular", Menlo, monospace;
      --display: Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(circle at top left, rgba(255,140,0,0.16), transparent 26%), #050505;
      color: var(--text);
      font-family: var(--mono);
      padding: 24px;
    }
    .shell {
      width: min(760px, 100%);
      margin: 0 auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 22px;
      padding: 22px;
    }
    h1 {
      margin: 0 0 8px;
      color: var(--orange);
      font-family: var(--display);
      letter-spacing: 0.04em;
      font-size: clamp(28px, 5vw, 48px);
    }
    .sub {
      color: var(--muted);
      margin-bottom: 18px;
      line-height: 1.5;
    }
    .row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    input {
      flex: 1 1 480px;
      min-width: 0;
      padding: 14px 16px;
      border-radius: 14px;
      border: 1px solid rgba(255,166,0,0.22);
      background: rgba(255,255,255,0.04);
      color: var(--text);
      font: inherit;
    }
    button {
      padding: 14px 18px;
      border: 0;
      border-radius: 14px;
      background: linear-gradient(135deg, #ff8c00, #ffd15a);
      color: #1f1300;
      font: inherit;
      font-weight: 800;
      cursor: pointer;
    }
    .result {
      margin-top: 18px;
      padding: 18px;
      border-radius: 18px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.03);
      display: none;
    }
    .result.show { display: block; }
    .ok { color: var(--green); }
    .bad { color: var(--red); }
    .warn { color: var(--amber); }
    .grid {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      margin-top: 14px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 12px;
      background: rgba(0,0,0,0.18);
    }
    .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.12em; }
    .value { margin-top: 6px; font-size: 28px; font-weight: 800; }
    .msg { margin-top: 12px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="shell">
    <h1>Wallet Check</h1>
    <div class="sub">Paste a wallet and check if it qualifies right now, whether it is already WBTC-ready, and whether it is payable now.</div>
    <div class="row">
      <input id="wallet" placeholder="Paste Solana wallet address" />
      <button id="checkBtn">Check Wallet</button>
    </div>
    <div class="result" id="result">
      <div class="msg" id="message"></div>
      <div class="grid">
        <div class="card"><div class="label">Qualifies Now</div><div class="value" id="qualifiesNow">-</div></div>
        <div class="card"><div class="label">WBTC Account</div><div class="value" id="hasWbtcAccount">-</div></div>
        <div class="card"><div class="label">Payable Now</div><div class="value" id="payableNow">-</div></div>
        <div class="card"><div class="label">Holder Balance</div><div class="value" id="holderBalance">-</div></div>
      </div>
    </div>
  </div>
  <script>
    const walletInput = document.getElementById("wallet");
    const result = document.getElementById("result");
    const message = document.getElementById("message");
    const qualifiesNow = document.getElementById("qualifiesNow");
    const hasWbtcAccount = document.getElementById("hasWbtcAccount");
    const payableNow = document.getElementById("payableNow");
    const holderBalance = document.getElementById("holderBalance");

    function paint(el, yes, unknown) {
      el.className = "value " + (unknown ? "warn" : yes ? "ok" : "bad");
    }

    async function checkWallet() {
      const wallet = walletInput.value.trim();
      if (!wallet) return;
      message.textContent = "Checking...";
      result.classList.add("show");
      try {
        const res = await fetch("/api/wallet-check?wallet=" + encodeURIComponent(wallet), { cache: "no-store" });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || "Wallet check failed");
        }
        message.textContent = data.message;
        qualifiesNow.textContent = data.qualifiesNow ? "YES" : "NO";
        hasWbtcAccount.textContent = data.hasWbtcAccount ? "YES" : "NO";
        payableNow.textContent = data.payableNow ? "YES" : "NO";
        holderBalance.textContent = data.holderBalanceTokens;
        paint(qualifiesNow, data.qualifiesNow, false);
        paint(hasWbtcAccount, data.hasWbtcAccount, false);
        paint(payableNow, data.payableNow, false);
      } catch (error) {
        message.textContent = error instanceof Error ? error.message : String(error);
        qualifiesNow.textContent = "-";
        hasWbtcAccount.textContent = "-";
        payableNow.textContent = "-";
        holderBalance.textContent = "-";
        paint(qualifiesNow, false, true);
        paint(hasWbtcAccount, false, true);
        paint(payableNow, false, true);
      }
    }

    document.getElementById("checkBtn").addEventListener("click", checkWallet);
    walletInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        checkWallet();
      }
    });
  </script>
</body>
</html>`;
}

function renderPaidSummaryHtml(): string {
  const baseEntryLabel = config.holderMinTokens.toLocaleString();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(config.projectName)} Paid Summary</title>
  <style>
    :root {
      --bg: rgba(7, 7, 6, 0.92);
      --line: rgba(255, 166, 0, 0.78);
      --line-soft: rgba(255, 166, 0, 0.18);
      --text: #fff7e6;
      --muted: #c5b8a0;
      --green: #6de01f;
      --gold: #ffb11b;
      --orange: #ff8c00;
      --amber: #ffd15a;
      --cyan: #69d4ff;
      --mono: Consolas, "SFMono-Regular", Menlo, monospace;
      --display: Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif;
    }

    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      font-family: var(--mono);
      color: var(--text);
      background: transparent;
    }

    body {
      display: block;
      padding: 0;
    }

    .frame {
      width: 100vw;
      height: 100vh;
      display: grid;
      grid-template-columns: 468px minmax(320px, 1fr);
      gap: 12px;
      align-items: stretch;
      padding: 0;
      overflow: hidden;
    }

    .card {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      background:
        radial-gradient(circle at top right, rgba(109, 224, 31, 0.12), transparent 32%),
        radial-gradient(circle at top left, rgba(255, 140, 0, 0.18), transparent 26%),
        linear-gradient(180deg, rgba(18, 16, 12, 0.98), rgba(5, 5, 4, 0.98));
      border: 1px solid var(--line);
      box-shadow: 0 22px 65px rgba(0, 0, 0, 0.56);
      overflow: hidden;
    }

    .side {
      height: 100%;
      display: grid;
      grid-template-rows: auto auto 1fr;
      gap: 12px;
      padding: 10px 12px 10px 0;
      overflow: hidden;
    }

    .side-panel {
      background:
        radial-gradient(circle at top right, rgba(109, 224, 31, 0.12), transparent 32%),
        radial-gradient(circle at top left, rgba(255, 140, 0, 0.18), transparent 26%),
        linear-gradient(180deg, rgba(18, 16, 12, 0.98), rgba(5, 5, 4, 0.98));
      border: 1px solid var(--line);
      box-shadow: 0 22px 65px rgba(0, 0, 0, 0.56);
      overflow: hidden;
    }

    .side-head {
      padding: 10px 12px 8px;
      border-bottom: 1px solid var(--line-soft);
      color: var(--amber);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    .side-sub {
      color: var(--muted);
      font-size: 10px;
      margin-top: 4px;
    }

    .topbar {
      padding: 10px 12px 8px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(255, 166, 0, 0.08), rgba(255,255,255,0));
      position: relative;
    }

    .topbar::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      bottom: -1px;
      height: 1px;
      background: var(--line-soft);
    }

    .title-block {
      display: grid;
      gap: 5px;
    }

    .title {
      color: var(--orange);
      font-family: var(--display);
      font-size: 24px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      line-height: 1;
      text-shadow: 0 0 18px rgba(255, 140, 0, 0.18);
    }

    .subtitle {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.2;
    }

    .hero {
      padding: 10px 12px 8px;
      display: grid;
      gap: 8px;
    }

    .hero-main {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 12px;
    }

    .hero-copy {
      display: grid;
      gap: 5px;
    }

    .eyebrow {
      color: var(--green);
      font-size: 14px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      font-weight: 700;
    }

    .big {
      color: #fff4cf;
      font-size: 40px;
      font-weight: 700;
      line-height: 0.95;
      text-shadow: 0 0 24px rgba(255, 177, 27, 0.16);
    }

    .sub {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.32;
    }

    .hero-pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 7px 11px;
      color: var(--amber);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      white-space: nowrap;
      background: rgba(255, 166, 0, 0.08);
    }

    .stats-strip {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }

    .mini {
      border: 1px solid rgba(255, 166, 0, 0.14);
      background: linear-gradient(180deg, rgba(255, 140, 0, 0.09), rgba(255,255,255,0.015));
      padding: 6px 8px;
      min-width: 0;
    }

    .mini-label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 4px;
    }

    .mini-value {
      color: var(--text);
      font-size: 19px;
      line-height: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .mini-value.gold { color: #fff0ae; }
    .mini-value.green { color: #8dff57; }
    .mini-value.cyan { color: #9de8ff; }
    .mini-value.orange { color: #ffc273; }

    .explain {
      margin: 0 12px 4px;
      padding: 8px 10px;
      border: 1px solid rgba(109, 224, 31, 0.16);
      background: rgba(109, 224, 31, 0.06);
      color: #e6ffd5;
      font-size: 13px;
      line-height: 1.3;
    }

    .queue-grid {
      margin: 0 12px 8px;
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
    }

    .queue-card {
      border: 1px solid rgba(255, 166, 0, 0.12);
      background: linear-gradient(180deg, rgba(255, 166, 0, 0.07), rgba(255,255,255,0.015));
      padding: 7px 8px;
      min-width: 0;
    }

    .queue-card.warn {
      border-color: rgba(255, 209, 90, 0.28);
      background: linear-gradient(180deg, rgba(255, 209, 90, 0.08), rgba(255,255,255,0.02));
    }

    .queue-card.owed {
      border-color: rgba(109, 224, 31, 0.24);
      background: linear-gradient(180deg, rgba(109, 224, 31, 0.06), rgba(255,255,255,0.02));
    }

    .queue-label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 4px;
    }

    .queue-value {
      color: var(--text);
      font-size: 21px;
      line-height: 1.05;
    }

    .queue-note {
      margin-top: 3px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.3;
    }

    .tiers {
      margin: 0 12px 8px;
      padding: 7px 8px;
      border: 1px solid rgba(255, 166, 0, 0.2);
      background: rgba(255, 140, 0, 0.06);
    }

    .tiers-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
    }

    .tiers-title {
      color: var(--amber);
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.09em;
    }

    .tiers-sub {
      color: var(--muted);
      font-size: 13px;
      text-align: right;
    }

    .tier-list {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 4px;
    }

    .tier-pill {
      border: 1px solid rgba(255, 166, 0, 0.18);
      background: rgba(255, 140, 0, 0.06);
      padding: 6px 7px;
      min-width: 0;
    }

    .tier-pill .top {
      color: var(--green);
      font-size: 12px;
      margin-bottom: 4px;
      white-space: nowrap;
    }

    .tier-pill .bottom {
      color: var(--text);
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .summary-grid {
      padding: 10px 12px 12px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      background: rgba(255,255,255,0.015);
      align-content: start;
      min-height: 0;
    }

    .fact {
      border: 1px solid rgba(255, 166, 0, 0.12);
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
      padding: 7px 8px;
      min-width: 0;
    }

    .fact-label {
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 4px;
    }

    .fact-value {
      color: var(--text);
      font-size: 17px;
      line-height: 1.24;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .fact-value.gold { color: #fff0ae; }
    .fact-value.green { color: #8dff57; }
    .fact-value.cyan { color: #9de8ff; }
    .fact-value.orange { color: #ffc273; }

    .rule-grid {
      padding: 10px 12px 12px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .rule-card {
      border: 1px solid rgba(255, 166, 0, 0.12);
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
      padding: 8px 9px;
      min-width: 0;
    }

    .rule-k {
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 4px;
    }

    .rule-v {
      color: var(--text);
      font-size: 16px;
      line-height: 1.28;
    }

    .live {
      padding: 0 12px 10px;
      color: var(--gold);
      font-size: 13px;
      opacity: 0.95;
    }

    .live.stale {
      color: #ff8a80;
    }

    .live.good {
      color: var(--green);
    }

    .pulse {
      animation: pulse 0.5s ease;
    }

    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(127,255,189,0.35); }
      100% { box-shadow: 0 0 0 10px rgba(127,255,189,0); }
    }

    @media (max-height: 900px) {
      .big { font-size: 35px; }
      .queue-value { font-size: 18px; }
      .mini-value { font-size: 16px; }
      .fact-value { font-size: 15px; }
      .rule-v { font-size: 14px; }
      .title { font-size: 21px; }
      .subtitle, .sub, .queue-note, .explain, .tiers-sub, .live { font-size: 12px; }
    }

    @media (max-width: 980px) {
      .frame {
        grid-template-columns: 1fr;
      }
      .side {
        display: none;
      }
    }

    @media (max-width: 430px) {
      .queue-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .tier-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <div class="frame">
  <div class="card" id="card">
    <div class="topbar">
        <div class="title-block">
          <div class="title">BTCBANK Live Payouts</div>
          <div class="subtitle">Live WBTC rewards for holders.</div>
        </div>
      </div>
    <div class="hero">
      <div class="hero-main">
        <div class="hero-copy">
          <div class="eyebrow">All-Time Holder Value Sent</div>
          <div class="big" id="heroUsd">-</div>
          <div class="sub">Sent to holders already. This total only rises when a payout transaction actually lands.</div>
        </div>
        <div class="hero-pill" id="heroRound">Round idle</div>
      </div>
      <div class="stats-strip">
        <div class="mini">
          <div class="mini-label">WBTC Paid</div>
          <div class="mini-value gold" id="heroWbtc">-</div>
        </div>
        <div class="mini">
          <div class="mini-label">Holders Paid</div>
          <div class="mini-value green" id="heroHolders">-</div>
        </div>
        <div class="mini">
          <div class="mini-label">Rounds</div>
          <div class="mini-value cyan" id="heroRounds">-</div>
        </div>
      </div>
    </div>
    <div class="explain">
      Bigger and longer holders earn more. Backlog means still queued, not missing.
    </div>
    <div class="queue-grid">
      <div class="queue-card">
        <div class="queue-label">Qualified This Round</div>
        <div class="queue-value" id="qualifiedRound">-</div>
        <div class="queue-note" id="roundStarted">Started: -</div>
      </div>
      <div class="queue-card owed">
        <div class="queue-label">Still Left To Pay</div>
        <div class="queue-value" id="leftToPay">-</div>
        <div class="queue-note" id="owedRound">Still owed: -</div>
      </div>
      <div class="queue-card warn">
        <div class="queue-label">Next Main Cycle</div>
        <div class="queue-value" id="nextCheck">-</div>
        <div class="queue-note" id="queueRounds">Pending rounds: -</div>
      </div>
      <div class="queue-card owed">
        <div class="queue-label">Backlog Total</div>
        <div class="queue-value" id="queueEntries">-</div>
        <div class="queue-note" id="queueOwed">Pending WBTC: -</div>
      </div>
    </div>
    <div class="tiers">
      <div class="tiers-head">
        <div class="tiers-title">Base ${baseEntryLabel} Payout Ladder</div>
        <div class="tiers-sub">1 full share</div>
      </div>
      <div class="tier-list" id="tierExamples"></div>
    </div>
    <div class="summary-grid">
      <div class="fact"><div class="fact-label">Claimed</div><div class="fact-value" id="claimedRound">-</div></div>
      <div class="fact"><div class="fact-label">Reward</div><div class="fact-value gold" id="rewardRound">-</div></div>
      <div class="fact"><div class="fact-label">Value</div><div class="fact-value gold" id="approxValue">-</div></div>
      <div class="fact"><div class="fact-label">Progress</div><div class="fact-value cyan" id="roundProgress">-</div></div>
      <div class="fact"><div class="fact-label">Base ${baseEntryLabel}</div><div class="fact-value cyan" id="baseEntryPayout">-</div></div>
      <div class="fact"><div class="fact-label">Paid Now</div><div class="fact-value green" id="paidRound">-</div></div>
      <div class="fact"><div class="fact-label">SOL Total</div><div class="fact-value" id="solClaimedTotal">-</div></div>
      <div class="fact"><div class="fact-label">USD Total</div><div class="fact-value gold" id="usdTotal">-</div></div>
    </div>
    <div class="live" id="live">LIVE | waiting for data</div>
  </div>
  <div class="side">
    <div class="side-panel">
      <div class="side-head">Round Details<div class="side-sub">The extra info that used to get cut off</div></div>
      <div class="summary-grid">
        <div class="fact"><div class="fact-label">Claimed</div><div class="fact-value" id="claimedRound">-</div></div>
        <div class="fact"><div class="fact-label">Reward</div><div class="fact-value gold" id="rewardRound">-</div></div>
        <div class="fact"><div class="fact-label">Value</div><div class="fact-value gold" id="approxValue">-</div></div>
        <div class="fact"><div class="fact-label">Progress</div><div class="fact-value cyan" id="roundProgress">-</div></div>
        <div class="fact"><div class="fact-label">Base ${baseEntryLabel}</div><div class="fact-value cyan" id="baseEntryPayout">-</div></div>
        <div class="fact"><div class="fact-label">Paid Now</div><div class="fact-value green" id="paidRound">-</div></div>
        <div class="fact"><div class="fact-label">SOL Total</div><div class="fact-value" id="solClaimedTotal">-</div></div>
        <div class="fact"><div class="fact-label">USD Total</div><div class="fact-value gold" id="usdTotal">-</div></div>
      </div>
    </div>
    <div class="side-panel">
      <div class="side-head">Live Rules<div class="side-sub">Static rule at 300,000, live cost updates</div></div>
      <div class="rule-grid">
        <div class="rule-card"><div class="rule-k">Qualify Line</div><div class="rule-v" id="ruleQualify">-</div></div>
        <div class="rule-card"><div class="rule-k">Approx Cost</div><div class="rule-v" id="ruleCost">-</div></div>
        <div class="rule-card"><div class="rule-k">Share Rule</div><div class="rule-v" id="ruleShares">-</div></div>
        <div class="rule-card"><div class="rule-k">Hold Bonus</div><div class="rule-v" id="ruleHold">-</div></div>
        <div class="rule-card"><div class="rule-k">Wallet Setup</div><div class="rule-v" id="ruleWbtc">-</div></div>
        <div class="rule-card"><div class="rule-k">Reset Rule</div><div class="rule-v" id="ruleReset">-</div></div>
      </div>
    </div>
  </div>
  </div>

  <script>
    let packetCount = 0;
    let lastPushMs = 0;
    let lastSyncMs = 0;
    let nextCheckAtMs = null;
    let usdFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let ageTimer = null;
    let hardReloadedForStale = false;

    function formatClock(iso) {
      if (!iso) return "-";
      try {
        return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      } catch {
        return "-";
      }
    }

    function pulseCard() {
      const card = document.getElementById("card");
      card.classList.remove("pulse");
      void card.offsetWidth;
      card.classList.add("pulse");
    }

    function formatEta(seconds) {
      if (seconds === null || seconds === undefined) return "calculating";
      if (seconds <= 0) return "caught up";
      if (seconds < 60) return "~" + seconds + "s";
      const minutes = Math.floor(seconds / 60);
      const remSeconds = seconds % 60;
      if (minutes < 60) return remSeconds > 0 ? "~" + minutes + "m " + remSeconds + "s" : "~" + minutes + "m";
      const hours = Math.floor(minutes / 60);
      const remMinutes = minutes % 60;
      return remMinutes > 0 ? "~" + hours + "h " + remMinutes + "m" : "~" + hours + "h";
    }

    function tickLive() {
      if (!lastSyncMs) return;
      const syncAge = Math.max(0, Math.floor((Date.now() - lastSyncMs) / 1000));
      const liveEl = document.getElementById("live");
      const syncSuffix = syncAge === 0 ? "just now" : syncAge === 1 ? "1s ago" : syncAge + "s ago";
      if (syncAge >= 15) {
        liveEl.textContent = "SYNC STALE | reconnecting | last sync " + syncSuffix + " | poll 5s";
        liveEl.className = "live stale";
      } else {
        liveEl.textContent = "SYNC OK | last sync " + syncSuffix + " | poll 5s | push " + packetCount;
        liveEl.className = "live good";
      }
      if (syncAge >= 45 && !hardReloadedForStale) {
        hardReloadedForStale = true;
        window.location.reload();
        return;
      }
      if (nextCheckAtMs !== null) {
        const seconds = Math.max(0, Math.ceil((nextCheckAtMs - Date.now()) / 1000));
        document.getElementById("nextCheck").textContent = seconds <= 0 ? "now" : formatEta(seconds);
      }
    }

    function renderTierExamples(round) {
      const root = document.getElementById("tierExamples");
      if (!round || !round.tierExamples || round.tierExamples.length === 0) {
        root.innerHTML = '<div class="tier-pill"><div class="top">waiting</div><div class="bottom">no round yet</div></div>';
        return;
      }

      root.innerHTML = round.tierExamples.map((entry) => (
        '<div class="tier-pill"><div class="top">' + entry.label + '</div><div class="bottom">' + entry.amountWbtc + '</div></div>'
      )).join("");
    }

    function applyPayload(data) {
      packetCount += 1;
      lastPushMs = Date.now();
      lastSyncMs = Date.now();
      hardReloadedForStale = false;
      nextCheckAtMs = data.nextCheckAt ? new Date(data.nextCheckAt).getTime() : null;
      const round = data.activeRound || data.recentRounds[0] || null;
      document.getElementById("heroUsd").textContent = data.totals.totalPaidUsd === null
        ? "pricing..."
        : usdFormatter.format(data.totals.totalPaidUsd);
      document.getElementById("heroWbtc").textContent = data.totals.totalPaidWbtc;
      document.getElementById("heroHolders").textContent = data.totals.holdersPaidTotal.toLocaleString();
      document.getElementById("heroRounds").textContent = data.totals.roundsTotal.toLocaleString();
      document.getElementById("heroRound").textContent = round
        ? "Round " + round.id.slice(-6) + " " + round.status.replaceAll("_", " ")
        : "Round idle";
      document.getElementById("qualifiedRound").textContent = round ? round.holders + " holders" : "-";
      document.getElementById("roundStarted").textContent = "Started: " + (round ? formatClock(round.createdAt) : "-");
      document.getElementById("leftToPay").textContent = round ? round.pendingRecipients + " holders" : "-";
      document.getElementById("owedRound").textContent = "Still owed: " + (round ? round.pendingRewardWbtc + " WBTC" : "-");
      document.getElementById("nextCheck").textContent = data.nextCheckSeconds === null
        ? "calculating"
        : data.nextCheckSeconds <= 0
          ? "now"
          : formatEta(data.nextCheckSeconds);
      document.getElementById("queueRounds").textContent = "Pending rounds: " + data.queue.pendingRounds + " | swaps: " + data.queue.awaitingSwapRounds;
      document.getElementById("queueEntries").textContent = data.queue.pendingEntries.toLocaleString() + " wallets";
      document.getElementById("queueOwed").textContent = "Pending WBTC: " + data.queue.pendingRewardWbtc;
      document.getElementById("claimedRound").textContent = round ? round.claimSol + " SOL" : "-";
      document.getElementById("rewardRound").textContent = round ? round.rewardWbtc : "-";
      document.getElementById("approxValue").textContent = round && round.rewardUsd !== null
        ? usdFormatter.format(round.rewardUsd)
        : "pricing...";
      document.getElementById("roundProgress").textContent = round ? round.paidRecipients + " / " + round.holders + " paid" : "-";
      document.getElementById("baseEntryPayout").textContent = round ? round.baseEntryPayoutWbtc + " WBTC" : "-";
      document.getElementById("paidRound").textContent = round ? round.paidRecipients + " holders" : "-";
      document.getElementById("solClaimedTotal").textContent = data.totals.totalClaimedSol + " SOL";
      document.getElementById("usdTotal").textContent = data.totals.totalPaidUsd === null
        ? "pricing..."
        : usdFormatter.format(data.totals.totalPaidUsd);
      document.getElementById("ruleQualify").textContent = data.qualification.minimumTokens + " BTCBANK";
      document.getElementById("ruleCost").textContent = data.qualification.approxUsd === null
        ? "pricing..."
        : "~" + usdFormatter.format(data.qualification.approxUsd) + (data.qualification.approxSol === null ? "" : " • ~" + data.qualification.approxSol.toFixed(3) + " SOL");
      document.getElementById("ruleShares").textContent = data.qualification.shareRule;
      document.getElementById("ruleHold").textContent = data.qualification.holdRule;
      document.getElementById("ruleWbtc").textContent = data.qualification.wbtcRule;
      document.getElementById("ruleReset").textContent = data.qualification.resetRule;
      renderTierExamples(round);
      tickLive();
      pulseCard();
    }

    let staleRecoverAt = 0;

    async function loadOnce() {
      const res = await fetch("/api/overlay?_ts=" + Date.now(), { cache: "no-store" });
      const data = await res.json();
      applyPayload(data);
    }

    function connectLive() {
      const stream = new EventSource("/api/stream");
      stream.onmessage = (event) => {
        try {
          applyPayload(JSON.parse(event.data));
        } catch {}
      };
      stream.onerror = () => {
        stream.close();
        setTimeout(connectLive, 1500);
      };
    }

    loadOnce().catch(() => {});
    ageTimer = setInterval(tickLive, 1000);
    connectLive();
    setInterval(() => {
      loadOnce().catch(() => {});
    }, 5000);
    setInterval(() => {
      if (!lastPushMs) return;
      const ageMs = Date.now() - lastPushMs;
      if (ageMs < 15000) return;
      if (Date.now() - staleRecoverAt < 5000) return;
      staleRecoverAt = Date.now();
      loadOnce().catch(() => {});
    }, 3000);
  </script>
</body>
</html>`;
}

function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(config.projectName)} Dashboard</title>
  <style>
    :root {
      --bg: #071116;
      --panel: rgba(8, 16, 21, 0.9);
      --panel-2: rgba(11, 22, 28, 0.95);
      --text: #effff5;
      --muted: #97aaa3;
      --line: rgba(113, 255, 198, 0.12);
      --green: #86efac;
      --cyan: #67e8f9;
      --gold: #facc15;
      --orange: #fb923c;
      --red: #f87171;
      --shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
      --mono: Consolas, "SFMono-Regular", Menlo, monospace;
      --display: Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif;
      --sans: "Trebuchet MS", "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      min-height: 100%;
      color: var(--text);
      font-family: var(--sans);
      background:
        radial-gradient(circle at top left, rgba(251,146,60,0.16), transparent 26%),
        radial-gradient(circle at top right, rgba(103,232,249,0.12), transparent 22%),
        linear-gradient(180deg, #071116 0%, #030608 100%);
    }

    body { padding: 22px; }
    .page {
      width: min(1380px, 100%);
      margin: 0 auto;
      display: grid;
      gap: 18px;
    }
    .hero, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 24px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
    }
    .hero {
      padding: 22px 24px 18px;
      position: relative;
      overflow: hidden;
    }
    .hero::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        linear-gradient(90deg, rgba(251,146,60,0.12), transparent 42%),
        linear-gradient(180deg, rgba(255,255,255,0.02), transparent);
      pointer-events: none;
    }
    .eyebrow {
      color: var(--gold);
      font-family: var(--mono);
      font-size: 12px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }
    .hero-top {
      display: flex;
      justify-content: space-between;
      gap: 18px;
      align-items: flex-start;
      flex-wrap: wrap;
    }
    h1 {
      margin: 8px 0 0;
      font-family: var(--display);
      font-size: clamp(44px, 8vw, 88px);
      line-height: 0.9;
      letter-spacing: 0.03em;
      color: white;
      text-transform: uppercase;
    }
    .hero h1 .accent { color: var(--orange); }
    .subhero {
      margin-top: 10px;
      max-width: 840px;
      font-size: clamp(16px, 2.1vw, 24px);
      line-height: 1.25;
      color: #f8fff9;
    }
    .hero-note {
      margin-top: 10px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 13px;
    }
    .live-pill {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      border-radius: 999px;
      background: rgba(134,239,172,0.08);
      border: 1px solid rgba(134,239,172,0.24);
      color: var(--green);
      font-family: var(--mono);
      font-weight: 700;
      white-space: nowrap;
    }
    .live-pill .dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--green);
      box-shadow: 0 0 14px rgba(134,239,172,0.75);
      animation: pulse 1.25s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(0.9); opacity: 0.75; }
      50% { transform: scale(1.12); opacity: 1; }
      100% { transform: scale(0.9); opacity: 0.75; }
    }
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 14px;
    }
    .stat {
      background: var(--panel-2);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 18px;
      padding: 14px 16px;
      min-height: 112px;
    }
    .label {
      color: var(--muted);
      font-size: 11px;
      font-family: var(--mono);
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }
    .value {
      margin-top: 8px;
      font-size: clamp(20px, 2vw, 32px);
      font-weight: 800;
      line-height: 1;
    }
    .note {
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.25;
    }
    .layout {
      display: grid;
      grid-template-columns: 1.15fr 0.85fr;
      gap: 18px;
    }
    .stack {
      display: grid;
      gap: 18px;
    }
    .panel { padding: 18px; }
    .panel-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: baseline;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }
    .panel-title {
      font-size: 22px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .panel-meta {
      color: var(--muted);
      font-family: var(--mono);
      font-size: 12px;
    }
    .explain-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .explain {
      background: var(--panel-2);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 18px;
      padding: 16px;
    }
    .step {
      width: 34px;
      height: 34px;
      display: inline-grid;
      place-items: center;
      border-radius: 999px;
      font-weight: 900;
      color: white;
      background: linear-gradient(135deg, #7c3aed, #2563eb);
      margin-bottom: 12px;
    }
    .explain h3 {
      margin: 0 0 8px;
      font-size: 20px;
      line-height: 1;
      text-transform: uppercase;
    }
    .explain p {
      margin: 0;
      color: #effbf4;
      font-size: 15px;
      line-height: 1.45;
    }
    .image-frame {
      overflow: hidden;
      border-radius: 18px;
      border: 1px solid rgba(255,255,255,0.07);
      background: #040708;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02);
    }
    .image-frame img {
      display: block;
      width: 100%;
      height: auto;
    }
    .rows {
      display: grid;
      gap: 10px;
    }
    .row-card {
      display: grid;
      gap: 8px;
      background: var(--panel-2);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 16px;
      padding: 12px 14px;
    }
    .row-top {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    .wallet {
      font-family: var(--mono);
      font-size: 13px;
      color: var(--cyan);
      font-weight: 700;
    }
    .chips {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .chip {
      border-radius: 999px;
      padding: 4px 8px;
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 700;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.04);
      color: #eefaf1;
    }
    .chip.gold { color: var(--gold); border-color: rgba(250,204,21,0.2); background: rgba(250,204,21,0.08); }
    .chip.green { color: var(--green); border-color: rgba(134,239,172,0.2); background: rgba(134,239,172,0.08); }
    .chip.cyan { color: var(--cyan); border-color: rgba(103,232,249,0.2); background: rgba(103,232,249,0.08); }
    .grid-4 {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    .mini {
      background: rgba(255,255,255,0.03);
      border-radius: 12px;
      padding: 9px 10px;
    }
    .mini .value {
      margin-top: 4px;
      font-size: 16px;
    }
    .simple-box {
      background: linear-gradient(135deg, rgba(34,197,94,0.12), rgba(103,232,249,0.1));
      border: 1px solid rgba(134,239,172,0.18);
      border-radius: 20px;
      padding: 18px;
    }
    .simple-box strong {
      display: block;
      font-size: 19px;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .simple-box p {
      margin: 0;
      line-height: 1.5;
      font-size: 16px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      padding: 10px 8px;
      text-align: left;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      vertical-align: top;
    }
    th {
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 11px;
      font-family: var(--mono);
    }
    tbody tr:hover {
      background: rgba(255,255,255,0.02);
    }
    .empty {
      color: var(--muted);
      padding: 12px 0;
      font-family: var(--mono);
    }
    .warn-box {
      border: 1px solid rgba(248,113,113,0.18);
      background: rgba(248,113,113,0.06);
      border-radius: 16px;
      padding: 14px 16px;
    }
    .warn-box strong {
      display: block;
      color: #fff;
      margin-bottom: 6px;
      text-transform: uppercase;
    }
    .muted { color: var(--muted); }
    @media (max-width: 1180px) {
      .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .layout { grid-template-columns: 1fr; }
      .explain-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 760px) {
      body { padding: 12px; }
      .stat-grid { grid-template-columns: 1fr; }
      .grid-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      h1 { font-size: 42px; }
      .panel-title { font-size: 18px; }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <div class="hero-top">
        <div>
          <div class="eyebrow">Bitcoin Bank 24/7 Live Reward Board</div>
          <h1><span id="brandName">Bitcoin Bank</span> <span class="accent">Dashboard</span></h1>
          <div class="subhero" id="heroLine">Loading the live reward feed...</div>
          <div class="hero-note" id="heroNote">This page turns the bot into plain English so new holders can understand what is happening without guessing.</div>
        </div>
        <div class="live-pill"><span class="dot"></span><span id="liveStamp">Connecting...</span></div>
      </div>
    </section>

    <section class="stat-grid">
      <div class="stat">
        <div class="label">Next Bot Check</div>
        <div class="value" id="nextCheck">-</div>
        <div class="note">The bot checks rewards every 5 minutes. Rewards only go out when claimable SOL is above the live minimum.</div>
      </div>
      <div class="stat">
        <div class="label">Qualified Right Now</div>
        <div class="value" id="qualifiedNow">-</div>
        <div class="note">Wallets that currently qualify for WBTC rewards.</div>
      </div>
      <div class="stat">
        <div class="label">Total WBTC Paid</div>
        <div class="value" id="totalWbtc">-</div>
        <div class="note">All holder payouts the bot has already sent.</div>
      </div>
      <div class="stat">
        <div class="label">Total SOL Claimed</div>
        <div class="value" id="totalSol">-</div>
        <div class="note">Creator rewards the bot has already pulled in.</div>
      </div>
      <div class="stat">
        <div class="label">Live Reward Pool Status</div>
        <div class="value" id="activeStatus">-</div>
        <div class="note" id="activeStatusNote">Waiting for live round data...</div>
      </div>
    </section>

    <section class="layout">
      <div class="stack">
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">How Rewards Work</div>
            <div class="panel-meta">Made for normal humans</div>
          </div>
          <div class="explain-grid">
            <div class="explain">
              <div class="step">1</div>
              <h3>Hold Enough</h3>
              <p>Hold at least ${config.holderMinTokens.toLocaleString()} tokens to qualify for wBTC rewards.</p>
            </div>
            <div class="explain">
              <div class="step">2</div>
              <h3>Bigger Bag = More</h3>
              <p>Your tokens create shares. 500k is 1 share, 1M is 2 shares, 1.5M is 3 shares, and it keeps going from there.</p>
            </div>
            <div class="explain">
              <div class="step">3</div>
              <h3>Hold Longer = Bonus</h3>
              <p>You earn right away, but loyal holders get a small extra boost. If you sell below your minimum, your hold timer restarts.</p>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">Holder Guide</div>
            <div class="panel-meta">Share this with new holders</div>
          </div>
          <div class="image-frame">
            <img src="${holderGuideImageRoute}" alt="Bitcoin Bank live stream holder reward guide" />
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">Live Snapshot</div>
            <div class="panel-meta">Who qualifies right now</div>
          </div>
          <div class="rows" id="snapshotRows"></div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">Top Current Holders</div>
            <div class="panel-meta">By live token balance</div>
          </div>
          <div id="topHoldersWrap"></div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">Top Reward Power</div>
            <div class="panel-meta">Bag size plus hold-time bonus</div>
          </div>
          <div id="topWeightWrap"></div>
        </section>
      </div>

      <div class="stack">
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">Simple Stream Version</div>
            <div class="panel-meta">Read this out loud</div>
          </div>
          <div class="simple-box">
            <strong>Bigger bag + longer hold = more wBTC.</strong>
            <p>Hold enough and you qualify. More tokens give you more reward power. Holding longer gives that reward power a small bonus. New holders still earn right away. Loyal holders earn a little more.</p>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">Hold Bonus Ladder</div>
            <div class="panel-meta">Small bonus, not crazy bonus</div>
          </div>
          <div id="tierGuideRows" class="rows"></div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">Top All-Time Receivers</div>
            <div class="panel-meta">Who has received the most WBTC so far</div>
          </div>
          <div id="topReceiversWrap"></div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">Recent Rounds</div>
            <div class="panel-meta">Latest reward cycles</div>
          </div>
          <div id="recentRoundsWrap"></div>
        </section>

        <section class="warn-box">
          <strong>Reset Rule</strong>
          <div>If your wallet drops below ${config.holderMinTokens.toLocaleString()} tokens, your hold timer restarts.</div>
        </section>
      </div>
    </section>
  </div>

  <script>
    const short = (value, left = 6, right = 6) => {
      if (!value || value.length <= left + right + 3) return value || "";
      return value.slice(0, left) + "..." + value.slice(-right);
    };

    const fmtTime = (iso) => {
      if (!iso) return "-";
      try {
        return new Date(iso).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
      } catch {
        return iso;
      }
    };

    const renderTable = (columns, rows, targetId) => {
      const root = document.getElementById(targetId);
      if (!rows.length) {
        root.innerHTML = '<div class="empty">No data yet.</div>';
        return;
      }

      const head = columns.map((column) => '<th>' + column.label + '</th>').join("");
      const body = rows.map((row) =>
        '<tr>' + columns.map((column) => '<td>' + column.render(row) + '</td>').join("") + '</tr>'
      ).join("");
      root.innerHTML = '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
    };

    const renderSnapshot = (data) => {
      const rows = [
        { label: "Qualified wallets", value: String(data.live.qualifiedHolders), note: "Wallets meeting the live rule right now." },
        { label: "Payable now", value: String(data.live.payableHolders), note: "Qualified wallets that are already WBTC-ready." },
        { label: "No-WBTC accounts", value: String(data.live.missingRewardAccounts), note: "Qualified wallets that still cannot receive yet." },
        { label: "Owners scanned", value: String(data.live.totalOwnersScanned), note: "How many wallet owners were seen on-chain in the latest holder scan." },
        { label: "Total shares", value: data.live.totalShares, note: "Base reward shares from bag size alone." },
        { label: "Reward power", value: data.live.totalRewardPower, note: "Base shares after the small hold-time bonuses are added." },
        { label: "Tier mix", value: data.live.tierMix || "No active tiers yet", note: "How many qualified wallets sit in each hold-time tier." },
      ];
      document.getElementById("snapshotRows").innerHTML = rows.map((row) => (
        '<div class="row-card"><div class="row-top"><div class="panel-title" style="font-size:16px; letter-spacing:0.04em;">' + row.label + '</div><div class="value" style="font-size:22px; margin-top:0;">' + row.value + '</div></div><div class="muted">' + row.note + '</div></div>'
      )).join("");
    };

    const renderTierGuide = (tiers) => {
      document.getElementById("tierGuideRows").innerHTML = tiers.map((tier) => (
        '<div class="row-card"><div class="row-top"><div class="panel-title" style="font-size:16px;">' + tier.label + '</div><div class="chips"><span class="chip gold">' + tier.multiplier + '</span></div></div><div class="muted">' + tier.plain + '</div></div>'
      )).join("");
    };

    const applyPayload = (data) => {
      document.getElementById("brandName").textContent = data.projectName;
      document.getElementById("heroLine").textContent =
        "The bot checks every 5 minutes, turns creator rewards into wBTC, and sends it out based on bag size plus a small hold-time bonus.";
      document.getElementById("heroNote").textContent =
        "Holder mint " + short(data.holderMint, 8, 8) + " | Reward mint " + short(data.rewardMint, 8, 8) + " | Wallet " + short(data.wallet, 8, 8);
      document.getElementById("liveStamp").textContent = "Live refresh • " + fmtTime(data.updatedAt);

      document.getElementById("nextCheck").textContent = data.nextCheckSeconds === null
        ? "Live"
        : data.nextCheckSeconds <= 0
          ? "Any second"
          : data.nextCheckSeconds + "s";
      document.getElementById("qualifiedNow").textContent = String(data.live.qualifiedHolders);
      document.getElementById("totalWbtc").textContent = data.totals.totalPaidWbtc;
      document.getElementById("totalSol").textContent = data.totals.totalClaimedSol + " SOL";
      document.getElementById("activeStatus").textContent = data.overview.activeStatus.replaceAll("_", " ");
      document.getElementById("activeStatusNote").textContent = data.overview.activeRoundId
        ? "Round " + data.overview.activeRoundId + " | " + data.overview.activePaidHolders + " of " + data.overview.activeQualifiedHolders + " holders paid | " + data.overview.activeRewardWbtc + " WBTC"
        : "No live round at this second. The bot keeps checking for the next claim window.";

      renderSnapshot(data);
      renderTierGuide(data.tierGuide);

      renderTable([
        { label: "Wallet", render: (row) => '<span class="wallet">' + short(row.owner, 8, 8) + '</span>' },
        { label: "Balance", render: (row) => row.balanceTokens },
        { label: "Shares", render: (row) => row.shares },
        { label: "Hold", render: (row) => row.holdAge + ' • ' + row.multiplier },
      ], data.topHolders, "topHoldersWrap");

      renderTable([
        { label: "Wallet", render: (row) => '<span class="wallet">' + short(row.owner, 8, 8) + '</span>' },
        { label: "Reward Power", render: (row) => row.rewardPower },
        { label: "Tier", render: (row) => row.holdTier },
        { label: "Notes", render: (row) => row.shares + ' shares' },
      ], data.topRewardPower, "topWeightWrap");

      renderTable([
        { label: "Wallet", render: (row) => '<span class="wallet">' + short(row.owner, 8, 8) + '</span>' },
        { label: "WBTC", render: (row) => row.totalWbtc },
        { label: "Payouts", render: (row) => String(row.payoutCount) },
        { label: "Last Paid", render: (row) => fmtTime(row.lastPaidAt) },
      ], data.topReceivers, "topReceiversWrap");

      renderTable([
        { label: "Round", render: (row) => '<span class="wallet">' + row.id + '</span>' },
        { label: "Status", render: (row) => row.status },
        { label: "Claimed", render: (row) => row.claimSol + ' SOL' },
        { label: "WBTC", render: (row) => row.rewardWbtc },
        { label: "Paid", render: (row) => String(row.paidHolders) },
      ], data.recentRounds, "recentRoundsWrap");
    };

    async function refresh() {
      const response = await fetch("/api/dashboard?_ts=" + Date.now(), { cache: "no-store" });
      const data = await response.json();
      applyPayload(data);
    }

    refresh().catch(() => {});
    setInterval(() => {
      refresh().catch(() => {});
    }, 5000);
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

const server = createServer(async (req, res) => {
  try {
    const rawUrl = req.url ?? "/";
    const normalizedPath = rawUrl.startsWith("//")
      ? `/${rawUrl.replace(/^\/+/, "")}`
      : rawUrl.startsWith("/")
        ? rawUrl
        : `/${rawUrl}`;
    const host = req.headers.host && req.headers.host.trim() ? req.headers.host : "127.0.0.1:3030";
    const url = new URL(normalizedPath, `http://${host}`);

    if (url.pathname === "/api/overlay") {
      const payload = await buildOverlayPayload();
      sendJson(res, payload);
      return;
    }

    if (url.pathname === "/api/dashboard") {
      const payload = await buildDashboardPayload();
      sendJson(res, payload);
      return;
    }

    if (url.pathname === "/api/wallet-check") {
      const wallet = url.searchParams.get("wallet")?.trim();
      if (!wallet) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Missing wallet query parameter" }));
        return;
      }
      const payload = await buildWalletCheckPayload(wallet);
      sendJson(res, payload);
      return;
    }

    if (url.pathname === holderGuideImageRoute) {
      await sendPngFile(res, holderGuideImagePath);
      return;
    }

    if (url.pathname === "/api/stream") {
      sendSseHeaders(res);
      sseClients.add(res);
      await pushPayload(res);
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    if (url.pathname === "/") {
      sendDashboardHtml(res);
      return;
    }

    if (url.pathname === "/overlay") {
      sendHtml(res);
      return;
    }

    if (url.pathname === "/dashboard" || url.pathname === "/site") {
      sendDashboardHtml(res);
      return;
    }

    if (url.pathname === "/wallet-check" || url.pathname === "/check") {
      sendWalletCheckHtml(res);
      return;
    }

    if (url.pathname === "/paid-summary" || url.pathname === "/summary") {
      sendPaidSummaryHtml(res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
  }
});

void holdTrackingStore.init();
startDirectoryWatch(statePath);
startDirectoryWatch(holdTrackingPath);
startDirectoryWatch(runtimeLogPath);
startHeartbeat();

server.listen(port, "127.0.0.1", () => {
  console.log(`[overlay] ${config.projectName} live overlay at http://127.0.0.1:${port}`);
  console.log(`[overlay] OBS browser source: http://127.0.0.1:${port}/?transparent=1`);
  console.log(`[overlay] Paid summary source: http://127.0.0.1:${port}/paid-summary?transparent=1`);
  console.log(`[overlay] Dashboard site: http://127.0.0.1:${port}/dashboard`);
  console.log(`[overlay] Wallet: ${shorten(signer.publicKey.toBase58(), 8, 8)}`);
});
