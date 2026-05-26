import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  Connection,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

import { config } from "./config.js";
import { sendDistributionBatch } from "./lib/distributor.js";
import { chunk, formatSol, formatTokenAmount, formatUsd, shorten, toLamports } from "./lib/format.js";
import { HoldTrackingStore } from "./lib/holdTracking.js";
import { getHolderSummary } from "./lib/holders.js";
import { quoteTokenToUsd, swapSolForToken } from "./lib/jupiter.js";
import { Logger } from "./lib/logger.js";
import { PayoutLog } from "./lib/payoutLog.js";
import { PumpService } from "./lib/pump.js";
import { RpcPool } from "./lib/rpcPool.js";
import { installRuntimeNoiseFilter } from "./lib/runtimeNoiseFilter.js";
import { PayoutRecipientState, PayoutRoundState, StateStore } from "./lib/state.js";
import { sendInstructions } from "./lib/tx.js";
import { loadKeypair } from "./lib/wallet.js";

installRuntimeNoiseFilter();

const logger = new Logger();
const rpcPool = new RpcPool(config.rpcUrls);
const stateStore = new StateStore(config.stateFilePath);
const holdTrackingStore = new HoldTrackingStore(config.holdTrackingFilePath);
const payoutLog = new PayoutLog();
const signer = loadKeypair(config.devPrivateKey);
const creator = signer.publicKey;
const holderMint = new PublicKey(config.holderMint);
const rewardMint = new PublicKey(config.rewardMint);
const treasury = new PublicKey(config.treasuryAddress);
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

let cycleRunning = false;
let replayCatchupRunning = false;
let replayCatchupTimer: NodeJS.Timeout | null = null;
let queuedClaimCycle = false;
let rewardMintDecimalsCache: number | null = null;
let lastHoldMessage: string | null = null;
let lastHoldMessageAt = 0;
let suppressedHoldRepeats = 0;
let lastReplayHeartbeat: string | null = null;
let lastReplayHeartbeatAt = 0;
let lastGoodMissingPaidUsdCache: { raw: string; usd: number } | null = null;
let eligibleOwnersCache: { fetchedAt: number; owners: Set<string> } | null = null;
let workerLockHeld = false;
let workerLockCleanupRegistered = false;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOLD_TIERS = [
  { label: "30d+", minMs: 30 * DAY_MS, multiplierBps: 12_000 },
  { label: "14d+", minMs: 14 * DAY_MS, multiplierBps: 11_200 },
  { label: "7d+", minMs: 7 * DAY_MS, multiplierBps: 10_700 },
  { label: "72h+", minMs: 3 * DAY_MS, multiplierBps: 10_300 },
  { label: "24h+", minMs: DAY_MS, multiplierBps: 10_100 },
  { label: "<24h", minMs: 0, multiplierBps: 10_000 },
] as const;
const MAX_SWAP_REPLAYS_PER_CYCLE = 1;
const MAX_REPLAY_BATCHES_PER_CYCLE = 48;
const MAX_REPLAY_BATCHES_PER_CATCHUP = 48;
const REPLAY_CATCHUP_DELAY_MS = 250;
const SWAP_RETRY_COOLDOWN_MS = 30_000;
const NO_WBTC_ACCOUNT_RETRY_COOLDOWN_MS = 60 * 60 * 1000;
const LOW_SOL_RETRY_COOLDOWN_MS = 60_000;
const HOLD_MESSAGE_COOLDOWN_MS = 60_000;
const REPLAY_HEARTBEAT_COOLDOWN_MS = 60_000;
const ELIGIBLE_OWNER_CACHE_MS = 60_000;
const REPLAY_PASS_TIMEOUT_MS = 90_000;
const HOLDER_SCAN_TIMEOUT_MS = 60_000;
const REWARD_ACCOUNT_SCAN_TIMEOUT_MS = 60_000;
const CLAIMABLE_CHECK_TIMEOUT_MS = 30_000;
const CLAIM_BALANCE_SETTLE_ATTEMPTS = 6;
const CLAIM_BALANCE_SETTLE_DELAY_MS = 1_000;
const WORKER_LOCK_PATH = resolve(config.workerLockFilePath);

type HoldTier = typeof HOLD_TIERS[number];
type EligibleHolderWithTier = {
  owner: PublicKey;
  rawBalance: bigint;
  shareCount: bigint;
  eligibleSince: string;
  holdDurationMs: number;
  holdTierLabel: string;
  holdMultiplierBps: number;
  weightUnits: bigint;
};

type RewardAccountPayability = {
  payableOwners: Set<string>;
  payableCount: number;
  missingCount: number;
};

type PendingRoundWithCount = {
  round: PayoutRoundState;
  pendingCount: number;
};

function logHoldMessage(message: string): void {
  const now = Date.now();

  if (lastHoldMessage === message && now - lastHoldMessageAt < HOLD_MESSAGE_COOLDOWN_MS) {
    suppressedHoldRepeats += 1;
    return;
  }

  if (suppressedHoldRepeats > 0 && lastHoldMessage) {
    logger.callout("hold", `${lastHoldMessage} (repeated ${suppressedHoldRepeats}x)`);
  }

  logger.callout("hold", message);
  lastHoldMessage = message;
  lastHoldMessageAt = now;
  suppressedHoldRepeats = 0;
}

function flushHoldSummary(): void {
  if (suppressedHoldRepeats > 0 && lastHoldMessage) {
    logger.callout("hold", `${lastHoldMessage} (repeated ${suppressedHoldRepeats}x)`);
    suppressedHoldRepeats = 0;
    lastHoldMessageAt = Date.now();
  }
}

function queueClaimCycle(): void {
  queuedClaimCycle = true;
}

function maybeRunQueuedClaimCycle(): void {
  if (!queuedClaimCycle || cycleRunning || replayCatchupRunning) {
    return;
  }

  queuedClaimCycle = false;
  setTimeout(() => {
    void runCycle();
  }, 100);
}

function logReplayHeartbeat(message: string): void {
  const now = Date.now();

  if (lastReplayHeartbeat === message && now - lastReplayHeartbeatAt < REPLAY_HEARTBEAT_COOLDOWN_MS) {
    return;
  }

  logger.ops(message);
  lastReplayHeartbeat = message;
  lastReplayHeartbeatAt = now;
}

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.floor(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSettledConfirmedBalance(
  connection: Connection,
  owner: PublicKey,
  attempts = CLAIM_BALANCE_SETTLE_ATTEMPTS,
  delayMs = CLAIM_BALANCE_SETTLE_DELAY_MS,
): Promise<bigint> {
  let highestObserved = 0n;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const balance = BigInt(await connection.getBalance(owner, "confirmed"));
    if (balance > highestObserved) {
      highestObserved = balance;
    }

    if (attempt < attempts - 1) {
      await delay(delayMs);
    }
  }

  return highestObserved;
}

async function getCurrentEligibleOwnerSet(): Promise<Set<string>> {
  const now = Date.now();
  if (eligibleOwnersCache && now - eligibleOwnersCache.fetchedAt < ELIGIBLE_OWNER_CACHE_MS) {
    return eligibleOwnersCache.owners;
  }

  const excludedOwners = new Set<string>([
    creator.toBase58(),
    treasury.toBase58(),
    ...config.excludedHolderAddresses,
  ]);

  const holderSummary = await withTimeout(
    "Replay holder scan",
    rpcPool.withFailover((rpc) =>
      getHolderSummary(
        rpc,
        holderMint,
        config.holderMinTokens,
        excludedOwners,
        config.skipOffCurveOwners,
      ),
    ),
    HOLDER_SCAN_TIMEOUT_MS,
  );

  const owners = new Set(holderSummary.eligible.map((holder) => holder.owner.toBase58()));
  eligibleOwnersCache = {
    fetchedAt: now,
    owners,
  };
  return owners;
}

function getPendingRecipientCount(round: PayoutRoundState): number {
  return round.recipients.filter((recipient) => recipient.status === "pending").length;
}

function sortPendingRoundsForReplay(rounds: PayoutRoundState[]): PendingRoundWithCount[] {
  const now = Date.now();
  const recentPriorityWindowMs = 2 * HOUR_MS;

  return rounds
    .map((round) => ({
      round,
      pendingCount: getPendingRecipientCount(round),
    }))
    .filter((entry) => entry.pendingCount > 0)
    .sort((left, right) => {
      const leftCreatedAtMs = Date.parse(left.round.createdAt);
      const rightCreatedAtMs = Date.parse(right.round.createdAt);
      const leftIsRecent = Number.isFinite(leftCreatedAtMs) && now - leftCreatedAtMs <= recentPriorityWindowMs;
      const rightIsRecent = Number.isFinite(rightCreatedAtMs) && now - rightCreatedAtMs <= recentPriorityWindowMs;

      if (leftIsRecent !== rightIsRecent) {
        return leftIsRecent ? -1 : 1;
      }

      if (leftIsRecent && rightIsRecent) {
        return right.round.createdAt.localeCompare(left.round.createdAt);
      }

      if (left.pendingCount !== right.pendingCount) {
        return right.pendingCount - left.pendingCount;
      }
      return right.round.createdAt.localeCompare(left.round.createdAt);
    });
}

