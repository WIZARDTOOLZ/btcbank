import { redisGetJson } from "./_kv.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const TIER_DEFS = [
  { label: "Satoshi", minMs: 30 * DAY_MS, multiplier: 1.2, icon: "₿" },
  { label: "OG", minMs: 14 * DAY_MS, multiplier: 1.12, icon: "🏦" },
  { label: "Veteran", minMs: 7 * DAY_MS, multiplier: 1.07, icon: "🧱" },
  { label: "Miner", minMs: 3 * DAY_MS, multiplier: 1.03, icon: "⛏️" },
  { label: "Stacker", minMs: 1 * DAY_MS, multiplier: 1.01, icon: "📦" },
  { label: "Holder", minMs: 0, multiplier: 1.0, icon: "🪙" },
  { label: "Locked", minMs: 0, multiplier: 0, icon: "🔒" },
];

export const FALLBACK_LIVE_PAYLOAD = {
  updatedAt: 0,
  stats: {
    holderMinTokens: 300000,
    holderMint: "9s96G11xGsHczudfJqKQzQxzvubQgJXSySJ1wRgxpump",
    rewardMint: "5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ",
    allTimeUsd: 20474.79,
    allTimeWbtc: "0.26754025",
    holdersPaid: 312892,
    roundsCompleted: 789,
    currentRound: 789,
    qualifiedThisRound: 258,
    paidThisRound: 258,
    currentRoundWbtc: "0.00010845",
    currentRoundUsd: 8.3,
    latestRoundUsd: 8.3,
    biggestRoundNumber: 0,
    biggestRoundPaid: 800,
    biggestRoundWbtc: "0.00524304",
    btcPrice: 76530,
    nextCycleSeconds: 300,
    source: "fallback",
  },
  holders: [],
  txs: [],
  walletPayments: {},
};

export async function getLivePayload() {
  const payload = await redisGetJson("btcbank:live");
  const stats = payload?.stats ?? {};
  const hasRealTotals = safeNumber(stats.allTimeUsd, 0) > 0
    || safeNumber(stats.allTimeWbtc, 0) > 0
    || safeInteger(stats.roundsCompleted, 0) > 0;

  if (!payload || !hasRealTotals) {
    return FALLBACK_LIVE_PAYLOAD;
  }

  return payload;
}

export function safeNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").replace(/[^0-9.\-]/g, "");
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

export function safeInteger(value, fallback = 0) {
  return Math.trunc(safeNumber(value, fallback));
}

