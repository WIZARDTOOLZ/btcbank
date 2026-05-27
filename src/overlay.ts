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
import { loadGrandfatherSnapshot } from "./lib/grandfather.js";
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

type OverlayMarket = {
  tokenUsd: number | null;
  tokenMarketCapUsd: number | null;
  btcUsd: number | null;
  btcMarketCapUsd: number | null;
  wbtcUsd: number | null;
  wbtcMarketCapUsd: number | null;
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
  market: OverlayMarket;
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

type RuntimeLogRow = {
  label: string;
  value: string;
};

type RuntimeLogEntry = {
  ts?: string;
  level?: string;
  message?: string;
  kind?: string;
  title?: string;
  tone?: string;
  rows?: RuntimeLogRow[];
  label?: string;
  value?: string;
  signature?: string;
  calloutKind?: string;
};

type OpsSummaryBox = {
  title: string;
  tone: string;
  rows: RuntimeLogRow[];
};

type OpsEvent = {
  at: string;
  level: string;
  tone: "good" | "warn" | "bad" | "info";
  headline: string;
  detail: string;
};

type OpsPayload = {
  projectName: string;
  updatedAt: string;
  nextCheckAt: string | null;
  nextCheckSeconds: number | null;
  queue: OverlayPayload["queue"];
  activeRound: OverlayRound | null;
  counters: {
    replayTimeouts: number;
    batchRetries: number;
    noWbtcHolds: number;
    droppedWallets: number;
    previewDrifts: number;
  };
  summaries: OpsSummaryBox[];
  events: OpsEvent[];
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
  shareCount: string;
  qualifiesNow: boolean;
  hasWbtcAccount: boolean;
  payableNow: boolean;
  holdAge: string;
  holdTier: string;
  holdMultiplier: string;
  rewardPower: string;
  eligibleSince: string | null;
  nextTier: string | null;
  nextTierEta: string | null;
  tokensNeeded: string;
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
let marketCache: { expiresAt: number; payload: OverlayMarket } | null = null;
let mintSupplyCache = new Map<string, { expiresAt: number; supplyRaw: bigint }>();

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const ONE_BTC_RAW = 100_000_000n;
const HOLD_TIERS = [
  { label: "30d+", minMs: 30 * DAY_MS, multiplierBps: 12_000, plain: "biggest loyalty bonus" },
  { label: "14d+", minMs: 14 * DAY_MS, multiplierBps: 11_200, plain: "strong loyalty bonus" },
  { label: "7d+", minMs: 7 * DAY_MS, multiplierBps: 10_700, plain: "solid loyalty bonus" },
  { label: "72h+", minMs: 3 * DAY_MS, multiplierBps: 10_300, plain: "small loyalty bonus" },
  { label: "24h+", minMs: DAY_MS, multiplierBps: 10_100, plain: "tiny loyalty bonus" },
  { label: "<24h", minMs: 0, multiplierBps: 10_000, plain: "base reward, no bonus yet" },
] as const;
const OVERLAY_PAYLOAD_CACHE_MS = 1_000;
const QUALIFICATION_CACHE_MS = 30_000;
const MARKET_CACHE_MS = 15_000;
const MARKET_HTTP_TIMEOUT_MS = 8_000;

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

async function getMintSupplyCached(mintAddress: string): Promise<bigint> {
  const now = Date.now();
  const cached = mintSupplyCache.get(mintAddress);
  if (cached && cached.expiresAt > now) {
    return cached.supplyRaw;
  }

  const connection = new Connection(config.rpcUrls[0]!, "confirmed");
  const parsed = await connection.getParsedAccountInfo(new PublicKey(mintAddress), "confirmed");
  const supplyRaw = BigInt(
    (parsed.value?.data as { parsed?: { info?: { supply?: string } } } | undefined)?.parsed?.info?.supply ?? "0",
  );
  mintSupplyCache.set(mintAddress, {
    expiresAt: now + MARKET_CACHE_MS,
    supplyRaw,
  });
  return supplyRaw;
}

async function fetchBtcUsdSpot(): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MARKET_HTTP_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", {
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      data?: {
        amount?: string;
      };
    };
    const parsed = Number(payload.data?.amount ?? "");
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMajorAssetMarkets(): Promise<{
  btcUsd: number | null;
  btcMarketCapUsd: number | null;
  wbtcUsd: number | null;
  wbtcMarketCapUsd: number | null;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MARKET_HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,wrapped-bitcoin&vs_currencies=usd&include_market_cap=true",
      {
        headers: {
          Accept: "application/json",
        },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      return {
        btcUsd: null,
        btcMarketCapUsd: null,
        wbtcUsd: null,
        wbtcMarketCapUsd: null,
      };
    }

    const payload = (await response.json()) as {
      bitcoin?: { usd?: number; usd_market_cap?: number };
      "wrapped-bitcoin"?: { usd?: number; usd_market_cap?: number };
    };

    return {
      btcUsd: Number.isFinite(payload.bitcoin?.usd) ? payload.bitcoin?.usd ?? null : null,
      btcMarketCapUsd: Number.isFinite(payload.bitcoin?.usd_market_cap) ? payload.bitcoin?.usd_market_cap ?? null : null,
      wbtcUsd: Number.isFinite(payload["wrapped-bitcoin"]?.usd) ? payload["wrapped-bitcoin"]?.usd ?? null : null,
      wbtcMarketCapUsd: Number.isFinite(payload["wrapped-bitcoin"]?.usd_market_cap)
        ? payload["wrapped-bitcoin"]?.usd_market_cap ?? null
        : null,
    };
  } catch {
    return {
      btcUsd: null,
      btcMarketCapUsd: null,
      wbtcUsd: null,
      wbtcMarketCapUsd: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function buildMarketSnapshot(): Promise<OverlayMarket> {
  const now = Date.now();
  if (marketCache && marketCache.expiresAt > now) {
    return marketCache.payload;
  }

  const holderDecimals = await getMintDecimalsCached(config.holderMint);
  const holderUnitRaw = 10n ** BigInt(holderDecimals);
  const rewardDecimals = await getMintDecimalsCached(config.rewardMint);
  const rewardUnitRaw = 10n ** BigInt(rewardDecimals);
  const [tokenUsd, liveWbtcUsd, majorMarkets, holderSupplyRaw, rewardSupplyRaw] = await Promise.all([
    quoteTokenToUsd(new PublicKey(config.holderMint), holderUnitRaw),
    quoteTokenToUsd(new PublicKey(config.rewardMint), ONE_BTC_RAW),
    fetchMajorAssetMarkets(),
    getMintSupplyCached(config.holderMint),
    getMintSupplyCached(config.rewardMint),
  ]);

  const wbtcUsd = liveWbtcUsd ?? majorMarkets.wbtcUsd;
  const fallbackWbtcMarketCapUsd =
    wbtcUsd !== null ? wbtcUsd * (Number(rewardSupplyRaw) / Number(rewardUnitRaw)) : null;

  const payload: OverlayMarket = {
    tokenUsd,
    tokenMarketCapUsd: tokenUsd !== null ? tokenUsd * (Number(holderSupplyRaw) / Number(holderUnitRaw)) : null,
    btcUsd: majorMarkets.btcUsd ?? (await fetchBtcUsdSpot()) ?? wbtcUsd,
    btcMarketCapUsd: majorMarkets.btcMarketCapUsd,
    wbtcUsd,
    wbtcMarketCapUsd: majorMarkets.wbtcMarketCapUsd ?? fallbackWbtcMarketCapUsd,
  };

  marketCache = {
    expiresAt: now + MARKET_CACHE_MS,
    payload,
  };
  return payload;
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
    const [state, lastRuntimeTs, qualification, market] = await Promise.all([
      readState(),
      readLastRuntimeTimestamp(),
      buildQualificationSnapshot(),
      buildMarketSnapshot(),
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
    const activeSource = rounds[0];
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
      market,
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

function formatDurationShort(ageMs: number): string {
  if (ageMs <= 0) {
    return "now";
  }
  const days = Math.floor(ageMs / DAY_MS);
  const hours = Math.floor((ageMs % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((ageMs % HOUR_MS) / 60000);
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${Math.max(1, minutes)}m`;
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
  let owner: PublicKey;
  try {
    owner = new PublicKey(wallet);
  } catch {
    throw new Error("That does not look like a valid Solana wallet address.");
  }
  const ownerBase58 = owner.toBase58();
  const holderMintKey = new PublicKey(config.holderMint);
  const rewardMintKey = new PublicKey(config.rewardMint);
  const holdTracking = await readHoldTracking();

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
  const shareCount = qualifiesNow ? holderBalanceRaw / minimumRaw : 0n;
  const tracked = holdTracking.holders[ownerBase58];
  const eligibleSinceMs = tracked ? new Date(tracked.eligibleSince).getTime() : Date.now();
  const holdAgeMs = qualifiesNow && Number.isFinite(eligibleSinceMs)
    ? Math.max(0, Date.now() - eligibleSinceMs)
    : 0;
  const holdTier = qualifiesNow ? getHoldTier(holdAgeMs) : null;
  const rewardPower = holdTier ? shareCount * BigInt(holdTier.multiplierBps) : 0n;
  const currentTierIndex = holdTier ? HOLD_TIERS.findIndex((tier) => tier.label === holdTier.label) : -1;
  const nextTier = currentTierIndex > 0 ? HOLD_TIERS[currentTierIndex - 1]! : null;
  const nextTierEtaMs = nextTier ? Math.max(0, nextTier.minMs - holdAgeMs) : 0;

  const rewardAta = getAssociatedTokenAddressSync(
    rewardMintKey,
    owner,
    true,
    rewardMintAccount.owner,
  );
  const rewardAtaInfo = await connection.getAccountInfo(rewardAta, "confirmed");
  const hasWbtcAccount = rewardAtaInfo !== null;
  const payableNow = qualifiesNow && hasWbtcAccount;
  const missingRaw = holderBalanceRaw >= minimumRaw ? 0n : minimumRaw - holderBalanceRaw;

  return {
    wallet: ownerBase58,
    holderMint: config.holderMint,
    rewardMint: config.rewardMint,
    minimumTokens: config.holderMinTokens.toLocaleString(),
    holderBalanceTokens: formatTokenAmount(holderBalanceRaw, holderDecimals),
    holderBalanceRaw: holderBalanceRaw.toString(),
    shareCount: shareCount.toString(),
    qualifiesNow,
    hasWbtcAccount,
    payableNow,
    holdAge: qualifiesNow ? formatHoldAge(holdAgeMs) : "timer inactive",
    holdTier: holdTier?.label ?? "below minimum",
    holdMultiplier: holdTier ? formatMultiplier(holdTier.multiplierBps) : "0.00x",
    rewardPower: holdTier ? formatWeightUnits(rewardPower) : "0",
    eligibleSince: qualifiesNow && tracked ? tracked.eligibleSince : null,
    nextTier: nextTier?.label ?? null,
    nextTierEta: nextTier ? formatDurationShort(nextTierEtaMs) : null,
    tokensNeeded: formatTokenAmount(missingRaw, holderDecimals),
    message: !qualifiesNow
      ? `This wallet is below ${config.holderMinTokens.toLocaleString()} tokens right now.`
      : hasWbtcAccount
        ? "This wallet qualifies, is in the active hold ladder, and is WBTC-ready right now."
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

async function readRuntimeEntries(maxBytes = 256 * 1024): Promise<RuntimeLogEntry[]> {
  try {
    const raw = await readTailText(runtimeLogPath, maxBytes);
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as RuntimeLogEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is RuntimeLogEntry => entry !== null);
  } catch {
    return [];
  }
}

function countRuntimeMessages(entries: RuntimeLogEntry[], matcher: (message: string) => boolean): number {
  let count = 0;
  for (const entry of entries) {
    const message = entry.message ?? "";
    if (matcher(message)) {
      count += 1;
    }
  }
  return count;
}

function sumDroppedWallets(entries: RuntimeLogEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    const match = (entry.message ?? "").match(/^Dropped (\d+) wallet/);
    if (!match) {
      continue;
    }
    count += Number(match[1] ?? "0");
  }
  return count;
}

function pickLatestSummary(entries: RuntimeLogEntry[], title: string): OpsSummaryBox | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== "summary" || entry.title !== title || !Array.isArray(entry.rows)) {
      continue;
    }

    return {
      title,
      tone: entry.tone ?? "info",
      rows: entry.rows.map((row) => ({
        label: row.label,
        value: row.value,
      })),
    };
  }

  return null;
}

function toOpsTone(level: string, message: string): OpsEvent["tone"] {
  if (level === "error" || message.includes("failed")) {
    return "bad";
  }
  if (level === "warn" || message.includes("timed out") || message.includes("hold")) {
    return "warn";
  }
  if (message.includes("claimed") || message.includes("bought") || message.startsWith("Paid ")) {
    return "good";
  }
  return "info";
}

function summarizeRuntimeMessage(entry: RuntimeLogEntry): OpsEvent | null {
  const message = (entry.message ?? "").trim();
  const ts = entry.ts ?? new Date().toISOString();
  const level = entry.level ?? "info";

  if (!message || entry.kind === "summary" || entry.kind === "section" || message.startsWith("[summary]")) {
    return null;
  }

  if (message.includes("timed out after 90s")) {
    return {
      at: ts,
      level,
      tone: "warn",
      headline: "Replay safety window hit",
      detail: "The payout catch-up used its 90s pass budget and will keep working on the next pass.",
    };
  }

  if (message.startsWith("Payout batch failed for ")) {
    return {
      at: ts,
      level,
      tone: "bad",
      headline: "Batch retry needed",
      detail: message.replace(/^Payout batch failed for /, ""),
    };
  }

  if (message.includes("no-WBTC accounts")) {
    return {
      at: ts,
      level,
      tone: "warn",
      headline: "Waiting on no-WBTC accounts",
      detail: "Some holders still qualify, but payouts are paused for wallets that have not opened their WBTC account yet.",
    };
  }

  if (message.startsWith("Dropped ")) {
    return {
      at: ts,
      level,
      tone: "warn",
      headline: "Wallets dropped from replay",
      detail: message,
    };
  }

  if (message.startsWith("Round saved and waiting to buy WBTC: ")) {
    return {
      at: ts,
      level,
      tone: "info",
      headline: "Round queued for swap",
      detail: message.replace("Round saved and waiting to buy WBTC: ", ""),
    };
  }

  if (message.startsWith("Round finished: ") || message === "Round fully paid") {
    return {
      at: ts,
      level,
      tone: "good",
      headline: "Round settled",
      detail: message.replace("Round finished: ", ""),
    };
  }

  if (message.startsWith("Creator rewards claimed: ")) {
    return {
      at: ts,
      level,
      tone: "good",
      headline: "Creator rewards claimed",
      detail: message.replace("Creator rewards claimed: ", ""),
    };
  }

  if (message.startsWith("secondary transfer sent: ")) {
    return {
      at: ts,
      level,
      tone: "info",
      headline: "Ops transfer sent",
      detail: message.replace("secondary transfer sent: ", ""),
    };
  }

  if (message.startsWith("background payouts active: ")) {
    return {
      at: ts,
      level,
      tone: "info",
      headline: "Backlog worker active",
      detail: message.replace("background payouts active: ", ""),
    };
  }

  if (message.startsWith("claim landed smaller than the preview amount: ")) {
    return {
      at: ts,
      level,
      tone: "warn",
      headline: "Claim settled below preview",
      detail: message.replace("claim landed smaller than the preview amount: ", ""),
    };
  }

  if (message.startsWith("Paid ")) {
    return {
      at: ts,
      level,
      tone: "good",
      headline: "Payout batch landed",
      detail: message,
    };
  }

  if (entry.kind === "tx" && entry.label && entry.signature) {
    return {
      at: ts,
      level,
      tone: "info",
      headline: entry.label,
      detail: shorten(entry.signature, 12, 12),
    };
  }

  return {
    at: ts,
    level,
    tone: toOpsTone(level, message),
    headline: message.length > 72 ? `${message.slice(0, 72)}...` : message,
    detail: message,
  };
}

async function buildOpsPayload(): Promise<OpsPayload> {
  const [overlayPayload, runtimeEntries] = await Promise.all([
    buildOverlayPayload(),
    readRuntimeEntries(),
  ]);

  const summaryTitles = [
    "Main Check",
    "Replay Queue",
    "Replay Round",
    "Reward Pool",
    "Fee Recovery",
    "Round Complete",
  ];

  const summaries = summaryTitles
    .map((title) => pickLatestSummary(runtimeEntries, title))
    .filter((summary): summary is OpsSummaryBox => summary !== null);

  const events = runtimeEntries
    .map((entry) => summarizeRuntimeMessage(entry))
    .filter((entry): entry is OpsEvent => entry !== null)
    .reverse()
    .filter((entry, index, all) => {
      return all.findIndex((other) => other.headline === entry.headline && other.detail === entry.detail) === index;
    })
    .slice(0, 18);

  return {
    projectName: overlayPayload.projectName,
    updatedAt: new Date().toISOString(),
    nextCheckAt: overlayPayload.nextCheckAt,
    nextCheckSeconds: overlayPayload.nextCheckSeconds,
    queue: overlayPayload.queue,
    activeRound: overlayPayload.activeRound,
    counters: {
      replayTimeouts: countRuntimeMessages(runtimeEntries, (message) => message.includes("timed out after 90s")),
      batchRetries: countRuntimeMessages(runtimeEntries, (message) => message.startsWith("Payout batch failed for ")),
      noWbtcHolds: countRuntimeMessages(runtimeEntries, (message) => message.includes("no-WBTC accounts")),
      droppedWallets: sumDroppedWallets(runtimeEntries),
      previewDrifts: countRuntimeMessages(runtimeEntries, (message) => message.includes("claim landed smaller than the preview amount")),
    },
    summaries,
    events,
  };
}

function renderSiteTabs(active: "dashboard" | "summary" | "ops" | "check"): string {
  const items = [
    { id: "dashboard", href: "/dashboard", label: "Dashboard" },
    { id: "summary", href: "/paid-summary", label: "Paid Summary" },
    { id: "ops", href: "/ops", label: "Ops Board" },
    { id: "check", href: "/wallet-check", label: "Wallet Check" },
  ] as const;

  return `<nav class="site-tabs">${items.map((item) => {
    const activeClass = item.id === active ? " active" : "";
    return `<a class="site-tab${activeClass}" href="${item.href}">${item.label}</a>`;
  }).join("")}</nav>`;
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
  const grandfatherSnapshot = await loadGrandfatherSnapshot(config.grandfatherFilePath);
  const grandfatheredOwners = new Set<string>(
    grandfatherSnapshot?.holderMint === config.holderMint
      ? grandfatherSnapshot.wallets
          .filter((wallet) => Number(wallet.snapshotUiBalance) >= config.grandfatherMinTokens)
          .map((wallet) => wallet.owner)
      : [],
  );

  const connection = new Connection(config.rpcUrls[0]!, "confirmed");
  const holderSummary = await getHolderSummary(
    connection,
    new PublicKey(config.holderMint),
    config.holderMinTokens,
    excludedOwners,
    config.skipOffCurveOwners,
    grandfatheredOwners,
    config.grandfatherMinTokens,
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

function sendOpsHtml(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(renderOpsHtml());
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
  }, 3_000);
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
      --muted: #f0d9ad;
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
    }, 2000);
    setInterval(() => {
      if (!lastPushMs) return;
      const ageMs = Date.now() - lastPushMs;
      if (ageMs < 6000) return;
      if (Date.now() - staleRecoverAt < 2000) return;
      staleRecoverAt = Date.now();
      loadOnce().catch(() => {});
    }, 2000);
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
    .tabs {
      margin: 0 0 18px;
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
    .micro {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
  </style>
</head>
<body>
  <div class="shell">
    <h1>Wallet Check</h1>
    <div class="sub">Paste a wallet and see the real live answer: current bag size, share count, hold age, hold tier, hold bonus, and whether that wallet is already WBTC-ready.</div>
    <div class="tabs">${renderSiteTabs("check")}</div>
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
        <div class="card"><div class="label">Full Shares</div><div class="value" id="shareCount">-</div><div class="micro">1 share per full ${config.holderMinTokens.toLocaleString()} tokens</div></div>
        <div class="card"><div class="label">Hold Age</div><div class="value" id="holdAge">-</div><div class="micro" id="eligibleSince">Hold timer data appears here.</div></div>
        <div class="card"><div class="label">Hold Tier</div><div class="value" id="holdTier">-</div><div class="micro" id="nextTier">Next tier info appears here.</div></div>
        <div class="card"><div class="label">Bonus Multiplier</div><div class="value" id="holdMultiplier">-</div><div class="micro">Longer hold = slightly stronger reward weight</div></div>
        <div class="card"><div class="label">Reward Power</div><div class="value" id="rewardPower">-</div><div class="micro">Shares multiplied by loyalty bonus</div></div>
        <div class="card"><div class="label">Still Needed</div><div class="value" id="tokensNeeded">-</div><div class="micro">How many more tokens this wallet needs to qualify right now</div></div>
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
    const shareCount = document.getElementById("shareCount");
    const holdAge = document.getElementById("holdAge");
    const holdTier = document.getElementById("holdTier");
    const holdMultiplier = document.getElementById("holdMultiplier");
    const rewardPower = document.getElementById("rewardPower");
    const tokensNeeded = document.getElementById("tokensNeeded");
    const eligibleSince = document.getElementById("eligibleSince");
    const nextTier = document.getElementById("nextTier");

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
        shareCount.textContent = data.shareCount;
        holdAge.textContent = data.holdAge;
        holdTier.textContent = data.holdTier;
        holdMultiplier.textContent = data.holdMultiplier;
        rewardPower.textContent = data.rewardPower;
        tokensNeeded.textContent = data.tokensNeeded;
        eligibleSince.textContent = data.eligibleSince
          ? ("Qualified since " + new Date(data.eligibleSince).toLocaleString())
          : "Hold timer becomes active once this wallet is above the minimum.";
        nextTier.textContent = data.nextTier
          ? ("Next bonus tier: " + data.nextTier + " in " + data.nextTierEta)
          : data.qualifiesNow
            ? "Already at the top hold tier."
            : "No hold tier yet because this wallet is below the live minimum.";
        paint(qualifiesNow, data.qualifiesNow, false);
        paint(hasWbtcAccount, data.hasWbtcAccount, false);
        paint(payableNow, data.payableNow, false);
        paint(shareCount, data.qualifiesNow, !data.qualifiesNow && data.shareCount === "0");
        paint(holdAge, data.qualifiesNow, !data.qualifiesNow);
        paint(holdTier, data.qualifiesNow, !data.qualifiesNow);
        paint(holdMultiplier, data.qualifiesNow, !data.qualifiesNow);
        paint(rewardPower, data.qualifiesNow, !data.qualifiesNow);
        paint(tokensNeeded, data.tokensNeeded === "0", false);
      } catch (error) {
        message.textContent = error instanceof Error ? error.message : String(error);
        qualifiesNow.textContent = "-";
        hasWbtcAccount.textContent = "-";
        payableNow.textContent = "-";
        holderBalance.textContent = "-";
        shareCount.textContent = "-";
        holdAge.textContent = "-";
        holdTier.textContent = "-";
        holdMultiplier.textContent = "-";
        rewardPower.textContent = "-";
        tokensNeeded.textContent = "-";
        eligibleSince.textContent = "Hold timer data appears here.";
        nextTier.textContent = "Next tier info appears here.";
        paint(qualifiesNow, false, true);
        paint(hasWbtcAccount, false, true);
        paint(payableNow, false, true);
        paint(shareCount, false, true);
        paint(holdAge, false, true);
        paint(holdTier, false, true);
        paint(holdMultiplier, false, true);
        paint(rewardPower, false, true);
        paint(tokensNeeded, false, true);
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
  const bonusTierHtml = [...HOLD_TIERS].reverse().map((tier) => {
    const bonusPct = ((tier.multiplierBps - 10_000) / 100).toFixed(0);
    const bonusText = Number(bonusPct) > 0 ? `+${bonusPct}% bonus` : "base reward";
    return `<div class="bonus-inline-card">
      <div class="k">${escapeHtml(tier.label)}</div>
      <div class="v">${formatMultiplier(tier.multiplierBps)} • ${escapeHtml(bonusText)}</div>
    </div>`;
  }).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(config.projectName)} Paid Summary</title>
  <style>
    :root {
      --bg: rgba(7, 7, 6, 0.92);
      --panel: rgba(14, 13, 10, 0.97);
      --panel-soft: rgba(23, 20, 15, 0.96);
      --panel-glow: rgba(255, 166, 0, 0.1);
      --line: rgba(255, 166, 0, 0.78);
      --line-strong: rgba(255, 166, 0, 0.9);
      --text: #fff7e6;
      --muted: #c5b8a0;
      --green: #6de01f;
      --gold: #ffefb0;
      --orange: #ff8c00;
      --amber: #ffd15a;
      --cyan: #69d4ff;
      --red: #ff8a80;
      --shadow: 0 22px 65px rgba(0, 0, 0, 0.56);
      --mono: Consolas, "SFMono-Regular", Menlo, monospace;
      --sans: Consolas, "SFMono-Regular", Menlo, monospace;
      --display: Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif;
    }

    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      font-family: var(--sans);
      color: var(--text);
      background: transparent;
    }

    body { padding: 0; }

    .frame {
      width: 100vw;
      height: 100vh;
      display: grid;
      grid-template-columns: minmax(760px, 1.28fr) minmax(470px, 1fr);
      gap: 12px;
      align-items: stretch;
      padding: 0;
      overflow: hidden;
    }

    .shell,
    .rail-panel {
      background:
        radial-gradient(circle at top right, rgba(109, 224, 31, 0.12), transparent 32%),
        radial-gradient(circle at top left, rgba(255, 140, 0, 0.18), transparent 26%),
        linear-gradient(180deg, rgba(18, 16, 12, 0.98), rgba(5, 5, 4, 0.98));
      border: 1px solid var(--line);
      border-radius: 0;
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .shell {
      display: grid;
      grid-template-rows: auto auto auto auto auto auto;
      min-height: 0;
    }

    .side {
      height: 100%;
      display: flex;
      flex-direction: column;
      gap: 8px;
      overflow: hidden;
      padding: 0;
      min-height: 100%;
    }

    .rail-panel {
      display: flex;
      flex-direction: column;
      flex: 0 0 auto;
      min-height: 0;
    }

    .rail-panel.rules-panel {
      flex: 1 1 auto;
    }

    .topbar {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      padding: 14px 20px 12px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(255, 166, 0, 0.08), rgba(255,255,255,0));
    }

    .title {
      color: var(--orange);
      font-family: var(--display);
      font-size: 34px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      line-height: 1;
    }

    .subtitle {
      color: var(--muted);
      font-size: 28px;
      line-height: 1.2;
      margin-top: 5px;
    }

    .sync-pill {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(255, 166, 0, 0.08);
      color: var(--gold);
      font-family: var(--mono);
      font-size: 16px;
      font-weight: 700;
      white-space: nowrap;
    }

    .sync-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--green);
      box-shadow: 0 0 18px rgba(140, 255, 95, 0.7);
    }

    .hero {
      padding: 12px 18px 8px;
      display: grid;
      gap: 6px;
    }

    .hero-main {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
    }

    .hero-copy {
      min-width: 0;
    }

    .hero-side {
      flex: 0 0 300px;
      display: grid;
      gap: 8px;
      align-content: start;
    }

    .eyebrow {
      color: var(--green);
      font-size: 24px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      margin-bottom: 6px;
    }

    .big {
      color: #fff4cf;
      font-size: 78px;
      font-weight: 700;
      line-height: 0.95;
    }

    .sub {
      max-width: 640px;
      margin-top: 8px;
      color: #fff0cf;
      font-size: 31px;
      line-height: 1.34;
    }

    .hero-pill {
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      padding: 9px 13px;
      color: var(--amber);
      font-family: var(--mono);
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      white-space: nowrap;
      background: rgba(255, 159, 28, 0.08);
      text-align: center;
    }

    .round-now {
      border: 1px solid rgba(255, 166, 0, 0.18);
      background: linear-gradient(180deg, rgba(255, 166, 0, 0.09), rgba(255,255,255,0.02));
      padding: 13px;
      display: grid;
      gap: 10px;
    }

    .round-now-top {
      color: var(--muted);
      font-size: 18px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    .round-now-main {
      color: var(--text);
      font-size: 39px;
      font-weight: 800;
      line-height: 1.05;
    }

    .round-now-sub {
      color: var(--muted);
      font-size: 24px;
      line-height: 1.35;
    }

    .round-now-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .round-now-card {
      border: 1px solid rgba(255,255,255,0.06);
      background: rgba(255,255,255,0.03);
      padding: 10px 11px;
    }

    .round-now-card .k {
      color: var(--muted);
      font-size: 17px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 5px;
    }

    .round-now-card .v {
      color: var(--text);
      font-size: 30px;
      font-weight: 800;
      line-height: 1.15;
    }

    .stats-strip {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }

    .mini {
      border: 1px solid rgba(255, 166, 0, 0.14);
      background: linear-gradient(180deg, rgba(255, 140, 0, 0.09), rgba(255,255,255,0.015));
      padding: 11px 13px;
      min-width: 0;
    }

    .mini-label {
      color: var(--muted);
      font-size: 18px;
      font-family: var(--mono);
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 6px;
    }

    .mini-value {
      color: var(--text);
      font-size: 44px;
      font-weight: 800;
      line-height: 1.02;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .mini-value.gold { color: #fff0ae; }
    .mini-value.green { color: #8dff57; }
    .mini-value.cyan { color: #9de8ff; }
    .mini-value.orange { color: #ffc273; }

    .status-ribbon {
      margin: 0 16px 8px;
      padding: 12px 14px;
      border: 1px solid rgba(109, 224, 31, 0.16);
      background: rgba(109, 224, 31, 0.06);
      color: #efffe2;
      font-size: 29px;
      line-height: 1.35;
    }

    .queue-grid {
      margin: 0 16px 8px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .queue-card {
      border: 1px solid rgba(255, 166, 0, 0.12);
      background: linear-gradient(180deg, rgba(255, 166, 0, 0.07), rgba(255,255,255,0.015));
      padding: 12px 14px;
      min-width: 0;
    }

    .queue-card.warn {
      border-color: rgba(255, 209, 90, 0.22);
      background: linear-gradient(180deg, rgba(255, 209, 90, 0.09), rgba(255,255,255,0.02));
    }

    .queue-card.owed {
      border-color: rgba(140, 255, 95, 0.2);
      background: linear-gradient(180deg, rgba(140, 255, 95, 0.07), rgba(255,255,255,0.02));
    }

    .queue-label {
      color: var(--muted);
      font-size: 18px;
      font-family: var(--mono);
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 6px;
    }

    .queue-value {
      color: var(--text);
      font-size: 40px;
      font-weight: 800;
      line-height: 1.08;
    }

    .queue-note {
      margin-top: 5px;
      color: var(--muted);
      font-size: 24px;
      line-height: 1.3;
    }

    .tiers {
      margin: 0 16px 8px;
      padding: 9px 12px 10px;
      border: 1px solid rgba(255, 166, 0, 0.18);
      background: rgba(255, 140, 0, 0.06);
    }

    .tiers-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }

    .tiers-title {
      color: var(--amber);
      font-size: 24px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.09em;
    }

    .tiers-sub {
      color: #ffe1a3;
      font-size: 22px;
      text-align: right;
    }

    .tier-list {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }

    .tier-pill {
      border: 1px solid rgba(255, 166, 0, 0.16);
      background: rgba(255, 140, 0, 0.05);
      padding: 10px 10px;
      min-width: 0;
    }

    .tier-pill .top {
      color: var(--green);
      font-size: 22px;
      font-weight: 800;
      margin-bottom: 4px;
      white-space: nowrap;
    }

    .tier-pill .bottom {
      color: var(--text);
      font-size: 29px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .fact,
    .rule-card,
    .tx-item {
      border: 1px solid rgba(255, 166, 0, 0.12);
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
      padding: 9px 11px;
      min-width: 0;
    }

    .fact-label,
    .rule-k,
    .rail-kicker {
      color: var(--muted);
      font-size: 18px;
      font-family: var(--mono);
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 6px;
    }

    .fact-value {
      color: var(--text);
      font-size: 31px;
      font-weight: 800;
      line-height: 1.16;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .fact-value.gold { color: #fff0ae; }
    .fact-value.green { color: #8dff57; }
    .fact-value.cyan { color: #9de8ff; }
    .fact-value.orange { color: #ffc273; }

    .panel-head {
      padding: 11px 14px 8px;
      border-bottom: 1px solid rgba(255, 166, 0, 0.12);
    }

    .panel-title {
      color: var(--text);
      font-size: 30px;
      font-weight: 900;
      letter-spacing: 0.09em;
      text-transform: uppercase;
    }

    .panel-sub {
      color: #ffe1a3;
      font-size: 22px;
      margin-top: 2px;
      line-height: 1.3;
    }

    .round-grid,
    .rule-grid {
      padding: 6px 12px 8px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      flex: 1 1 auto;
      align-content: start;
    }

    .meta-row {
      padding: 6px 12px 0;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .meta-pill {
      border: 1px solid rgba(255, 166, 0, 0.12);
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
      padding: 7px 9px;
      min-width: 0;
    }

    .meta-pill .k {
      color: var(--muted);
      font-size: 17px;
      font-family: var(--mono);
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 5px;
    }

    .meta-pill .v {
      color: var(--text);
      font-size: 27px;
      font-weight: 700;
      line-height: 1.25;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .bonus-wrap {
      padding: 0 14px 14px;
      display: grid;
      gap: 8px;
    }

    .bonus-head {
      color: var(--muted);
      font-family: var(--mono);
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .bonus-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }

    .bonus-card {
      border: 1px solid rgba(255, 166, 0, 0.12);
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
      padding: 10px 10px;
      min-width: 0;
    }

    .bonus-top {
      color: var(--green);
      font-family: var(--mono);
      font-size: 15px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-bottom: 6px;
    }

    .bonus-main {
      color: var(--text);
      font-size: 20px;
      font-weight: 800;
      line-height: 1;
      margin-bottom: 6px;
    }

    .bonus-note {
      color: var(--muted);
      font-size: 15px;
      line-height: 1.3;
    }

    .math-strip {
      padding: 0 14px 14px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .math-card {
      border: 1px solid rgba(255, 166, 0, 0.12);
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
      padding: 10px 12px;
    }

    .math-card strong {
      display: block;
      color: var(--text);
      font-size: 16px;
      margin-bottom: 5px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .math-card span {
      color: var(--muted);
      font-size: 15px;
      line-height: 1.35;
    }

    .rule-v {
      color: var(--text);
      font-size: 29px;
      font-weight: 700;
      line-height: 1.28;
    }

    .tx-list {
      padding: 6px 12px 8px;
      display: grid;
      gap: 8px;
      overflow: hidden;
    }

    .tx-item {
      display: grid;
      gap: 6px;
      padding: 10px 11px;
    }

    .tx-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }

    .tx-kind {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-family: var(--mono);
      font-size: 20px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--amber);
    }

    .tx-kind::before {
      content: "";
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--orange);
      box-shadow: 0 0 14px rgba(255, 159, 28, 0.45);
    }

    .tx-kind.claim::before { background: var(--amber); }
    .tx-kind.swap::before { background: var(--cyan); }
    .tx-kind.payout::before { background: var(--green); }
    .tx-kind.ops::before { background: #d7b8ff; }

    .tx-time {
      color: var(--muted);
      font-size: 21px;
      font-family: var(--mono);
    }

    .tx-detail {
      color: var(--text);
      font-size: 25px;
      line-height: 1.3;
    }

    .tx-link {
      color: var(--cyan);
      font-family: var(--mono);
      font-size: 21px;
      word-break: break-all;
    }

    .tx-empty {
      color: var(--muted);
      font-size: 22px;
      line-height: 1.4;
    }

    .rule-strip {
      padding: 0 12px 10px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: auto;
    }

    .rule-compact {
      border: 1px solid rgba(255, 166, 0, 0.12);
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
      padding: 10px 11px;
    }

    .rule-compact .k {
      color: var(--muted);
      font-size: 17px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 6px;
    }

    .rule-compact .v {
      color: var(--text);
      font-size: 27px;
      font-weight: 700;
      line-height: 1.3;
    }

    .live {
      margin: 0 18px 14px;
      padding: 10px 14px;
      border: 1px solid rgba(255, 166, 0, 0.14);
      background: rgba(255, 255, 255, 0.03);
      color: var(--gold);
      font-family: var(--mono);
      font-size: 23px;
      font-weight: 700;
      opacity: 0.95;
    }

    .live.stale { color: var(--red); }
    .live.good { color: var(--green); }

    .pulse {
      animation: pulse 0.45s ease;
    }

    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(143, 232, 255, 0.25); }
      100% { box-shadow: 0 0 0 16px rgba(143, 232, 255, 0); }
    }

    @media (max-height: 980px) {
      .big { font-size: 60px; }
      .subtitle { font-size: 19px; }
      .sub { font-size: 21px; }
      .round-now-main { font-size: 29px; }
      .round-now-sub { font-size: 18px; }
      .round-now-card .v { font-size: 22px; }
      .mini-value { font-size: 34px; }
      .queue-value { font-size: 30px; }
      .fact-value { font-size: 24px; }
      .rule-v { font-size: 21px; }
      .rule-compact .v { font-size: 19px; }
      .tier-pill .top { font-size: 16px; }
      .tier-pill .bottom { font-size: 21px; }
      .tx-detail, .tx-link { font-size: 18px; }
      .panel-sub, .live { font-size: 17px; }
      .status-ribbon, .queue-note { font-size: 18px; }
    }

    @media (max-width: 980px) {
      .frame {
        grid-template-columns: 1fr;
        overflow-y: auto;
        height: auto;
      }
      html, body {
        overflow: auto;
      }
      .shell {
        grid-template-rows: auto;
      }
      .queue-grid,
      .tier-list,
      .market-grid,
      .meta-row,
      .round-grid,
      .rule-grid,
      .bonus-grid,
      .math-strip,
      .rule-strip {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }

    @media (max-width: 620px) {
      .topbar,
      .hero-main,
      .tiers-head,
      .tx-top {
        display: grid;
      }
      .stats-strip,
      .queue-grid,
      .tier-list,
      .market-grid,
      .meta-row,
      .round-grid,
      .rule-grid,
      .bonus-grid,
      .math-strip,
      .rule-strip {
        grid-template-columns: 1fr;
      }
      .big { font-size: 42px; }
    }
  </style>
</head>
<body>
  <div class="frame">
  <div class="shell" id="card">
    <div class="topbar">
      <div>
        <div class="title">BTCBANK Live Payouts</div>
        <div class="subtitle">Live WBTC rewards for holders, with backlog and round progress in plain English.</div>
      </div>
      <div class="sync-pill"><span class="sync-dot"></span><span id="syncText">SYNC | connecting...</span></div>
    </div>
    <div class="hero">
      <div class="hero-main">
        <div class="hero-copy">
          <div class="eyebrow">All-Time Holder Value Sent</div>
          <div class="big" id="heroUsd">-</div>
          <div class="sub">This rises only when real payout transactions land on-chain. If this moves, holders are getting paid.</div>
        </div>
        <div class="hero-side">
          <div class="hero-pill" id="heroRound">Round idle</div>
          <div class="round-now">
            <div class="round-now-top">Round Right Now</div>
            <div class="round-now-main" id="heroRoundMain">Waiting for live round data</div>
            <div class="round-now-sub" id="heroRoundSub">The current round status, value, and queue pressure show here in one clean block.</div>
            <div class="round-now-grid">
              <div class="round-now-card"><div class="k">Round Value</div><div class="v" id="heroRoundValue">-</div></div>
              <div class="round-now-card"><div class="k">Still Owed</div><div class="v" id="heroRoundOwed">-</div></div>
              <div class="round-now-card"><div class="k">BTC</div><div class="v" id="marketBtc">-</div></div>
              <div class="round-now-card"><div class="k">WBTC</div><div class="v" id="marketWbtc">-</div></div>
            </div>
          </div>
        </div>
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
    <div class="status-ribbon" id="botNow">
      The bot is warming up and waiting for the latest live packet.
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
        <div class="tiers-sub">1 full share at each hold tier</div>
      </div>
      <div class="tier-list" id="tierExamples"></div>
    </div>
    <div class="live" id="live">LIVE | waiting for data</div>
  </div>
    <div class="side">
    <div class="rail-panel rules-panel">
      <div class="panel-head">
        <div class="panel-title">Round Details</div>
        <div class="panel-sub">Only the live round numbers the stream actually needs.</div>
      </div>
      <div class="meta-row">
        <div class="meta-pill"><div class="k">Round</div><div class="v" id="detailRoundId">-</div></div>
        <div class="meta-pill"><div class="k">Tier Mix</div><div class="v" id="detailTierMix">-</div></div>
      </div>
      <div class="round-grid">
        <div class="fact"><div class="fact-label">Claimed</div><div class="fact-value" id="detailClaimed">-</div></div>
        <div class="fact"><div class="fact-label">Reward</div><div class="fact-value gold" id="detailReward">-</div></div>
        <div class="fact"><div class="fact-label">Value</div><div class="fact-value gold" id="detailValue">-</div></div>
        <div class="fact"><div class="fact-label">Progress</div><div class="fact-value cyan" id="detailProgress">-</div></div>
        <div class="fact"><div class="fact-label">Paid Now</div><div class="fact-value green" id="detailPaid">-</div></div>
        <div class="fact"><div class="fact-label">Paid Total</div><div class="fact-value green" id="detailPaidTotal">-</div></div>
      </div>
    </div>
    <div class="rail-panel">
      <div class="panel-head">
        <div class="panel-title">Latest Chain Activity</div>
        <div class="panel-sub">Fresh chain events in a readable stream-first format.</div>
      </div>
      <div class="tx-list" id="txList">
        <div class="tx-empty">Waiting for live transactions...</div>
      </div>
    </div>
    <div class="rail-panel">
      <div class="panel-head">
        <div class="panel-title">Live Rules</div>
        <div class="panel-sub">Short, readable rules instead of tiny text blocks.</div>
      </div>
      <div class="rule-grid">
        <div class="rule-card"><div class="rule-k">Qualify Line</div><div class="rule-v" id="ruleQualify">-</div></div>
        <div class="rule-card"><div class="rule-k">Approx Cost</div><div class="rule-v" id="ruleCost">-</div></div>
        <div class="rule-card"><div class="rule-k">Share Rule</div><div class="rule-v" id="ruleShares">-</div></div>
        <div class="rule-card"><div class="rule-k">Hold Bonus</div><div class="rule-v" id="ruleHold">-</div></div>
      </div>
      <div class="rule-strip">
        <div class="rule-compact"><div class="k">Wallet Setup</div><div class="v" id="ruleWbtc">-</div></div>
        <div class="rule-compact"><div class="k">Reset Rule</div><div class="v" id="ruleReset">-</div></div>
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
    let stalePollRequested = false;

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

    function shortSig(sig) {
      if (!sig || sig.length < 14) return sig || "-";
      return sig.slice(0, 6) + "..." + sig.slice(-6);
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
      const syncEl = document.getElementById("syncText");
      const syncSuffix = syncAge === 0 ? "just now" : syncAge === 1 ? "1s ago" : syncAge + "s ago";
      if (syncAge >= 15) {
        liveEl.textContent = "SYNC STALE | reconnecting | last sync " + syncSuffix + " | poll 2s";
        liveEl.className = "live stale";
        syncEl.textContent = "STALE | last sync " + syncSuffix;
      } else {
        liveEl.textContent = "SYNC OK | last sync " + syncSuffix + " | poll 2s | push " + packetCount;
        liveEl.className = "live good";
        syncEl.textContent = "LIVE | last sync " + syncSuffix;
      }
      if (syncAge >= 45 && !stalePollRequested) {
        stalePollRequested = true;
        loadOnce().finally(() => { stalePollRequested = false; }).catch(() => {});
      }
      if (nextCheckAtMs !== null) {
        const seconds = Math.max(0, Math.ceil((nextCheckAtMs - Date.now()) / 1000));
        document.getElementById("nextCheck").textContent = seconds <= 0 ? "now" : formatEta(seconds);
      }
    }

    function describeBot(data, round) {
      if (round && round.pendingRecipients > 0) {
        return "Current round is active. " + round.pendingRecipients + " payout" + (round.pendingRecipients === 1 ? "" : "s") + " still need to land.";
      }
      if (data.queue.pendingEntries > 0) {
        return "Current round is clear. Backlog still has " + data.queue.pendingEntries.toLocaleString() + " older payout" + (data.queue.pendingEntries === 1 ? "" : "s") + " queued.";
      }
      if (data.queue.awaitingSwapRounds > 0) {
        return "Payouts are clear. " + data.queue.awaitingSwapRounds + " reward round" + (data.queue.awaitingSwapRounds === 1 ? "" : "s") + " still need the WBTC buy.";
      }
      return "Everything looks caught up right now. The bot is waiting for the next reward claim window.";
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

    function renderRecentTxs(txs) {
      const root = document.getElementById("txList");
      if (!txs || txs.length === 0) {
        root.innerHTML = '<div class="tx-empty">No fresh chain activity yet. Claims, swaps, and payouts will show up here as they land.</div>';
        return;
      }

      root.innerHTML = txs.slice(0, 2).map((tx) => {
        const kindClass = (tx.kind || "tx").toLowerCase();
        return (
          '<div class="tx-item">' +
            '<div class="tx-top">' +
              '<div class="tx-kind ' + kindClass + '">' + tx.kind + '</div>' +
              '<div class="tx-time">' + formatClock(tx.at) + '</div>' +
            '</div>' +
            '<div class="tx-detail">' + tx.detail + '</div>' +
            '<div class="tx-link">' + shortSig(tx.sig) + '</div>' +
          '</div>'
        );
      }).join("");
    }

    function applyPayload(data) {
      packetCount += 1;
      lastPushMs = Date.now();
      lastSyncMs = Date.now();
      stalePollRequested = false;
      nextCheckAtMs = data.nextCheckAt ? new Date(data.nextCheckAt).getTime() : null;
      const round = data.activeRound || data.recentRounds[0] || null;
      document.getElementById("heroUsd").textContent = data.totals.totalPaidUsd === null
        ? "pricing..."
        : usdFormatter.format(data.totals.totalPaidUsd);
      document.getElementById("heroWbtc").textContent = data.totals.totalPaidWbtc;
      document.getElementById("heroHolders").textContent = data.totals.holdersPaidTotal.toLocaleString();
      document.getElementById("heroRounds").textContent = data.totals.roundsTotal.toLocaleString();
      document.getElementById("marketBtc").textContent = data.market.btcUsd === null ? "pricing..." : usdFormatter.format(data.market.btcUsd);
      document.getElementById("marketWbtc").textContent = data.market.wbtcUsd === null ? "pricing..." : usdFormatter.format(data.market.wbtcUsd);
      document.getElementById("heroRound").textContent = round
        ? "Round " + round.id.slice(-6) + " " + round.status.replaceAll("_", " ")
        : "Round idle";
      document.getElementById("heroRoundMain").textContent = round
        ? round.pendingRecipients > 0
          ? round.pendingRecipients + " payout" + (round.pendingRecipients === 1 ? "" : "s") + " still waiting"
          : "Current round is fully clear"
        : "Waiting for live round data";
      document.getElementById("heroRoundSub").textContent = round
        ? (round.holders + " qualified | " + round.paidRecipients + " paid | " + (round.tierMix || "live tier mix loading"))
        : "The current round status, value, and queue pressure show here in one clean block.";
      document.getElementById("heroRoundValue").textContent = round && round.rewardUsd !== null
        ? usdFormatter.format(round.rewardUsd)
        : "pricing...";
      document.getElementById("heroRoundOwed").textContent = round ? round.pendingRewardWbtc + " WBTC" : "-";
      document.getElementById("botNow").textContent = describeBot(data, round);
      document.getElementById("qualifiedRound").textContent = round ? round.holders + " holders" : "-";
      document.getElementById("roundStarted").textContent = "Started: " + (round ? formatClock(round.createdAt) : "-");
      document.getElementById("leftToPay").textContent = round ? round.pendingRecipients + " holders" : "-";
      document.getElementById("owedRound").textContent = "Still owed: " + (round ? round.pendingRewardWbtc + " WBTC" : "-");
      document.getElementById("nextCheck").textContent = data.nextCheckSeconds === null
        ? "calculating"
        : data.nextCheckSeconds <= 0
          ? "now"
          : formatEta(data.nextCheckSeconds);
      document.getElementById("queueRounds").textContent = data.queue.pendingRounds + " round" + (data.queue.pendingRounds === 1 ? "" : "s") + " | " + data.queue.awaitingSwapRounds + " swap" + (data.queue.awaitingSwapRounds === 1 ? "" : "s");
      document.getElementById("queueEntries").textContent = data.queue.pendingEntries.toLocaleString() + " payouts";
      document.getElementById("queueOwed").textContent = data.queue.pendingRewardWbtc + " WBTC still waiting";
      document.getElementById("detailRoundId").textContent = round ? round.id.slice(-8) : "-";
      document.getElementById("detailTierMix").textContent = round && round.tierMix ? round.tierMix : "no tier mix yet";
      document.getElementById("detailClaimed").textContent = round ? round.claimSol + " SOL" : "-";
      document.getElementById("detailReward").textContent = round ? round.rewardWbtc + " WBTC" : "-";
      document.getElementById("detailValue").textContent = round && round.rewardUsd !== null
        ? usdFormatter.format(round.rewardUsd)
        : "pricing...";
      document.getElementById("detailProgress").textContent = round ? round.paidRecipients + " / " + round.holders + " paid" : "-";
      document.getElementById("detailPaid").textContent = round ? round.paidRecipients + " holders" : "-";
      document.getElementById("detailPaidTotal").textContent = data.totals.holdersPaidTotal.toLocaleString() + " holders";
      document.getElementById("ruleQualify").textContent = data.qualification.minimumTokens + " BTCBANK";
      document.getElementById("ruleCost").textContent = data.qualification.approxUsd === null
        ? "pricing..."
        : "~" + usdFormatter.format(data.qualification.approxUsd) + (data.qualification.approxSol === null ? "" : " | " + data.qualification.approxSol.toFixed(3) + " SOL");
      document.getElementById("ruleShares").textContent = "Every full " + data.qualification.minimumTokens + " = 1 share";
      document.getElementById("ruleHold").textContent = "Hold longer = bigger bonus";
      document.getElementById("ruleWbtc").textContent = "No-WBTC accounts need WBTC once";
      document.getElementById("ruleReset").textContent = "Below " + data.qualification.minimumTokens + " = timer reset";
      renderTierExamples(round);
      renderRecentTxs(data.recentTxs);
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
    }, 2000);
    setInterval(() => {
      if (!lastPushMs) return;
      const ageMs = Date.now() - lastPushMs;
      if (ageMs < 6000) return;
      if (Date.now() - staleRecoverAt < 2000) return;
      staleRecoverAt = Date.now();
      loadOnce().catch(() => {});
    }, 2000);
  </script>
</body>
</html>`;
}

function renderOpsHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(config.projectName)} Ops Board</title>
  <style>
    :root {
      --bg: #060504;
      --panel: rgba(16, 13, 10, 0.92);
      --panel-2: rgba(10, 8, 7, 0.96);
      --text: #fff7e6;
      --muted: #c5b8a0;
      --line: rgba(255, 166, 0, 0.18);
      --orange: #ff8c00;
      --amber: #ffd15a;
      --green: #6de01f;
      --cyan: #69d4ff;
      --red: #ff8a80;
      --shadow: 0 22px 65px rgba(0, 0, 0, 0.42);
      --mono: Consolas, "SFMono-Regular", Menlo, monospace;
      --display: Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      font-family: var(--mono);
      background:
        radial-gradient(circle at top right, rgba(109,224,31,0.08), transparent 24%),
        radial-gradient(circle at top left, rgba(255,140,0,0.16), transparent 28%),
        linear-gradient(180deg, #0b0908 0%, #040404 100%);
      padding: 18px;
    }
    .page {
      width: min(1480px, 100%);
      margin: 0 auto;
      display: grid;
      gap: 16px;
    }
    .hero, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 22px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .hero {
      padding: 18px 20px 16px;
      background:
        radial-gradient(circle at top right, rgba(109,224,31,0.08), transparent 22%),
        linear-gradient(180deg, rgba(255,166,0,0.08), rgba(255,255,255,0)),
        var(--panel);
    }
    .eyebrow {
      color: var(--green);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.16em;
    }
    .hero-top {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      flex-wrap: wrap;
    }
    h1 {
      margin: 8px 0 0;
      color: var(--orange);
      font-family: var(--display);
      font-size: clamp(38px, 6vw, 72px);
      line-height: 0.9;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .subhero {
      margin-top: 10px;
      max-width: 940px;
      color: var(--text);
      font-size: clamp(14px, 2vw, 22px);
      line-height: 1.3;
    }
    .hero-note {
      margin-top: 10px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .site-tabs {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    .site-tab {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 9px 12px;
      border-radius: 999px;
      border: 1px solid rgba(255,166,0,0.18);
      background: rgba(255,166,0,0.06);
      color: var(--amber);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-decoration: none;
      text-transform: uppercase;
    }
    .site-tab.active {
      border-color: rgba(109,224,31,0.28);
      background: rgba(109,224,31,0.12);
      color: var(--green);
    }
    .live-pill {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid rgba(255,166,0,0.18);
      background: rgba(255,166,0,0.08);
      color: var(--amber);
      font-weight: 700;
      white-space: nowrap;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--green);
      box-shadow: 0 0 14px rgba(109,224,31,0.75);
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
      gap: 12px;
    }
    .stat {
      background: var(--panel-2);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 18px;
      padding: 14px 16px;
    }
    .label {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }
    .value {
      margin-top: 8px;
      font-size: clamp(22px, 2vw, 30px);
      font-weight: 800;
      line-height: 1;
    }
    .note {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
    }
    .layout {
      display: grid;
      grid-template-columns: 1.05fr 0.95fr;
      gap: 16px;
    }
    .stack {
      display: grid;
      gap: 16px;
    }
    .panel {
      padding: 16px;
    }
    .panel-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: baseline;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .panel-title {
      color: var(--amber);
      font-size: 18px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .panel-meta {
      color: var(--muted);
      font-size: 12px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .summary-card, .event-card, .round-card {
      background: var(--panel-2);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 16px;
      padding: 12px 13px;
    }
    .summary-title, .event-title, .round-id {
      color: var(--text);
      font-size: 14px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .summary-rows {
      margin-top: 10px;
      display: grid;
      gap: 8px;
    }
    .summary-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: baseline;
      padding-bottom: 7px;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .summary-row:last-child {
      border-bottom: 0;
      padding-bottom: 0;
    }
    .summary-key {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .summary-value {
      color: var(--text);
      font-size: 13px;
      font-weight: 700;
      text-align: right;
    }
    .round-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .mini {
      background: rgba(255,255,255,0.03);
      border-radius: 12px;
      padding: 9px 10px;
    }
    .mini .value {
      margin-top: 5px;
      font-size: 16px;
    }
    .events {
      display: grid;
      gap: 10px;
      max-height: 980px;
      overflow: auto;
      padding-right: 4px;
    }
    .event-top {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .tone-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .tone-badge.good { color: var(--green); background: rgba(109,224,31,0.1); border: 1px solid rgba(109,224,31,0.22); }
    .tone-badge.warn { color: var(--amber); background: rgba(255,209,90,0.1); border: 1px solid rgba(255,209,90,0.22); }
    .tone-badge.bad { color: var(--red); background: rgba(255,138,128,0.1); border: 1px solid rgba(255,138,128,0.22); }
    .tone-badge.info { color: var(--cyan); background: rgba(105,212,255,0.1); border: 1px solid rgba(105,212,255,0.22); }
    .event-time {
      color: var(--muted);
      font-size: 12px;
    }
    .event-detail {
      color: var(--text);
      font-size: 13px;
      line-height: 1.45;
    }
    .empty {
      color: var(--muted);
      font-size: 13px;
      border: 1px dashed rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 16px;
      text-align: center;
    }
    @media (max-width: 1200px) {
      .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .layout { grid-template-columns: 1fr; }
      .summary-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 760px) {
      body { padding: 12px; }
      .stat-grid { grid-template-columns: 1fr; }
      .round-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      h1 { font-size: 42px; }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <div class="hero-top">
        <div>
          <div class="eyebrow">Bitcoin Bank Live Ops</div>
          <h1><span id="brandName">BTCBANK</span> Ops Board</h1>
          <div class="subhero">Cleaner bot status, cleaner replay queue, and the same BTCBANK look as the rest of the stream stack.</div>
          <div class="hero-note">This board turns the runtime log into readable status cards so you can spot backlog pressure, no-WBTC holds, and payout retries without watching raw terminal spam.</div>
          ${renderSiteTabs("ops")}
        </div>
        <div class="live-pill"><span class="dot"></span><span id="liveStamp">Connecting...</span></div>
      </div>
    </section>

    <section class="stat-grid">
      <div class="stat">
        <div class="label">Next Main Check</div>
        <div class="value" id="nextCheck">-</div>
        <div class="note">When the next claim cycle should wake up.</div>
      </div>
      <div class="stat">
        <div class="label">Backlog Rounds</div>
        <div class="value" id="pendingRounds">-</div>
        <div class="note">Saved rounds still waiting to finish payouts.</div>
      </div>
      <div class="stat">
        <div class="label">Unsent Payouts</div>
        <div class="value" id="pendingEntries">-</div>
        <div class="note">Holder sends still sitting in the replay queue.</div>
      </div>
      <div class="stat">
        <div class="label">Replay Timeouts</div>
        <div class="value" id="replayTimeouts">-</div>
        <div class="note">How often the 90s replay safety window has been hit recently.</div>
      </div>
      <div class="stat">
        <div class="label">No-WBTC Holds</div>
        <div class="value" id="noWbtcHolds">-</div>
        <div class="note">Holders still waiting on their WBTC account setup.</div>
      </div>
    </section>

    <section class="layout">
      <div class="stack">
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">Live Queue</div>
            <div class="panel-meta" id="queueMeta">Reading runtime state...</div>
          </div>
          <div class="round-card" id="activeRoundWrap"></div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">Runtime Snapshots</div>
            <div class="panel-meta">Latest structured boxes from the worker</div>
          </div>
          <div class="summary-grid" id="summaryGrid"></div>
        </section>
      </div>

      <section class="panel">
        <div class="panel-head">
          <div class="panel-title">Recent Ops Feed</div>
          <div class="panel-meta">Curated from runtime.jsonl</div>
        </div>
        <div class="events" id="events"></div>
      </section>
    </section>
  </div>

  <script>
    const fmtTime = (iso) => {
      try {
        return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      } catch {
        return iso || "";
      }
    };

    const fmtNext = (seconds) => {
      if (seconds === null || seconds === undefined) return "Live";
      if (seconds <= 0) return "Any second";
      if (seconds < 60) return seconds + "s";
      const minutes = Math.floor(seconds / 60);
      const remSeconds = seconds % 60;
      return remSeconds > 0 ? minutes + "m " + remSeconds + "s" : minutes + "m";
    };

    function renderActiveRound(round, queue) {
      const root = document.getElementById("activeRoundWrap");
      document.getElementById("queueMeta").textContent =
        queue.pendingRewardWbtc + " WBTC waiting | ETA " + (queue.pendingEtaSeconds === null ? "live" : fmtNext(queue.pendingEtaSeconds));

      if (!round) {
        root.innerHTML = '<div class="empty">No active round right now. The board will fill itself as soon as the worker saves the next round.</div>';
        return;
      }

      root.innerHTML = \`
        <div class="round-id">\${round.id}</div>
        <div class="note" style="margin-top:8px;">\${round.pendingRecipients} payout(s) still waiting across \${queue.pendingRounds} backlog round(s). Some of the hold traffic below may be from no-WBTC accounts.</div>
        <div class="round-grid">
          <div class="mini"><div class="label">Status</div><div class="value">\${round.status.replaceAll("_", " ")}</div></div>
          <div class="mini"><div class="label">Claimed</div><div class="value">\${round.claimSol} SOL</div></div>
          <div class="mini"><div class="label">WBTC Ready</div><div class="value">\${queue.pendingRewardWbtc}</div></div>
          <div class="mini"><div class="label">Paid / Total</div><div class="value">\${round.paidRecipients} / \${round.holders}</div></div>
        </div>
      \`;
    }

    function renderSummaries(summaries) {
      const root = document.getElementById("summaryGrid");
      if (!summaries.length) {
        root.innerHTML = '<div class="empty">No structured summaries have landed yet.</div>';
        return;
      }

      root.innerHTML = summaries.map((summary) => \`
        <div class="summary-card">
          <div class="summary-title">\${summary.title}</div>
          <div class="summary-rows">
            \${summary.rows.map((row) => \`
              <div class="summary-row">
                <div class="summary-key">\${row.label}</div>
                <div class="summary-value">\${row.value}</div>
              </div>
            \`).join("")}
          </div>
        </div>
      \`).join("");
    }

    function renderEvents(events) {
      const root = document.getElementById("events");
      if (!events.length) {
        root.innerHTML = '<div class="empty">Waiting for runtime events...</div>';
        return;
      }

      root.innerHTML = events.map((event) => \`
        <div class="event-card">
          <div class="event-top">
            <div class="event-title">\${event.headline}</div>
            <div class="tone-badge \${event.tone}">\${event.level}</div>
          </div>
          <div class="event-time">\${fmtTime(event.at)}</div>
          <div class="event-detail" style="margin-top:8px;">\${event.detail}</div>
        </div>
      \`).join("");
    }

    function applyPayload(data) {
      document.getElementById("brandName").textContent = data.projectName;
      document.getElementById("liveStamp").textContent = "Live refresh • " + fmtTime(data.updatedAt);
      document.getElementById("nextCheck").textContent = fmtNext(data.nextCheckSeconds);
      document.getElementById("pendingRounds").textContent = String(data.queue.pendingRounds);
      document.getElementById("pendingEntries").textContent = String(data.queue.pendingEntries);
      document.getElementById("replayTimeouts").textContent = String(data.counters.replayTimeouts);
      document.getElementById("noWbtcHolds").textContent = String(data.counters.noWbtcHolds);
      renderActiveRound(data.activeRound, data.queue);
      renderSummaries(data.summaries);
      renderEvents(data.events);
    }

    async function refresh() {
      const response = await fetch("/api/ops?_ts=" + Date.now(), { cache: "no-store" });
      const data = await response.json();
      applyPayload(data);
    }

    refresh().catch(() => {});
    setInterval(() => {
      refresh().catch(() => {});
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
    .site-tabs {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    .site-tab {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 9px 12px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.04);
      color: #eefaf1;
      font-family: var(--mono);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-decoration: none;
      text-transform: uppercase;
    }
    .site-tab.active {
      border-color: rgba(251,146,60,0.28);
      background: rgba(251,146,60,0.14);
      color: var(--orange);
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
          <div class="hero-note" id="heroNote">Stop jeeting. Stop selling. This page shows exactly how the live reward machine works and what your wallet needs to earn more.</div>
          ${renderSiteTabs("dashboard")}
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
            <strong>Stop jeeting. Stop selling. Bigger bag + longer hold = more wBTC.</strong>
            <p>Hold enough and you qualify. More tokens give you more reward power. Holding longer increases that reward power with a loyalty bonus. Sell below the line and the timer resets. Stay in and the math gets better.</p>
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
        "Stop jeeting. Stop selling. The bot checks every 5 minutes, converts creator rewards into wBTC, and pays based on bag size plus hold-time loyalty.";
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
    }, 2000);
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

    if (url.pathname === "/api/ops") {
      const payload = await buildOpsPayload();
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
      try {
        const payload = await buildWalletCheckPayload(wallet);
        sendJson(res, payload);
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Wallet check failed" }));
      }
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

    if (url.pathname === "/ops" || url.pathname === "/control-room") {
      sendOpsHtml(res);
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
  console.log(`[overlay] Ops board: http://127.0.0.1:${port}/ops`);
  console.log(`[overlay] Wallet: ${shorten(signer.publicKey.toBase58(), 8, 8)}`);
});