async function getRewardAccountPayability(
  connection: Connection,
  owners: PublicKey[],
): Promise<RewardAccountPayability> {
  if (owners.length === 0) {
    return {
      payableOwners: new Set<string>(),
      payableCount: 0,
      missingCount: 0,
    };
  }

  const rewardTokenProgram = await detectTokenProgram(connection, rewardMint);
  const targets = owners.map((owner) => ({
    owner,
    ata: getAssociatedTokenAddressSync(
      rewardMint,
      owner,
      true,
      rewardTokenProgram,
    ),
  }));

  const payableOwners = new Set<string>();
  for (const batch of chunk(targets, 100)) {
    const infos = await connection.getMultipleAccountsInfo(
      batch.map((target) => target.ata),
      "confirmed",
    );
    infos.forEach((info, index) => {
      if (info !== null) {
        payableOwners.add(batch[index]!.owner.toBase58());
      }
    });
  }

  return {
    payableOwners,
    payableCount: payableOwners.size,
    missingCount: Math.max(0, owners.length - payableOwners.size),
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseWorkerLock(): void {
  if (!workerLockHeld) {
    return;
  }

  try {
    rmSync(WORKER_LOCK_PATH, { force: true });
  } catch {
    // Ignore lock cleanup failures on shutdown.
  } finally {
    workerLockHeld = false;
  }
}

function registerWorkerLockCleanup(): void {
  if (workerLockCleanupRegistered) {
    return;
  }

  workerLockCleanupRegistered = true;
  process.once("SIGINT", () => {
    releaseWorkerLock();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    releaseWorkerLock();
    process.exit(0);
  });
  process.once("exit", () => {
    releaseWorkerLock();
  });
}

function acquireWorkerLock(): void {
  mkdirSync(dirname(WORKER_LOCK_PATH), { recursive: true });
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    wallet: creator.toBase58(),
  }, null, 2);

  try {
    writeFileSync(WORKER_LOCK_PATH, payload, { flag: "wx" });
    workerLockHeld = true;
    registerWorkerLockCleanup();
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw error;
    }
  }

  let existingPid: number | null = null;
  try {
    const existing = JSON.parse(readFileSync(WORKER_LOCK_PATH, "utf8")) as { pid?: unknown };
    if (typeof existing.pid === "number" && Number.isInteger(existing.pid) && existing.pid > 0) {
      existingPid = existing.pid;
    }
  } catch {
    existingPid = null;
  }

  if (existingPid !== null && isPidAlive(existingPid)) {
    throw new Error(`Another payer worker is already running (pid ${existingPid}). Stop it before starting a new one.`);
  }

  rmSync(WORKER_LOCK_PATH, { force: true });
  writeFileSync(WORKER_LOCK_PATH, payload, { flag: "wx" });
  workerLockHeld = true;
  registerWorkerLockCleanup();
}

async function main(): Promise<void> {
  acquireWorkerLock();
  await logger.init();
  await stateStore.init();
  await holdTrackingStore.init();
  await payoutLog.init();
  const [initialStats, rewardMintDecimals, initialOpsState] = await Promise.all([
    getLedgerStats(),
    getRewardMintDecimals(),
    stateStore.read(),
  ]);
  const initialOps = readOpsSnapshot(initialOpsState);

  logger.banner(config.projectName, [
    `Wallet: ${shorten(creator.toBase58(), 8, 8)}`,
    `Holder mint: ${shorten(holderMint.toBase58(), 8, 8)}`,
    `Reward mint: ${shorten(rewardMint.toBase58(), 8, 8)}`,
    `RPCs: ${config.rpcUrls.length}`,
    `Interval: ${Math.floor(config.pollIntervalMs / 1000)}s`,
    `Mode: ${config.dryRun ? "DRY RUN" : "LIVE"}`,
  ]);

  logger.summaryBox("Launch Snapshot", [
    { label: "Holder min", value: `${config.holderMinTokens.toLocaleString()} tokens` },
    { label: "Cycle", value: `${Math.floor(config.pollIntervalMs / 1000)} seconds` },
    { label: "Min claim", value: `${config.minClaimSol} SOL` },
    { label: "Min swap", value: `${config.minSwapSol} SOL` },
    { label: "Min live round", value: formatUsd(config.minPayoutRoundUsd) },
    { label: "WBTC cap", value: `${config.maxPayerRewardInventory} WBTC` },
    { label: "Gas buffer", value: `${config.feeReserveSol} SOL` },
    { label: "Batch size", value: `${config.maxRecipientsPerTx} wallets/tx` },
    { label: "Payout crew", value: "Focused backlog mode" },
    { label: "Share rule", value: `1 share per full ${config.holderMinTokens.toLocaleString()}` },
    { label: "Hold bonus", value: `<24h ${formatMultiplier(10_000)} -> 30d+ ${formatMultiplier(12_000)}` },
    { label: "Paid total", value: `${initialStats.totalPaidRecipients} holders` },
    { label: "WBTC paid total", value: formatTokenAmountPretty(initialStats.totalPaidRewardRaw, rewardMintDecimals) },
    { label: "USD paid total", value: initialStats.totalPaidUsd === null ? "n/a" : formatUsd(initialStats.totalPaidUsd) },
    { label: "Ops debt", value: `${formatSol(initialOps.unreimbursedLamports)} SOL` },
    { label: "Ops fees total", value: `${formatSol(initialOps.totalFeeLamports)} SOL` },
    { label: "ATA rent total", value: `${formatSol(initialOps.totalAtaRentLamports)} SOL` },
  ], "brand");
  logger.ops(`state file: ${config.stateFilePath}`);
  logger.ops(`worker wallet: ${creator.toBase58()}`);
  logger.ops(`reward mint: ${rewardMint.toBase58()}`);
  logger.ops("this launch snapshot is static; the overlay pages keep updating live");
  logger.ops(
    `main claim check runs every ${Math.floor(config.pollIntervalMs / 1000)}s; backlog catchup runs every ${REPLAY_CATCHUP_DELAY_MS >= 1000 ? `${Math.floor(REPLAY_CATCHUP_DELAY_MS / 1000)}s` : `${REPLAY_CATCHUP_DELAY_MS}ms`} while something is still waiting`,
  );
  logger.ops("payout crew now focuses the biggest payable round first so newer live rewards clear faster");

  await runCycle();
  setInterval(() => {
    void runCycle();
  }, config.pollIntervalMs);
  scheduleReplayCatchup(2_000);
}

async function runCycle(): Promise<void> {
  if (cycleRunning || replayCatchupRunning) {
    queueClaimCycle();
    logger.warn("Previous cycle is still running, queuing the next claim cycle");
    return;
  }

  cycleRunning = true;
  try {
    await executeCycle();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Swap held:")) {
      logHoldMessage(message);
    } else {
      logger.error(message);
    }
  } finally {
    cycleRunning = false;
    maybeRunQueuedClaimCycle();
  }
}

function scheduleReplayCatchup(delayMs = REPLAY_CATCHUP_DELAY_MS): void {
  if (replayCatchupTimer) {
    return;
  }

  replayCatchupTimer = setTimeout(() => {
    replayCatchupTimer = null;
    void runReplayCatchup();
  }, delayMs);
}

async function runReplayCatchup(): Promise<void> {
  if (cycleRunning || replayCatchupRunning) {
    scheduleReplayCatchup();
    return;
  }

  replayCatchupRunning = true;
  try {
    const awaitingSwapSummary = await withTimeout(
      "Replay swap pass",
      processAwaitingSwapRounds(MAX_SWAP_REPLAYS_PER_CYCLE),
      REPLAY_PASS_TIMEOUT_MS,
    );
    const pendingSummary = await withTimeout(
      "Replay payout pass",
      resumePendingRounds(MAX_REPLAY_BATCHES_PER_CATCHUP),
      REPLAY_PASS_TIMEOUT_MS,
    );

    if (awaitingSwapSummary.awaitingSwapRounds > 0 || pendingSummary.pendingRecipients > 0) {
      logReplayHeartbeat(
        `background payouts active: ${awaitingSwapSummary.awaitingSwapRounds} swap round(s), ${pendingSummary.pendingRounds} backlog round(s), ${pendingSummary.pendingRecipients} payout${pendingSummary.pendingRecipients === 1 ? "" : "s"} still waiting, ${formatTokenAmountPretty(pendingSummary.pendingRewardRaw, await getRewardMintDecimals())} WBTC still waiting`,
      );
      scheduleReplayCatchup();
    } else {
      flushHoldSummary();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Swap held:")) {
      logHoldMessage(`${message} (background payouts)`);
    } else {
      logger.error(`Background replay failed: ${message}`);
    }
    scheduleReplayCatchup();
  } finally {
    replayCatchupRunning = false;
    maybeRunQueuedClaimCycle();
  }
}

