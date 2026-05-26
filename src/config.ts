import { config as loadEnv } from "dotenv";

loadEnv();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function parseNumber(name: string, fallback: string): number {
  const raw = optional(name, fallback);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Env var ${name} must be a valid number`);
  }
  return value;
}

function parseDecimalString(name: string, fallback: string): string {
  const raw = optional(name, fallback);
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new Error(`Env var ${name} must be a positive decimal number`);
  }
  return raw;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const raw = optional(name, String(fallback)).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function parseCsv(name: string): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  projectName: optional("PROJECT_NAME", "WrappedBTC Reward Worker"),
  rpcUrls: parseCsv("SOLANA_RPC_URLS"),
  jupiterApiKey: process.env.JUPITER_API_KEY?.trim() || "",
  devPrivateKey: required("DEV_PRIVATE_KEY"),
  holderMint: required("HOLDER_MINT"),
  rewardMint: required("REWARD_MINT"),
  treasuryAddress: required("TREASURY_ADDRESS"),
  pollIntervalMs: parseNumber("POLL_INTERVAL_MS", "180000"),
  minClaimSol: parseNumber("MIN_CLAIM_SOL", "0.01"),
  minSwapSol: parseNumber("MIN_SWAP_SOL", "0.005"),
  minPayoutRoundUsd: parseNumber("MIN_PAYOUT_ROUND_USD", "10"),
  holderMinTokens: parseNumber("HOLDER_MIN_TOKENS", "500000"),
  grandfatherMinTokens: parseNumber("GRANDFATHER_MIN_TOKENS", "250000"),
  treasuryBps: parseNumber("TREASURY_BPS", "2000"),
  holderRewardBps: parseNumber("HOLDER_REWARD_BPS", "8000"),
  slippageBps: parseNumber("SLIPPAGE_BPS", "100"),
  priorityFeeMicroLamports: parseNumber("PRIORITY_FEE_MICROLAMPORTS", "50000"),
  maxPayerRewardInventory: parseDecimalString("MAX_PAYER_REWARD_INVENTORY", "0.01"),
  autoCreateRecipientAtas: parseBoolean("AUTO_CREATE_RECIPIENT_ATAS", true),
  feeReserveSol: parseNumber("FEE_RESERVE_SOL", "0.1"),
  maxRecipientsPerTx: parseNumber("MAX_RECIPIENTS_PER_TX", "8"),
  skipOffCurveOwners: parseBoolean("SKIP_OFF_CURVE_OWNERS", true),
  dryRun: parseBoolean("DRY_RUN", false),
  excludedHolderAddresses: parseCsv("EXCLUDED_HOLDER_ADDRESSES"),
  grandfatherFilePath: optional("GRANDFATHER_FILE_PATH", "data/grandfathered.json"),
  holdTrackingFilePath: optional("HOLD_TRACKING_FILE_PATH", "data/hold-tracking.json"),
  stateFilePath: optional("STATE_FILE_PATH", "data/state.json"),
  workerLockFilePath: optional("WORKER_LOCK_FILE_PATH", "data/worker.lock"),
};

if (config.rpcUrls.length === 0) {
  throw new Error("SOLANA_RPC_URLS must contain at least one RPC URL");
}

if (config.treasuryBps + config.holderRewardBps !== 10_000) {
  throw new Error("TREASURY_BPS + HOLDER_REWARD_BPS must equal 10000");
}

if (config.maxRecipientsPerTx < 1) {
  throw new Error("MAX_RECIPIENTS_PER_TX must be at least 1");
}