export function shortenAddress(value, left = 4, right = 4) {
  if (!value || typeof value !== "string") {
    return "—";
  }
  if (value.length <= left + right) {
    return value;
  }
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatUsd(value, digits = 0) {
  return `$${safeNumber(value, 0).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function resolveBtcPrice(stats = {}) {
  const directPrice = safeNumber(stats?.btcPrice, 0);
  const impliedPrice = safeNumber(stats?.allTimeUsd, 0) / Math.max(safeNumber(stats?.allTimeWbtc, 0), 0.00000001);

  if (directPrice >= 30000) {
    return directPrice;
  }
  if (impliedPrice >= 30000) {
    return impliedPrice;
  }
  return directPrice;
}

export function formatCount(value) {
  return safeInteger(value, 0).toLocaleString("en-US");
}

export function formatCompactCount(value) {
  const number = safeNumber(value, 0);
  if (number >= 1_000_000) {
    return `${(number / 1_000_000).toFixed(1)}M`;
  }
  if (number >= 1_000) {
    return `${Math.round(number / 1_000)}K`;
  }
  return String(Math.round(number));
}

export function formatWbtc(value, digits = 8) {
  return safeNumber(value, 0).toFixed(digits);
}

export function mapWalletPayment(payment, btcPrice = 0) {
  const wbtcAmount = safeNumber(payment?.wbtcAmount ?? payment?.amountWbtc ?? payment?.amount ?? 0, 0);
  const wbtcUsd = payment?.wbtcUsd === undefined || payment?.wbtcUsd === null
    ? wbtcAmount * safeNumber(btcPrice, 0)
    : safeNumber(payment.wbtcUsd, 0);

  return {
    round: safeInteger(payment?.round ?? payment?.roundNumber ?? 0, 0),
    roundId: payment?.roundId ?? "",
    signature: payment?.signature ?? payment?.sig ?? "",
    wbtcAmount,
    wbtcUsd,
    tier: payment?.tier ?? payment?.holdTier ?? "Holder",
    timestamp: safeNumber(payment?.timestamp ?? payment?.time ?? Date.now(), Date.now()),
  };
}

export function getHolderWallet(holder) {
  return holder?.wallet ?? holder?.owner ?? holder?.address ?? "";
}

export function getHolderTokens(holder) {
  return safeNumber(holder?.balanceTokens ?? holder?.tokens ?? holder?.balance ?? 0, 0);
}

export function holderQualifies(holder, minimumTokens = 300000) {
  if (typeof holder?.qualified === "boolean") {
    return holder.qualified;
  }
  return getHolderTokens(holder) >= minimumTokens;
}

export function getHolderShares(holder, minimumTokens = 300000) {
  const explicit = holder?.shareCount ?? holder?.shares;
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    return Math.max(0, safeInteger(explicit, 0));
  }
  const tokens = getHolderTokens(holder);
  return Math.max(0, Math.floor(tokens / minimumTokens));
}

export function getHoldAgeMs(holder) {
  if (holder?.eligibleSince) {
    const ageMs = Date.now() - new Date(holder.eligibleSince).getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0) {
      return ageMs;
    }
  }
  return null;
}

export function formatHoldAge(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return "n/a";
  }
  if (ageMs >= DAY_MS) {
    const days = Math.floor(ageMs / DAY_MS);
    const hours = Math.floor((ageMs % DAY_MS) / (60 * 60 * 1000));
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  if (hours > 0) {
    const minutes = Math.floor((ageMs % (60 * 60 * 1000)) / (60 * 1000));
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  const minutes = Math.max(1, Math.floor(ageMs / (60 * 1000)));
  return `${minutes}m`;
}

export function formatEtaFromMs(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs <= 0) {
    return "now";
  }
  if (ageMs >= DAY_MS) {
    const days = Math.floor(ageMs / DAY_MS);
    const hours = Math.floor((ageMs % DAY_MS) / (60 * 60 * 1000));
    return hours > 0 ? `~${days}d ${hours}h` : `~${days}d`;
  }
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  if (hours > 0) {
    const minutes = Math.floor((ageMs % (60 * 60 * 1000)) / (60 * 1000));
    return minutes > 0 ? `~${hours}h ${minutes}m` : `~${hours}h`;
  }
  const minutes = Math.floor(ageMs / (60 * 1000));
  const seconds = Math.floor((ageMs % (60 * 1000)) / 1000);
  return minutes > 0 ? `~${minutes}m ${seconds}s` : `~${Math.max(1, seconds)}s`;
}

export function getTierByLabel(label) {
  if (!label) {
    return null;
  }
  return TIER_DEFS.find((tier) => tier.label.toLowerCase() === String(label).toLowerCase()) ?? null;
}

export function getTierByAge(ageMs) {
  return TIER_DEFS.find((tier) => tier.label !== "Locked" && ageMs >= tier.minMs) ?? TIER_DEFS[5];
}

export function getTierByMultiplier(multiplier) {
  const number = safeNumber(multiplier, NaN);
  if (!Number.isFinite(number)) {
    return null;
  }
  return TIER_DEFS.find((tier) => Math.abs(tier.multiplier - number) < 0.005) ?? null;
}

export function getHolderMultiplier(holder) {
  const explicit = holder?.holdMultiplier ?? holder?.multiplier;
  const number = safeNumber(typeof explicit === "string" ? explicit.replace(/x$/i, "") : explicit, NaN);
  if (Number.isFinite(number)) {
    return number;
  }
  const labelTier = getTierByLabel(holder?.holdTier ?? holder?.holdTierLabel ?? holder?.tier);
  if (labelTier) {
    return labelTier.multiplier;
  }
  const ageMs = getHoldAgeMs(holder);
  if (ageMs !== null) {
    return getTierByAge(ageMs).multiplier;
  }
  return holderQualifies(holder) ? 1 : 0;
}

export function getHolderTier(holder, minimumTokens = 300000) {
  const explicitTier = getTierByLabel(holder?.holdTier ?? holder?.holdTierLabel ?? holder?.tier);
  if (explicitTier) {
    return explicitTier;
  }
  if (!holderQualifies(holder, minimumTokens)) {
    return TIER_DEFS[TIER_DEFS.length - 1];
  }
  const ageMs = getHoldAgeMs(holder);
  if (ageMs !== null) {
    return getTierByAge(ageMs);
  }
  const multiplierTier = getTierByMultiplier(getHolderMultiplier(holder));
  if (multiplierTier) {
    return multiplierTier;
  }
  return getTierByLabel("Holder");
}

export function findHolderByWallet(holders, wallet) {
  if (!wallet) {
    return null;
  }
  const normalized = String(wallet).trim().toLowerCase();
  return holders.find((holder) => getHolderWallet(holder).toLowerCase() === normalized) ?? null;
}

export function buildWalletCheckResult(holder, wallet, minimumTokens = 300000) {
  if (!holder) {
    return {
      found: false,
      wallet,
      minimumTokens,
      message: "Wallet not found in the current qualifying-holder snapshot.",
    };
  }

  const tokens = getHolderTokens(holder);
  const qualifies = holderQualifies(holder, minimumTokens);
  const shareCount = getHolderShares(holder, minimumTokens);
  const tier = getHolderTier(holder, minimumTokens);
  const multiplier = getHolderMultiplier(holder);
  const holdAgeMs = getHoldAgeMs(holder);
  const holdAgeText = holder?.holdAge ?? (holdAgeMs !== null ? formatHoldAge(holdAgeMs) : (qualifies ? "timer active" : "below minimum"));
  const orderedTiers = TIER_DEFS.filter((entry) => entry.label !== "Locked").slice().reverse();
  const currentIndex = orderedTiers.findIndex((entry) => entry.label === tier.label);
  const nextTier = holdAgeMs !== null && currentIndex >= 0 && currentIndex < orderedTiers.length - 1
    ? orderedTiers[currentIndex + 1]
    : null;
  const nextTierEtaMs = nextTier && holdAgeMs !== null ? Math.max(0, nextTier.minMs - holdAgeMs) : null;
  const tokensNeeded = qualifies ? 0 : Math.max(0, minimumTokens - tokens);
  const wbtcReady = holder?.hasWbtcAccount ?? holder?.wbtcReady ?? holder?.hasRewardAccount ?? null;
  const payableNow = holder?.payableNow ?? (wbtcReady === null ? null : qualifies && Boolean(wbtcReady));
  const totalWbtcEarned = safeNumber(holder?.totalWbtcEarned ?? holder?.wbtcEarned ?? holder?.earnedWbtc ?? 0, 0);
  const totalWbtcUsd = safeNumber(holder?.totalWbtcUsd ?? holder?.wbtcUsd ?? 0, 0);
  const nextEstimatedWbtc = safeNumber(holder?.nextEstimatedWbtc ?? holder?.nextWbtc ?? 0, 0);
  const nextEstimatedUsd = safeNumber(holder?.nextEstimatedUsd ?? 0, 0);
  const paymentsReceived = safeInteger(holder?.paymentsReceived ?? holder?.paymentCount ?? holder?.paidCount ?? 0, 0);
  const roundsQualified = safeInteger(holder?.roundsQualified ?? holder?.rounds ?? holder?.qualifiedRounds ?? 0, 0);
  const lastPaidWbtc = safeNumber(holder?.lastPaidWbtc ?? 0, 0);
  const lastPaidUsd = safeNumber(holder?.lastPaidUsd ?? 0, 0);

  return {
    found: true,
    wallet: getHolderWallet(holder) || wallet,
    minimumTokens,
    balanceTokens: formatCount(tokens),
    balanceRaw: tokens,
    qualifiesNow: qualifies,
    shareCount,
    holdAge: holdAgeText,
    holdTier: tier.label,
    holdMultiplier: `${multiplier.toFixed(2)}x`,
    rewardPower: (shareCount * multiplier).toFixed(2),
    eligibleSince: holder?.eligibleSince ?? null,
    nextTier: nextTier?.label ?? null,
    nextTierEta: nextTierEtaMs !== null ? formatEtaFromMs(nextTierEtaMs) : null,
    tokensNeeded: formatCount(tokensNeeded),
    hasWbtcAccount: wbtcReady,
    payableNow,
    totalWbtcEarned: totalWbtcEarned.toFixed(8),
    totalWbtcUsd,
    nextEstimatedWbtc: nextEstimatedWbtc.toFixed(8),
    nextEstimatedUsd,
    paymentsReceived,
    roundsQualified,
    lastPaidAt: holder?.lastPaidAt ?? null,
    lastPaidWbtc: lastPaidWbtc.toFixed(8),
    lastPaidUsd,
    lastPaidTx: holder?.lastPaidTx ?? null,
    message: qualifies
      ? "This wallet qualifies right now. Stop jeeting. Stop selling. Let the Bitcoin side compound."
      : `This wallet is below the ${formatCount(minimumTokens)} BTCBANK reward line right now.`,
  };
}

export function mapLeaderboardHolder(holder, minimumTokens = 300000, btcPrice = 0) {
  const tier = getHolderTier(holder, minimumTokens);
  const totalWbtcEarned = safeNumber(holder?.totalWbtcEarned ?? holder?.wbtcEarned ?? holder?.earnedWbtc ?? 0, 0);
  const price = safeNumber(btcPrice, 0);
  return {
    wallet: getHolderWallet(holder),
    shortAddress: shortenAddress(getHolderWallet(holder), 4, 4),
    balance: getHolderTokens(holder),
    multiplier: getHolderMultiplier(holder),
    tier: tier.label,
    tierIcon: tier.icon,
    totalWbtcEarned,
    wbtcUsd: totalWbtcEarned * price,
    roundsQualified: safeInteger(holder?.roundsQualified ?? holder?.rounds ?? holder?.qualifiedRounds ?? 0, 0),
    qualified: holderQualifies(holder, minimumTokens),
    shareCount: getHolderShares(holder, minimumTokens),
    holdAge: holder?.holdAge ?? (getHoldAgeMs(holder) !== null ? formatHoldAge(getHoldAgeMs(holder)) : "n/a"),
  };
}

export function mapTransaction(tx) {
  return {
    wallet: tx?.wallet ?? tx?.owner ?? "",
    shortAddress: shortenAddress(tx?.wallet ?? tx?.owner ?? "", 4, 4),
    signature: tx?.signature ?? tx?.sig ?? "",
    round: safeInteger(tx?.round ?? tx?.roundNumber ?? 0, 0),
    wbtcAmount: safeNumber(tx?.wbtcAmount ?? tx?.amountWbtc ?? tx?.amount ?? 0, 0),
    tier: tx?.tier ?? tx?.holdTier ?? "Holder",
    timestamp: safeNumber(tx?.timestamp ?? tx?.time ?? Date.now(), Date.now()),
  };
}