async function executeCycle(): Promise<void> {
  const excludedOwners = new Set<string>([
    creator.toBase58(),
    treasury.toBase58(),
    ...config.excludedHolderAddresses,
  ]);

  logger.section("Main Check");
  const awaitingSwapSummary = await withTimeout(
    "Main swap replay pass",
    processAwaitingSwapRounds(MAX_SWAP_REPLAYS_PER_CYCLE),
    REPLAY_PASS_TIMEOUT_MS,
  );
  if (awaitingSwapSummary.awaitingSwapRounds > 0) {
    logHoldMessage(
      `Swap backlog active: ${awaitingSwapSummary.awaitingSwapRounds} round(s) still waiting to buy WBTC. Fresh claims will keep running.`,
    );
    scheduleReplayCatchup();
  }

  const pendingSummaryBeforeClaim = await withTimeout(
    "Main payout replay pass",
    resumePendingRounds(MAX_REPLAY_BATCHES_PER_CYCLE),
    REPLAY_PASS_TIMEOUT_MS,
  );
  if (pendingSummaryBeforeClaim.pendingRecipients > 0) {
    logHoldMessage(
      `Payout backlog active: ${pendingSummaryBeforeClaim.pendingRecipients} payout(s) still waiting. Fresh claims will keep running.`,
    );
    scheduleReplayCatchup();
  }

  const claimableLamports = await withTimeout(
    "Claimable rewards check",
    rpcPool.withFailover((rpc) => getPumpService(rpc).getClaimableLamports(creator)),
    CLAIMABLE_CHECK_TIMEOUT_MS,
  );
  logger.kv("Claimable rewards", `${formatSol(claimableLamports)} SOL`);

  if (claimableLamports < toLamports(config.minClaimSol)) {
    logger.info("Claimable rewards are below the minimum, so this check will wait for the next cycle.");
    return;
  }

  const holderSummary = await withTimeout(
    "Fresh holder scan",
    rpcPool.withFailover((rpc) =>
      getHolderSummary(
        rpc,
        holderMint,
        config.holderMinTokens,
        excludedOwners,
        config.skipOffCurveOwners,
      ),
    ),
    HOLDER_SCAN_TIMEOUT_MS,
  );
  const allEligibleHolders = await annotateEligibleHolders(holderSummary.eligible);
  const payability = await withTimeout(
    "Reward account scan",
    rpcPool.withFailover((rpc) =>
      getRewardAccountPayability(
        rpc,
        allEligibleHolders.map((holder) => holder.owner),
      ),
    ),
    REWARD_ACCOUNT_SCAN_TIMEOUT_MS,
  );
  const eligibleHolders = allEligibleHolders.filter((holder) => payability.payableOwners.has(holder.owner.toBase58()));
  const payableTotalShares = eligibleHolders.reduce((total, holder) => total + holder.shareCount, 0n);
  const totalWeightUnits = eligibleHolders.reduce((total, holder) => total + holder.weightUnits, 0n);
  const activeTierBreakdown = summarizeTierCounts(eligibleHolders);

  logger.summaryBox("Main Check", [
    { label: "Rewards ready", value: `${formatSol(claimableLamports)} SOL` },
    { label: "Wallets seen", value: String(holderSummary.totalOwners) },
    { label: "Eligible now", value: String(allEligibleHolders.length) },
    { label: "Can receive", value: String(eligibleHolders.length) },
    { label: "No-WBTC", value: String(payability.missingCount) },
    { label: "Reward shares", value: payableTotalShares.toString() },
    { label: "Hold bonus mix", value: activeTierBreakdown },
    { label: "Worker mode", value: config.dryRun ? "DRY RUN" : "LIVE EXECUTION" },
  ]);
  logger.callout(
    "qualified",
    `${eligibleHolders.length} wallets can receive right now across ${payableTotalShares.toString()} reward share(s)`,
  );
  if (eligibleHolders.length === 0) {
    logger.warn("Nobody is WBTC-ready right now. The holder share will roll forward until a payable wallet is found.");
  }

  if (config.dryRun) {
    const treasuryLamports = applyBps(claimableLamports, config.treasuryBps);
    const rewardLamports = applyBps(claimableLamports, config.holderRewardBps);
    logger.callout("live", "Dry run complete. No real transactions were sent.");
    logger.summaryBox("Dry Run Preview", [
      { label: "Would claim", value: `${formatSol(claimableLamports)} SOL` },
      { label: "Would route", value: `${formatSol(claimableLamports)} SOL` },
      { label: "Would pay", value: `${eligibleHolders.length} wallets` },
      { label: "No-WBTC", value: String(payability.missingCount) },
      { label: "Share rule", value: `1 share per full ${config.holderMinTokens.toLocaleString()} tokens` },
      { label: "Reward shares", value: payableTotalShares.toString() },
      { label: "Hold bonus mix", value: activeTierBreakdown },
    ], "hold");
    return;
  }

  const connection = rpcPool.current();
  const balanceBeforeClaim = BigInt(await connection.getBalance(creator, "confirmed"));
  const claimInstructions = await getPumpService(connection).buildClaimInstructions(creator);
  const claimTx = await sendInstructions(
    connection,
    signer,
    claimInstructions,
    config.priorityFeeMicroLamports,
    600_000,
  );
  const initialBalanceAfterClaim = BigInt(await connection.getBalance(creator, "confirmed"));
  const settledBalanceAfterClaim = await getSettledConfirmedBalance(connection, creator);
  const balanceAfterClaim = settledBalanceAfterClaim > initialBalanceAfterClaim
    ? settledBalanceAfterClaim
    : initialBalanceAfterClaim;
  const actualClaimedLamportsRaw = balanceAfterClaim - balanceBeforeClaim + claimTx.feeLamports;
  const actualClaimedLamports = actualClaimedLamportsRaw > 0n ? actualClaimedLamportsRaw : 0n;
  await recordOpsExpense(claimTx.feeLamports);

  if (balanceAfterClaim > initialBalanceAfterClaim) {
    logger.ops(`claim balance settled upward by ${formatSol(balanceAfterClaim - initialBalanceAfterClaim)} SOL before routing`);
  }
  if (actualClaimedLamports < claimableLamports) {
    logger.ops(
      `claim landed smaller than the preview amount: ${formatSol(actualClaimedLamports)} SOL confirmed vs ${formatSol(claimableLamports)} SOL previewed`,
    );
  }

  logger.callout("live", `Creator rewards claimed: ${formatSol(actualClaimedLamports)} SOL`);
  logger.tx("Claim signature", claimTx.signature);

  const feeReserveLamports = toLamports(config.feeReserveSol);
  const spendableBalance = balanceAfterClaim > feeReserveLamports
    ? balanceAfterClaim - feeReserveLamports
    : 0n;
  const processableLamports = actualClaimedLamports < spendableBalance
    ? actualClaimedLamports
    : spendableBalance;

  if (processableLamports <= 0n) {
    logger.warn("No spendable SOL was left after the fee reserve.");
    return;
  }

  const grossTreasuryLamports = applyBps(processableLamports, config.treasuryBps);
  const rewardLamports = processableLamports - grossTreasuryLamports;
  const treasuryChargeback = await chargeTreasuryForOps(grossTreasuryLamports);
  const treasuryLamports = treasuryChargeback.treasuryPayoutLamports;
  let treasurySignature: string | undefined;

  if (treasuryChargeback.treasuryOffsetLamports > 0n) {
    logger.summaryBox("Fee Recovery", [
      { label: "Gross routed", value: `${formatSol(grossTreasuryLamports)} SOL` },
      { label: "Fees repaid", value: `${formatSol(treasuryChargeback.treasuryOffsetLamports)} SOL` },
      { label: "Net routed", value: `${formatSol(treasuryLamports)} SOL` },
      { label: "Fees still owed", value: `${formatSol(treasuryChargeback.opsSnapshot.unreimbursedLamports)} SOL` },
    ], "hold");
  }

  if (treasuryLamports > 0n) {
    const treasuryTx = await sendInstructions(
      connection,
      signer,
      [
        SystemProgram.transfer({
          fromPubkey: creator,
          toPubkey: treasury,
          lamports: numberFromBigInt(treasuryLamports),
        }),
      ],
      config.priorityFeeMicroLamports,
      100_000,
    );
    treasurySignature = treasuryTx.signature;
    await recordOpsExpense(treasuryTx.feeLamports);

    logger.ops(`secondary transfer sent: ${formatSol(treasuryLamports)} SOL`);
    logger.ops(`secondary transfer signature: ${treasuryTx.signature}`);
  }

  const carryForwardRewardLamports = await getCarryForwardRewardLamports();

  if (eligibleHolders.length === 0) {
    const nextCarryForwardLamports = carryForwardRewardLamports + rewardLamports;
    await setCarryForwardRewardLamports(nextCarryForwardLamports);
    logger.warn("No payable holders were ready this cycle, so the reward pool was saved for later.");
    logger.summaryBox("Reward Pool", [
      { label: "Pool saved", value: `${formatSol(nextCarryForwardLamports)} SOL` },
      { label: "Eligible now", value: String(allEligibleHolders.length) },
      { label: "No-WBTC", value: String(payability.missingCount) },
      { label: "Can receive", value: "0" },
    ], "hold");
    return;
  }

  const balanceAfterTreasury = BigInt(await connection.getBalance(creator, "confirmed"));
  const swapBudgetLamports = balanceAfterTreasury > feeReserveLamports
    ? balanceAfterTreasury - feeReserveLamports
    : 0n;
  if (carryForwardRewardLamports > 0n) {
    logger.ops(`saved reward pool carried in: ${formatSol(carryForwardRewardLamports)} SOL`);
  }

  const combinedRewardLamports = rewardLamports + carryForwardRewardLamports;
  const finalRewardLamports = combinedRewardLamports < swapBudgetLamports
    ? combinedRewardLamports
    : swapBudgetLamports;
  const remainingCarryForwardLamports = combinedRewardLamports - finalRewardLamports;

  if (finalRewardLamports < toLamports(config.minSwapSol)) {
    const nextCarryForwardLamports = carryForwardRewardLamports + rewardLamports;
    await setCarryForwardRewardLamports(nextCarryForwardLamports);
    logger.callout("hold", "Reward pool is still too small to swap, so it was saved for the next round.");
    logger.summaryBox("Reward Pool", [
      { label: "Claimed now", value: `${formatSol(actualClaimedLamports)} SOL` },
      { label: "Pool saved", value: `${formatSol(nextCarryForwardLamports)} SOL` },
      { label: "Swap minimum", value: `${config.minSwapSol} SOL` },
      { label: "Can receive", value: String(eligibleHolders.length) },
    ], "hold");
    return;
  }

  const rewardTokenProgram = await detectTokenProgram(connection, rewardMint);
  const rewardMintInfo = await getMint(connection, rewardMint, "confirmed", rewardTokenProgram);
  const currentRewardInventoryRaw = await getRewardInventoryRaw(connection, rewardMint, rewardTokenProgram);
  const rewardInventoryCapRaw = getRewardInventoryCapRaw(rewardMintInfo.decimals);

  if (currentRewardInventoryRaw >= rewardInventoryCapRaw) {
    await setCarryForwardRewardLamports(combinedRewardLamports);
    logger.callout("hold", "Payout wallet is already holding enough WBTC, so this reward pool was saved for a smoother later round.");
    logger.summaryBox("Reward Pool", [
      { label: "Claimed now", value: `${formatSol(actualClaimedLamports)} SOL` },
      { label: "Pool saved", value: `${formatSol(combinedRewardLamports)} SOL` },
      { label: "WBTC ready", value: formatTokenAmountPretty(currentRewardInventoryRaw, rewardMintInfo.decimals) },
      { label: "WBTC cap", value: `${config.maxPayerRewardInventory} WBTC` },
    ], "hold");
    return;
  }

  const estimatedRoundUsd = await quoteSolToUsd(finalRewardLamports);
  if (estimatedRoundUsd !== null && estimatedRoundUsd < config.minPayoutRoundUsd) {
    await setCarryForwardRewardLamports(combinedRewardLamports);
    logger.callout("hold", "This holder round was still too small, so the reward pool was saved for a bigger cleaner payout.");
    logger.summaryBox("Reward Pool", [
      { label: "Claimed now", value: `${formatSol(actualClaimedLamports)} SOL` },
      { label: "Pool saved", value: `${formatSol(combinedRewardLamports)} SOL` },
      { label: "Live round floor", value: formatUsd(config.minPayoutRoundUsd) },
      { label: "Round value now", value: formatUsd(estimatedRoundUsd) },
    ], "hold");
    return;
  }

  const round = await enqueueRound({
    snapshotOwnerCount: holderSummary.totalOwners,
    eligibleHolderCount: eligibleHolders.length,
    totalShareCount: holderSummary.totalShares,
    totalWeightUnits,
    actualClaimedLamports,
    plannedRewardLamportsIn: finalRewardLamports,
    remainingCarryForwardLamports,
    claimTx: claimTx.signature,
    treasuryTx: treasurySignature,
    recipients: eligibleHolders.map((holder) => ({
      owner: holder.owner.toBase58(),
      holderBalanceRaw: holder.rawBalance.toString(),
      shareCount: holder.shareCount.toString(),
      holdMultiplierBps: holder.holdMultiplierBps,
      holdTierLabel: holder.holdTierLabel,
      eligibleSince: holder.eligibleSince,
      weightUnitsRaw: holder.weightUnits.toString(),
      amountRaw: "0",
      status: "pending" as const,
      attempts: 0,
    })),
  });
  logger.callout("queued", `Round saved and waiting to buy WBTC: ${round.id}`);

  const senderRewardAta = getAssociatedTokenAddressSync(rewardMint, creator, false, rewardTokenProgram);
  const rewardBalanceBefore = currentRewardInventoryRaw;
  const swap = await swapSolForToken({
    connection,
    signer,
    outputMint: rewardMint,
    lamportsIn: finalRewardLamports,
    slippageBps: config.slippageBps,
  });
  await recordOpsExpense(swap.feeLamports);
  const rewardBalanceAfter = await getTokenBalanceOrZero(connection, senderRewardAta);
  const actualRewardAmount = rewardBalanceAfter - rewardBalanceBefore;

  logger.callout(
    "live",
    `WBTC bought for holders: ${formatTokenAmountPretty(actualRewardAmount, rewardMintInfo.decimals)}`,
  );
  logger.tx("Swap signature", swap.signature);
  logger.kv("Expected WBTC", formatTokenAmountPretty(swap.quotedOutAmount, rewardMintInfo.decimals));

  const recipientAmounts = eligibleHolders.map((holder) => ({
    holder,
    amountRaw: (actualRewardAmount * holder.weightUnits) / totalWeightUnits,
  }));
  const distributedRewardRaw = recipientAmounts.reduce((total, item) => total + item.amountRaw, 0n);
  const rewardDust = actualRewardAmount - distributedRewardRaw;
  const rewardUsd = await quoteTokenToUsd(rewardMint, actualRewardAmount);

  if (recipientAmounts.some((item) => item.amountRaw <= 0n)) {
    logger.warn("This round was too small to split fairly into non-zero payouts.");
    return;
  }

  const topPreview = recipientAmounts
    .slice(0, 5)
    .map(({ holder, amountRaw }) => {
      return `${shorten(holder.owner.toBase58())} (${holder.shareCount.toString()} share${holder.shareCount === 1n ? "" : "s"} | ${formatHoldAge(holder.holdDurationMs)} | ${holder.holdTierLabel} ${formatMultiplier(holder.holdMultiplierBps)} | ${formatTokenAmountPretty(amountRaw, rewardMintInfo.decimals)})`;
    });
  logger.summaryBox("Payout Plan", [
    { label: "Wallets in round", value: String(eligibleHolders.length) },
    { label: "Reward shares", value: holderSummary.totalShares.toString() },
    { label: "Hold bonus mix", value: activeTierBreakdown },
    { label: "Claimed now", value: `${formatSol(actualClaimedLamports)} SOL` },
    { label: "WBTC bought", value: formatTokenAmountPretty(actualRewardAmount, rewardMintInfo.decimals) },
    { label: "Approx value", value: rewardUsd === null ? "n/a" : formatUsd(rewardUsd) },
    { label: "1 base share", value: formatTokenAmountPretty(actualRewardAmount / holderSummary.totalShares, rewardMintInfo.decimals) },
    { label: "Top sample", value: topPreview.join(", ") || "n/a" },
    { label: "Carry dust", value: formatTokenAmountPretty(rewardDust, rewardMintInfo.decimals) },
  ], "success");
  await finalizeRoundAfterSwap(round.id, {
    rewardTokenDecimals: rewardMintInfo.decimals,
    recipientAmounts: recipientAmounts.map((item) => ({
      owner: item.holder.owner.toBase58(),
      amountRaw: item.amountRaw,
    })),
    actualRewardAmount,
    rewardUsdMicros: toUsdMicros(rewardUsd),
    rewardDust,
    swapTx: swap.signature,
  });

  logger.callout("queued", "Holder payout round saved to the ledger");
  const pendingSummaryAfterEnqueue = await withTimeout(
    "Immediate post-swap payout replay",
    resumePendingRounds(MAX_REPLAY_BATCHES_PER_CYCLE),
    REPLAY_PASS_TIMEOUT_MS,
  );
  if (pendingSummaryAfterEnqueue.pendingRecipients === 0) {
    const stats = await getLedgerStats();
    logger.callout("settled", "Round fully paid");
    logger.summaryBox("Paid Summary", [
      { label: "Claimed now", value: `${formatSol(actualClaimedLamports)} SOL` },
      { label: "WBTC sent", value: formatTokenAmountPretty(actualRewardAmount, rewardMintInfo.decimals) },
      { label: "Approx value", value: rewardUsd === null ? "n/a" : formatUsd(rewardUsd) },
      { label: "Paid now", value: `${eligibleHolders.length} holders` },
      { label: "Paid total", value: `${stats.totalPaidRecipients} holders` },
      { label: "Rounds total", value: `${stats.totalRounds} rounds` },
      { label: "WBTC paid total", value: formatTokenAmountPretty(stats.totalPaidRewardRaw, rewardMintInfo.decimals) },
      { label: "USD paid total", value: stats.totalPaidUsd === null ? "n/a" : formatUsd(stats.totalPaidUsd) },
    ], "success");
  } else {
    logger.callout(
      "hold",
      `Backlog still waiting: ${pendingSummaryAfterEnqueue.pendingRecipients} payout(s) left`,
    );
    scheduleReplayCatchup();
  }
}

async function getRewardMintDecimals(): Promise<number> {
  if (rewardMintDecimalsCache !== null) {
    return rewardMintDecimalsCache;
  }

  const connection = rpcPool.current();
  const rewardTokenProgram = await detectTokenProgram(connection, rewardMint);
  const rewardMintInfo = await getMint(connection, rewardMint, "confirmed", rewardTokenProgram);
  rewardMintDecimalsCache = rewardMintInfo.decimals;
  return rewardMintDecimalsCache;
}

async function detectTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const account = await connection.getAccountInfo(mint, "confirmed");
  if (!account) {
    throw new Error(`Mint account not found: ${mint.toBase58()}`);
  }

  if (account.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return TOKEN_2022_PROGRAM_ID;
  }

  if (account.owner.equals(TOKEN_PROGRAM_ID)) {
    return TOKEN_PROGRAM_ID;
  }

  throw new Error(`Unsupported mint owner for ${mint.toBase58()}: ${account.owner.toBase58()}`);
}

async function getTokenBalanceOrZero(connection: Connection, ata: PublicKey): Promise<bigint> {
  const balance = await connection.getTokenAccountBalance(ata, "confirmed").catch(() => null);
  return BigInt(balance?.value.amount ?? "0");
}

function applyBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10_000n;
}

function numberFromBigInt(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Lamport value is too large to fit into a number");
  }
  return Number(value);
}

function parseDecimalUnits(value: string, decimals: number): bigint {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid decimal amount: ${value}`);
  }

  const [wholePart = "0", fractionalPart = ""] = normalized.split(".");
  const safeFraction = fractionalPart.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(wholePart) * 10n ** BigInt(decimals) + BigInt(safeFraction || "0");
}

async function quoteSolToUsd(lamports: bigint): Promise<number | null> {
  return quoteTokenToUsd(SOL_MINT, lamports);
}

function getRewardInventoryCapRaw(decimals: number): bigint {
  return parseDecimalUnits(config.maxPayerRewardInventory, decimals);
}

async function getRewardInventoryRaw(
  connection: Connection,
  mintKey: PublicKey,
  tokenProgram: PublicKey,
): Promise<bigint> {
  const rewardAta = getAssociatedTokenAddressSync(mintKey, creator, false, tokenProgram);
  return getTokenBalanceOrZero(connection, rewardAta);
}

function getPumpService(connection: Connection): PumpService {
  return new PumpService(new OnlinePumpSdk(connection));
}

async function enqueueRound(params: {
  snapshotOwnerCount: number;
  eligibleHolderCount: number;
  totalShareCount: bigint;
  totalWeightUnits: bigint;
  actualClaimedLamports: bigint;
  plannedRewardLamportsIn: bigint;
  remainingCarryForwardLamports: bigint;
  claimTx: string;
  treasuryTx?: string;
  recipients: PayoutRecipientState[];
}): Promise<PayoutRoundState> {
  const state = await stateStore.read();
  const round: PayoutRoundState = {
    id: createRoundId(),
    status: "awaiting_swap",
    createdAt: new Date().toISOString(),
    sourceWallet: creator.toBase58(),
    holderMint: holderMint.toBase58(),
    rewardMint: rewardMint.toBase58(),
    actualClaimedLamports: params.actualClaimedLamports.toString(),
    snapshotOwnerCount: params.snapshotOwnerCount,
    eligibleHolderCount: params.eligibleHolderCount,
    totalShareCount: params.totalShareCount.toString(),
    totalWeightUnitsRaw: params.totalWeightUnits.toString(),
    plannedRewardLamportsIn: params.plannedRewardLamportsIn.toString(),
    claimTx: params.claimTx,
    treasuryTx: params.treasuryTx,
    recipients: params.recipients,
  };
  state.carryForwardRewardLamports = params.remainingCarryForwardLamports.toString();
  state.rounds.push(round);
  await stateStore.write(state);
  return round;
}

async function finalizeRoundAfterSwap(roundId: string, params: {
  rewardTokenDecimals: number;
  recipientAmounts: Array<{ owner: string; amountRaw: bigint }>;
  actualRewardAmount: bigint;
  rewardUsdMicros: bigint | null;
  rewardDust: bigint;
  swapTx: string;
}): Promise<void> {
  const state = await stateStore.read();
  const round = state.rounds.find((item) => item.id === roundId);
  if (!round) {
    throw new Error(`Round not found: ${roundId}`);
  }

  round.status = "pending";
  round.rewardTokenDecimals = params.rewardTokenDecimals;
  round.amountPerRecipientRaw = undefined;
  round.amountPerShareRaw = undefined;
  round.totalRewardRaw = params.actualRewardAmount.toString();
  round.rewardUsdMicros = params.rewardUsdMicros?.toString();
  round.rewardDustRaw = params.rewardDust.toString();
  round.swapTx = params.swapTx;
  round.plannedRewardLamportsIn = undefined;
  round.nextSwapRetryAt = undefined;

  const recipientAmountMap = new Map(params.recipientAmounts.map((item) => [item.owner, item.amountRaw]));
  for (const recipient of round.recipients) {
    recipient.amountRaw = (recipientAmountMap.get(recipient.owner) ?? 0n).toString();
  }

  await stateStore.write(state);
}

async function finalizeRoundAsDust(roundId: string, params: {
  rewardTokenDecimals: number;
  actualRewardAmount: bigint;
  rewardUsdMicros: bigint | null;
  rewardDust: bigint;
  swapTx: string;
  note: string;
}): Promise<void> {
  const state = await stateStore.read();
  const round = state.rounds.find((item) => item.id === roundId);
  if (!round) {
    throw new Error(`Round not found: ${roundId}`);
  }

  round.status = "complete";
  round.completedAt = new Date().toISOString();
  round.rewardTokenDecimals = params.rewardTokenDecimals;
  round.totalRewardRaw = params.actualRewardAmount.toString();
  round.rewardUsdMicros = params.rewardUsdMicros?.toString();
  round.rewardDustRaw = params.rewardDust.toString();
  round.swapTx = params.swapTx;
  round.plannedRewardLamportsIn = undefined;
  round.nextSwapRetryAt = undefined;
  round.completionNote = params.note;

  for (const recipient of round.recipients) {
    recipient.amountRaw = "0";
    recipient.lastError = params.note;
  }

  await stateStore.write(state);
}

async function processAwaitingSwapRounds(maxRoundsToProcess = Number.POSITIVE_INFINITY): Promise<{ awaitingSwapRounds: number }> {
  const state = await stateStore.read();
  const awaitingRounds = state.rounds.filter((round) => round.status === "awaiting_swap");

  if (awaitingRounds.length === 0) {
    return { awaitingSwapRounds: 0 };
  }

  logger.summaryBox("Swap Queue", [
    { label: "Rounds waiting", value: String(awaitingRounds.length) },
  ], "hold");

  let processedRounds = 0;
  const nowMs = Date.now();

  for (const round of awaitingRounds) {
    if (processedRounds >= maxRoundsToProcess) {
      break;
    }

    const nextSwapRetryMs = round.nextSwapRetryAt ? new Date(round.nextSwapRetryAt).getTime() : 0;
    if (Number.isFinite(nextSwapRetryMs) && nextSwapRetryMs > nowMs) {
      continue;
    }

    const rewardLamportsIn = BigInt(round.plannedRewardLamportsIn ?? "0");
    if (rewardLamportsIn <= 0n) {
      continue;
    }

    logger.callout("resumed", `Retrying WBTC buy for ${round.id}`);

    try {
      const connection = rpcPool.current();
      const rewardMintKey = new PublicKey(round.rewardMint);
      const rewardTokenProgram = await detectTokenProgram(connection, rewardMintKey);
      const rewardMintInfo = await getMint(connection, rewardMintKey, "confirmed", rewardTokenProgram);
      const currentRewardInventoryRaw = await getRewardInventoryRaw(connection, rewardMintKey, rewardTokenProgram);
      const rewardInventoryCapRaw = getRewardInventoryCapRaw(rewardMintInfo.decimals);
      const estimatedRoundUsd = await quoteSolToUsd(rewardLamportsIn);

      if (estimatedRoundUsd !== null && estimatedRoundUsd < config.minPayoutRoundUsd) {
        const carryForwardLamports = BigInt(state.carryForwardRewardLamports ?? "0");
        state.carryForwardRewardLamports = (carryForwardLamports + rewardLamportsIn).toString();
        round.status = "complete";
        round.completedAt = new Date().toISOString();
        round.plannedRewardLamportsIn = undefined;
        round.nextSwapRetryAt = undefined;
        round.completionNote = `Merged back into the saved reward pool because the live round was below ${formatUsd(config.minPayoutRoundUsd)}`;
        await stateStore.write(state);
        logger.callout("hold", `Saved round folded back into the reward pool until it grows bigger: ${round.id}`);
        processedRounds += 1;
        continue;
      }

      if (currentRewardInventoryRaw >= rewardInventoryCapRaw) {
        round.nextSwapRetryAt = new Date(Date.now() + SWAP_RETRY_COOLDOWN_MS).toISOString();
        await stateStore.write(state);
        logHoldMessage(
          `Payout wallet already has ${formatTokenAmountPretty(currentRewardInventoryRaw, rewardMintInfo.decimals)} WBTC ready, so ${round.id} will wait before buying more`,
        );
        processedRounds += 1;
        continue;
      }

      const senderRewardAta = getAssociatedTokenAddressSync(
        rewardMintKey,
        creator,
        false,
        rewardTokenProgram,
      );
      const rewardBalanceBefore = currentRewardInventoryRaw;
      const swap = await swapSolForToken({
        connection,
        signer,
        outputMint: rewardMintKey,
        lamportsIn: rewardLamportsIn,
        slippageBps: config.slippageBps,
      });
      const rewardBalanceAfter = await getTokenBalanceOrZero(connection, senderRewardAta);
      const actualRewardAmount = rewardBalanceAfter - rewardBalanceBefore;
      const totalWeightUnits = getRoundTotalWeightUnits(round);
      const recipientAmounts = round.recipients.map((recipient) => ({
        owner: recipient.owner,
        amountRaw: (actualRewardAmount * getRecipientWeightUnits(recipient)) / totalWeightUnits,
      }));
      const distributedRewardRaw = recipientAmounts.reduce((total, item) => total + item.amountRaw, 0n);
      const rewardDust = actualRewardAmount - distributedRewardRaw;

      if (recipientAmounts.some((item) => item.amountRaw <= 0n)) {
        const dustNote = "Swap output was too small to split fairly; amount left as dust in sender inventory";
        await finalizeRoundAsDust(round.id, {
          rewardTokenDecimals: rewardMintInfo.decimals,
          actualRewardAmount,
          rewardUsdMicros: toUsdMicros(await quoteTokenToUsd(rewardMintKey, actualRewardAmount)),
          rewardDust: actualRewardAmount,
          swapTx: swap.signature,
          note: dustNote,
        });
        logger.callout("hold", `Tiny round retired as dust: ${round.id}`);
        processedRounds += 1;
        continue;
      }

      await finalizeRoundAfterSwap(round.id, {
        rewardTokenDecimals: rewardMintInfo.decimals,
        recipientAmounts,
        actualRewardAmount,
        rewardUsdMicros: toUsdMicros(await quoteTokenToUsd(rewardMintKey, actualRewardAmount)),
        rewardDust,
        swapTx: swap.signature,
      });

      logger.callout(
        "live",
        `WBTC bought for holders: ${formatTokenAmountPretty(actualRewardAmount, rewardMintInfo.decimals)}`,
      );
      logger.tx("Swap signature", swap.signature);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Swap held:")) {
        round.nextSwapRetryAt = new Date(Date.now() + SWAP_RETRY_COOLDOWN_MS).toISOString();
        await stateStore.write(state);
        logHoldMessage(`${message} (${round.id})`);
      } else {
        logger.error(`Swap replay failed for ${round.id}: ${message}`);
      }
    }

    processedRounds += 1;
  }

  const refreshedState = await stateStore.read();
  return {
    awaitingSwapRounds: refreshedState.rounds.filter((round) => round.status === "awaiting_swap").length,
  };
}

async function resumePendingRounds(maxBatchesToProcess = Number.POSITIVE_INFINITY): Promise<{
  pendingRounds: number;
  pendingRecipients: number;
  pendingRewardRaw: bigint;
}> {
  const state = await stateStore.read();
  const pendingRounds = state.rounds.filter((round) => round.status === "pending");

  if (pendingRounds.length === 0) {
    logger.ops("backlog payouts: 0");
    return { pendingRounds: 0, pendingRecipients: 0, pendingRewardRaw: 0n };
  }

  const pendingRecipientsTotal = pendingRounds.reduce(
    (total, round) => total + round.recipients.filter((recipient) => recipient.status === "pending").length,
    0,
  );
  const pendingRewardRaw = pendingRounds.reduce((total, round) => {
    return total + round.recipients.reduce((roundTotal, recipient) => {
      if (recipient.status !== "pending") {
        return roundTotal;
      }
      return roundTotal + BigInt(recipient.amountRaw);
    }, 0n);
  }, 0n);
  const rewardDecimals = await getRewardMintDecimals();

  logger.summaryBox("Replay Queue", [
    { label: "Backlog rounds", value: String(pendingRounds.length) },
    {
      label: "Unsent payouts",
      value: String(pendingRecipientsTotal),
    },
    { label: "WBTC waiting", value: formatTokenAmountPretty(pendingRewardRaw, rewardDecimals) },
  ], "hold");

  let processedBatches = 0;
  let currentEligibleOwners: Set<string> | null = null;

  try {
    currentEligibleOwners = await getCurrentEligibleOwnerSet();
  } catch (error) {
    logger.warn(`Could not refresh the live holder list before backlog replay: ${error instanceof Error ? error.message : String(error)}`);
  }

  const replayQueue = sortPendingRoundsForReplay(pendingRounds);

  for (const { round } of replayQueue) {
    if (round.nextPayoutRetryAt) {
      const retryAt = Date.parse(round.nextPayoutRetryAt);
      if (Number.isFinite(retryAt) && retryAt > Date.now()) {
        continue;
      }
      round.nextPayoutRetryAt = undefined;
    }

    if (currentEligibleOwners) {
      const droppedAt = new Date().toISOString();
      let droppedCount = 0;

      for (const recipient of round.recipients) {
        if (recipient.status !== "pending") {
          continue;
        }

        if (currentEligibleOwners.has(recipient.owner)) {
          continue;
        }

        recipient.status = "dropped";
        recipient.droppedAt = droppedAt;
        recipient.dropReason = `No longer holds ${config.holderMinTokens.toLocaleString()}+ tokens at replay time`;
        recipient.lastError = recipient.dropReason;
        droppedCount += 1;
      }

      if (droppedCount > 0) {
        logger.callout("hold", `Dropped ${droppedCount} wallet(s) from ${round.id} because they no longer hold enough.`);
      }
    }

    const roundPendingRecipients = round.recipients.filter((recipient) => recipient.status === "pending");

    if (roundPendingRecipients.length === 0) {
      round.status = "complete";
      round.completedAt = new Date().toISOString();
      continue;
    }

    logger.callout(
      "resumed",
      `Continuing ${round.id}: ${roundPendingRecipients.length} payout(s) still waiting`,
    );

    const rewardMintKey = new PublicKey(round.rewardMint);
    const connection = rpcPool.current();
    const tokenProgram = await rpcPool.withFailover((rpc) => detectTokenProgram(rpc, rewardMintKey));
    const sourceAta = getAssociatedTokenAddressSync(rewardMintKey, creator, false, tokenProgram);
    const availableRewards = await getTokenBalanceOrZero(connection, sourceAta);
    const payableRecipients = selectPayableRecipients(roundPendingRecipients, availableRewards);

    logger.summaryBox("Replay Round", [
      { label: "Round", value: round.id },
      { label: "Left to pay", value: String(roundPendingRecipients.length) },
      { label: "WBTC ready", value: formatTokenAmountPretty(availableRewards, round.rewardTokenDecimals ?? 0) },
      { label: "Reward mint", value: shorten(round.rewardMint, 8, 8) },
    ], "info");

    if (payableRecipients.length <= 0) {
      logger.warn(`The sender wallet does not have enough WBTC right now to continue ${round.id}.`);
      continue;
    }

    const payableBatches = chunk(payableRecipients, config.maxRecipientsPerTx);

    for (const [batchIndex, batch] of payableBatches.entries()) {
      if (processedBatches >= maxBatchesToProcess) {
      logger.ops(`backlog budget reached for this pass, ${roundPendingRecipients.length} payout(s) still left in ${round.id}`);
        break;
      }

      logger.progress(
        "Payout batch",
        batchIndex + 1,
        payableBatches.length,
        ` ${batch.length} wallet(s)`,
      );
      try {
        const result = await sendDistributionBatch({
          connection,
          signer,
          mint: rewardMintKey,
          tokenProgram,
          recipients: batch.map((recipient) => ({
            owner: new PublicKey(recipient.owner),
            amountRaw: BigInt(recipient.amountRaw),
          })),
          maxRecipientsPerTx: config.maxRecipientsPerTx,
          priorityFeeMicroLamports: config.priorityFeeMicroLamports,
        });
        await recordOpsExpense(result.feeLamports, result.createdAtaRentLamports);
        const deliveredOwners = new Set(result.deliveredOwners);
        const deliveredRecipients = batch.filter((recipient) => deliveredOwners.has(recipient.owner));

        const paidAt = new Date().toISOString();
        round.nextPayoutRetryAt = undefined;
        for (const recipient of deliveredRecipients) {
          recipient.status = "paid";
          recipient.txSignature = result.signature;
          recipient.paidAt = paidAt;
          recipient.lastAttemptAt = paidAt;
          recipient.attempts += 1;
          recipient.lastError = undefined;
        }

        await stateStore.write(state);
        await payoutLog.appendBatch({
          roundId: round.id,
          rewardMint: round.rewardMint,
          rewardDecimals: round.rewardTokenDecimals ?? 0,
          txSignature: result.signature,
          paidAt,
          recipients: deliveredRecipients.map((recipient) => ({
            owner: recipient.owner,
            amountRaw: recipient.amountRaw,
            shareCount: recipient.shareCount,
            holdTierLabel: recipient.holdTierLabel,
            holdMultiplierBps: recipient.holdMultiplierBps,
            holderBalanceRaw: recipient.holderBalanceRaw,
          })),
        });

        logger.success(`Paid ${deliveredRecipients.length} wallet(s)`);
        if (result.createdAtaCount > 0) {
          logger.ops(
            `created ${result.createdAtaCount} new WBTC account(s), rent ${formatSol(result.createdAtaRentLamports)} SOL`,
          );
        }
        logger.tx("Payout signature", result.signature);
      } catch (error) {
        const message = formatDistributionError(error);
        if (message.startsWith("Payout hold:")) {
          const now = Date.now();
          if (message.includes("no-WBTC accounts")) {
            round.nextPayoutRetryAt = new Date(now + NO_WBTC_ACCOUNT_RETRY_COOLDOWN_MS).toISOString();
          } else if (message.includes("needs a little more SOL for wallet setup and network fees")) {
            round.nextPayoutRetryAt = new Date(now + LOW_SOL_RETRY_COOLDOWN_MS).toISOString();
          }
          logHoldMessage(message);
          await stateStore.write(state);
          break;
        }
        const attemptedAt = new Date().toISOString();
        for (const recipient of batch) {
          recipient.attempts += 1;
          recipient.lastAttemptAt = attemptedAt;
          recipient.lastError = message;
        }
        logger.error(`Payout batch failed for ${round.id}: ${message}`);
        await stateStore.write(state);
        processedBatches += 1;
        break;
      }

      processedBatches += 1;
    }

    if (round.recipients.every((recipient) => recipient.status !== "pending")) {
      round.status = "complete";
      round.completedAt = new Date().toISOString();
      logger.callout("settled", `Round finished: ${round.id}`);
      const stats = await getLedgerStatsFromState(state);
      const roundRewardRaw = BigInt(round.totalRewardRaw ?? "0");
      const roundUsd = fromUsdMicros(round.rewardUsdMicros ? BigInt(round.rewardUsdMicros) : null)
        ?? await quoteTokenToUsd(rewardMint, roundRewardRaw);
      const paidCount = round.recipients.filter((recipient) => recipient.status === "paid").length;
      const droppedCount = round.recipients.filter((recipient) => recipient.status === "dropped").length;
      logger.summaryBox("Round Complete", [
        { label: "Claimed now", value: `${formatSol(BigInt(round.actualClaimedLamports ?? "0"))} SOL` },
        { label: "WBTC sent", value: formatTokenAmountPretty(roundRewardRaw, round.rewardTokenDecimals ?? 0) },
        { label: "Approx value", value: roundUsd === null ? "n/a" : formatUsd(roundUsd) },
        { label: "Paid now", value: `${paidCount} holders` },
        { label: "Dropped now", value: `${droppedCount} holders` },
        { label: "Paid total", value: `${stats.totalPaidRecipients} holders` },
        { label: "Rounds total", value: `${stats.totalRounds} rounds` },
        { label: "WBTC paid total", value: formatTokenAmountPretty(stats.totalPaidRewardRaw, round.rewardTokenDecimals ?? 0) },
        { label: "USD paid total", value: stats.totalPaidUsd === null ? "n/a" : formatUsd(stats.totalPaidUsd) },
      ], "success");
    }

    if (processedBatches >= maxBatchesToProcess) {
      break;
    }
  }

  await stateStore.write(state);

  const remainingPendingRounds = state.rounds.filter((round) => round.status === "pending");
  const remainingPendingRecipients = remainingPendingRounds.reduce(
    (total, round) => total + round.recipients.filter((recipient) => recipient.status === "pending").length,
    0,
  );

  return {
    pendingRounds: remainingPendingRounds.length,
    pendingRecipients: remainingPendingRecipients,
    pendingRewardRaw: remainingPendingRounds.reduce((total, round) => {
      return total + round.recipients.reduce((roundTotal, recipient) => {
        if (recipient.status !== "pending") {
          return roundTotal;
        }
        return roundTotal + BigInt(recipient.amountRaw);
      }, 0n);
    }, 0n),
  };
}

function createRoundId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `round-${timestamp}`;
}

function formatTokenAmountPretty(amount: bigint, decimals: number): string {
  if (amount === 0n) {
    return "0";
  }

  const precise = formatTokenAmount(amount, decimals, Math.min(Math.max(decimals, 6), 8));
  return precise.replace(/\.?0+$/, "");
}

async function getCarryForwardRewardLamports(): Promise<bigint> {
  const state = await stateStore.read();
  return BigInt(state.carryForwardRewardLamports ?? "0");
}

async function setCarryForwardRewardLamports(amount: bigint): Promise<void> {
  const state = await stateStore.read();
  state.carryForwardRewardLamports = amount.toString();
  await stateStore.write(state);
}

type OpsCostSnapshot = {
  unreimbursedLamports: bigint;
  totalFeeLamports: bigint;
  totalAtaRentLamports: bigint;
  totalTreasuryOffsetLamports: bigint;
};

function readOpsSnapshot(state: {
  unreimbursedOpsLamports?: string;
  totalOpsFeeLamports?: string;
  totalAtaRentLamports?: string;
  totalTreasuryOffsetLamports?: string;
}): OpsCostSnapshot {
  return {
    unreimbursedLamports: BigInt(state.unreimbursedOpsLamports ?? "0"),
    totalFeeLamports: BigInt(state.totalOpsFeeLamports ?? "0"),
    totalAtaRentLamports: BigInt(state.totalAtaRentLamports ?? "0"),
    totalTreasuryOffsetLamports: BigInt(state.totalTreasuryOffsetLamports ?? "0"),
  };
}

async function recordOpsExpense(feeLamports: bigint, ataRentLamports = 0n): Promise<OpsCostSnapshot> {
  if (feeLamports <= 0n && ataRentLamports <= 0n) {
    const state = await stateStore.read();
    return readOpsSnapshot(state);
  }

  const state = await stateStore.read();
  const snapshot = readOpsSnapshot(state);
  const totalExpense = feeLamports + ataRentLamports;

  state.unreimbursedOpsLamports = (snapshot.unreimbursedLamports + totalExpense).toString();
  state.totalOpsFeeLamports = (snapshot.totalFeeLamports + feeLamports).toString();
  state.totalAtaRentLamports = (snapshot.totalAtaRentLamports + ataRentLamports).toString();
  await stateStore.write(state);

  return readOpsSnapshot(state);
}

async function chargeTreasuryForOps(grossTreasuryLamports: bigint): Promise<{
  treasuryPayoutLamports: bigint;
  treasuryOffsetLamports: bigint;
  opsSnapshot: OpsCostSnapshot;
}> {
  const state = await stateStore.read();
  const snapshot = readOpsSnapshot(state);
  const treasuryOffsetLamports = grossTreasuryLamports < snapshot.unreimbursedLamports
    ? grossTreasuryLamports
    : snapshot.unreimbursedLamports;

  state.unreimbursedOpsLamports = (snapshot.unreimbursedLamports - treasuryOffsetLamports).toString();
  state.totalTreasuryOffsetLamports = (snapshot.totalTreasuryOffsetLamports + treasuryOffsetLamports).toString();
  await stateStore.write(state);

  return {
    treasuryPayoutLamports: grossTreasuryLamports - treasuryOffsetLamports,
    treasuryOffsetLamports,
    opsSnapshot: readOpsSnapshot(state),
  };
}

async function getLedgerStats(): Promise<LedgerStats> {
  const state = await stateStore.read();
  return getLedgerStatsFromState(state);
}

type LedgerStats = {
  totalRounds: number;
  totalPaidRecipients: number;
  totalPaidRewardRaw: bigint;
  totalPaidUsd: number | null;
};

async function getLedgerStatsFromState(state: { rounds: PayoutRoundState[] }): Promise<LedgerStats> {
  const totalRounds = state.rounds.length;
  const totalPaidRecipients = state.rounds.reduce(
    (total, round) => total + round.recipients.filter((recipient) => recipient.status === "paid").length,
    0,
  );
  const totalPaidRewardRaw = state.rounds.reduce((total, round) => {
    if (round.rewardMint !== rewardMint.toBase58()) {
      return total;
    }

    return total + round.recipients.reduce((roundTotal, recipient) => {
      if (recipient.status !== "paid") {
        return roundTotal;
      }
      return roundTotal + BigInt(recipient.amountRaw);
    }, 0n);
  }, 0n);
  let storedPaidUsd = 0;
  let storedPaidRewardRaw = 0n;
  let missingRewardRaw = 0n;

  for (const round of state.rounds) {
    const paidRewardRaw = round.recipients.reduce((roundTotal, recipient) => {
      if (recipient.status !== "paid") {
        return roundTotal;
      }
      return roundTotal + BigInt(recipient.amountRaw);
    }, 0n);
    const roundStoredUsd = fromUsdMicros(round.rewardUsdMicros ? BigInt(round.rewardUsdMicros) : null);
    if (roundStoredUsd !== null) {
      const roundTotalRewardRaw = BigInt(round.totalRewardRaw ?? "0");
      if (roundTotalRewardRaw > 0n && paidRewardRaw > 0n) {
        storedPaidUsd += roundStoredUsd * (Number(paidRewardRaw) / Number(roundTotalRewardRaw));
        storedPaidRewardRaw += paidRewardRaw;
      }
      continue;
    }

    missingRewardRaw += paidRewardRaw;
  }

  let totalPaidUsd: number | null;
  if (missingRewardRaw <= 0n) {
    totalPaidUsd = storedPaidUsd;
  } else if (storedPaidUsd > 0 && storedPaidRewardRaw > 0n) {
    const impliedUsdPerRaw = storedPaidUsd / Number(storedPaidRewardRaw);
    totalPaidUsd = storedPaidUsd + (Number(missingRewardRaw) * impliedUsdPerRaw);
  } else {
    const missingUsd = await quoteTokenToUsd(rewardMint, missingRewardRaw);
    if (missingUsd === null) {
      if (lastGoodMissingPaidUsdCache && lastGoodMissingPaidUsdCache.raw === missingRewardRaw.toString()) {
        totalPaidUsd = storedPaidUsd + lastGoodMissingPaidUsdCache.usd;
      } else {
        totalPaidUsd = storedPaidUsd > 0 ? storedPaidUsd : null;
      }
    } else {
      lastGoodMissingPaidUsdCache = {
        raw: missingRewardRaw.toString(),
        usd: missingUsd,
      };
      totalPaidUsd = storedPaidUsd + missingUsd;
    }
  }

  return {
    totalRounds,
    totalPaidRecipients,
    totalPaidRewardRaw,
    totalPaidUsd,
  };
}

function getRecipientShareCount(recipient: Pick<PayoutRecipientState, "shareCount">): bigint {
  return BigInt(recipient.shareCount ?? "1");
}

function getRecipientWeightUnits(recipient: Pick<PayoutRecipientState, "weightUnitsRaw" | "shareCount" | "holdMultiplierBps">): bigint {
  if (recipient.weightUnitsRaw) {
    return BigInt(recipient.weightUnitsRaw);
  }

  const shareCount = getRecipientShareCount(recipient);
  const multiplierBps = BigInt(recipient.holdMultiplierBps ?? 10_000);
  return shareCount * multiplierBps;
}

function getRoundTotalWeightUnits(round: Pick<PayoutRoundState, "totalWeightUnitsRaw" | "recipients" | "eligibleHolderCount">): bigint {
  if (round.totalWeightUnitsRaw) {
    return BigInt(round.totalWeightUnitsRaw);
  }

  const derivedTotal = round.recipients.reduce((total, recipient) => total + getRecipientWeightUnits(recipient), 0n);
  if (derivedTotal > 0n) {
    return derivedTotal;
  }

  return BigInt(Math.max(round.eligibleHolderCount, 1));
}

function selectPayableRecipients(recipients: PayoutRecipientState[], availableRewards: bigint): PayoutRecipientState[] {
  const payable: PayoutRecipientState[] = [];
  let runningTotal = 0n;

  for (const recipient of recipients) {
    const amountRaw = BigInt(recipient.amountRaw);
    if (amountRaw <= 0n) {
      continue;
    }

    if (runningTotal + amountRaw > availableRewards) {
      break;
    }

    payable.push(recipient);
    runningTotal += amountRaw;
  }

  return payable;
}

function getHoldTier(holdDurationMs: number): HoldTier {
  const matchedTier = HOLD_TIERS.find((tier) => holdDurationMs >= tier.minMs);
  return matchedTier ?? HOLD_TIERS[HOLD_TIERS.length - 1]!;
}

function formatMultiplier(multiplierBps: number): string {
  return `${(multiplierBps / 10_000).toFixed(2)}x`;
}

function formatHoldAge(holdDurationMs: number): string {
  if (holdDurationMs >= DAY_MS) {
    const days = Math.floor(holdDurationMs / DAY_MS);
    return `${days}d`;
  }

  const hours = Math.floor(holdDurationMs / HOUR_MS);
  return `${hours}h`;
}

async function annotateEligibleHolders(
  holders: Array<{
    owner: PublicKey;
    rawBalance: bigint;
    shareCount: bigint;
  }>,
): Promise<EligibleHolderWithTier[]> {
  const now = new Date();
  const nowIso = now.toISOString();
  const state = await holdTrackingStore.read();
  const nextHolders: Record<string, { eligibleSince: string; lastSeenAt: string; isGrandfathered: boolean }> = {};

  const annotated = holders.map((holder) => {
    const owner = holder.owner.toBase58();
    const existing = state.holders[owner];
    const eligibleSince = existing?.eligibleSince ?? nowIso;
    const eligibleSinceMs = new Date(eligibleSince).getTime();
    const holdDurationMs = Number.isFinite(eligibleSinceMs)
      ? Math.max(0, now.getTime() - eligibleSinceMs)
      : 0;
    const tier = getHoldTier(holdDurationMs);
    const weightUnits = holder.shareCount * BigInt(tier.multiplierBps);

    nextHolders[owner] = {
      eligibleSince,
      lastSeenAt: nowIso,
      isGrandfathered: false,
    };

    return {
      owner: holder.owner,
      rawBalance: holder.rawBalance,
      shareCount: holder.shareCount,
      eligibleSince,
      holdDurationMs,
      holdTierLabel: tier.label,
      holdMultiplierBps: tier.multiplierBps,
      weightUnits,
    };
  });

  await holdTrackingStore.write({
    version: 1,
    holders: nextHolders,
  });

  return annotated;
}

function summarizeTierCounts(holders: EligibleHolderWithTier[]): string {
  const counts = new Map<string, number>();
  for (const holder of holders) {
    counts.set(holder.holdTierLabel, (counts.get(holder.holdTierLabel) ?? 0) + 1);
  }

  return HOLD_TIERS
    .map((tier) => {
      const count = counts.get(tier.label) ?? 0;
      return count > 0 ? `${tier.label}:${count}` : null;
    })
    .filter((value): value is string => value !== null)
    .join(" ");
}

function formatDistributionError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.toLowerCase();

  if (
    normalized.includes("insufficient funds for rent")
    || normalized.includes("insufficient lamports")
    || normalized.includes("need 2039280")
  ) {
    return "Payout hold: the sender wallet needs a little more SOL for wallet setup and network fees";
  }

  if (normalized.includes("versionedtransaction too large") || normalized.includes("too large")) {
    return "Payout hold: this payout batch was too large for Solana, so the bot will retry more safely";
  }

  if (normalized.includes("blockhash not found")) {
    return "Payout hold: the network expired this batch, so the bot will retry on the next pass";
  }

  return raw;
}

function toUsdMicros(value: number | null): bigint | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return BigInt(Math.round(value * 1_000_000));
}

function fromUsdMicros(value: bigint | null): number | null {
  if (value === null) {
    return null;
  }
  return Number(value) / 1_000_000;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Swap held:")) {
    logHoldMessage(message);
  } else {
    logger.error(message);
  }
  process.exit(1);
});
