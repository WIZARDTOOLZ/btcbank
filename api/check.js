import {
  buildWalletCheckResult,
  findHolderByWallet,
  getHolderMultiplier,
  getHolderShares,
  getLivePayload,
  mapWalletPayment,
  resolveBtcPrice,
  safeInteger,
  safeNumber,
} from "./_shared.js";

async function buildDirectWalletCheck(wallet, minimumTokens, stats = {}) {
  const rpcUrl = (process.env.SOLANA_RPC_URLS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)[0] || process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";
  const holderMintRaw = process.env.HOLDER_MINT?.trim() || String(stats.holderMint ?? "").trim();
  const rewardMintRaw = process.env.REWARD_MINT?.trim() || String(stats.rewardMint ?? "").trim();

  if (!holderMintRaw || !rewardMintRaw) {
    return null;
  }

  let id = 1;
  async function rpc(method, params) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
    }
    const body = await response.json();
    if (body?.error) {
      throw new Error(body.error.message ?? `${method} RPC error`);
    }
    return body?.result;
  }

  const holderAccounts = await rpc("getTokenAccountsByOwner", [
    wallet,
    { mint: holderMintRaw },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);

  let tokens = 0;
  for (const account of holderAccounts?.value ?? []) {
    const tokenAmount = account?.account?.data?.parsed?.info?.tokenAmount;
    const uiAmount = Number(tokenAmount?.uiAmountString ?? tokenAmount?.uiAmount ?? 0);
    if (Number.isFinite(uiAmount)) {
      tokens += uiAmount;
      continue;
    }
    const amount = Number(tokenAmount?.amount ?? 0);
    const decimals = Number(tokenAmount?.decimals ?? 0);
    if (Number.isFinite(amount) && Number.isFinite(decimals)) {
      tokens += amount / 10 ** decimals;
    }
  }

  const qualifiesNow = tokens >= minimumTokens;
  const shareCount = qualifiesNow ? Math.floor(tokens / minimumTokens) : 0;
  const tokensNeeded = qualifiesNow ? 0 : Math.max(0, minimumTokens - tokens);
  const rewardAccounts = await rpc("getTokenAccountsByOwner", [
    wallet,
    { mint: rewardMintRaw },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  const hasWbtcAccount = (rewardAccounts?.value ?? []).length > 0;

  return {
    found: true,
    wallet,
    minimumTokens,
    balanceTokens: tokens.toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 6,
    }),
    balanceRaw: tokens,
    qualifiesNow,
    shareCount,
    holdAge: qualifiesNow ? "timer active after live sync" : "timer inactive",
    holdTier: qualifiesNow ? "Holder" : "below minimum",
    holdMultiplier: qualifiesNow ? "1.00x" : "0.00x",
    rewardPower: qualifiesNow ? Number(shareCount).toFixed(2) : "0.00",
    eligibleSince: null,
    nextTier: null,
    nextTierEta: null,
    tokensNeeded: tokensNeeded.toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 6,
    }),
    hasWbtcAccount,
    payableNow: hasWbtcAccount === null ? null : qualifiesNow && hasWbtcAccount,
    totalWbtcEarned: "0.00000000",
    totalWbtcUsd: 0,
    nextEstimatedWbtc: "0.00000000",
    nextEstimatedUsd: 0,
    payments: [],
    message: qualifiesNow
      ? "This wallet qualifies on-chain right now. Hold-time bonus details appear once the live tracker syncs it."
      : `This wallet is below the ${minimumTokens.toLocaleString("en-US")} BTCBANK reward line right now.`,
  };
}

function findWalletPayments(payload, wallet, btcPrice) {
  const normalized = String(wallet ?? "").trim().toLowerCase();
  const paymentsByWallet = payload?.walletPayments ?? {};
  const key = Object.keys(paymentsByWallet).find((entry) => entry.toLowerCase() === normalized);
  let rows = key ? paymentsByWallet[key] : [];
  if (!Array.isArray(rows) || rows.length === 0) {
    rows = (payload?.txs ?? []).filter((tx) => String(tx?.wallet ?? "").trim().toLowerCase() === normalized);
  }

  return Array.isArray(rows)
    ? rows.map((payment) => mapWalletPayment(payment, btcPrice)).sort((a, b) => b.timestamp - a.timestamp)
    : [];
}

function attachPaymentDetails(result, payload, wallet) {
  const stats = payload?.stats ?? {};
  const btcPrice = resolveBtcPrice(stats);
  const payments = findWalletPayments(payload, result?.wallet || wallet, btcPrice);
  const totalWbtc = Number(result?.totalWbtcEarned ?? 0);
  const totalWbtcUsd = Number(result?.totalWbtcUsd ?? 0) || totalWbtc * btcPrice;
  let nextEstimatedWbtc = Number(result?.nextEstimatedWbtc ?? 0);
  if (!nextEstimatedWbtc && result?.qualifiesNow) {
    const minimumTokens = safeInteger(stats.holderMinTokens ?? 300000, 300000);
    const totalRewardPower = (payload?.holders ?? []).reduce((sum, holder) => {
      return sum + getHolderShares(holder, minimumTokens) * getHolderMultiplier(holder);
    }, 0);
    const holderRewardPower = safeNumber(result.rewardPower, 0);
    const baselineRoundWbtc = safeNumber(stats.currentRoundWbtc || stats.biggestRoundWbtc || 0, 0);
    nextEstimatedWbtc = totalRewardPower > 0 ? (baselineRoundWbtc * holderRewardPower) / totalRewardPower : 0;
  }
  const nextEstimatedUsd = Number(result?.nextEstimatedUsd ?? 0) || nextEstimatedWbtc * btcPrice;

  return {
    ...result,
    totalWbtcUsd,
    nextEstimatedWbtc: nextEstimatedWbtc.toFixed(8),
    nextEstimatedUsd,
    payments,
    paymentCountShown: payments.length,
    paymentNote: result?.payableNow === false && result?.qualifiesNow
      ? "This wallet qualifies, but it needs the one-time WBTC account unlock before future payouts can land."
      : "Next payment is an estimate based on the most recent paid round size and this wallet's current reward power.",
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  try {
    const url = new URL(req.url || "/", "http://localhost");
    const wallet = (url.searchParams.get("wallet") ?? "").trim();
    if (!wallet) {
      res.statusCode = 400;
      res.end(JSON.stringify({ found: false, message: "Missing wallet parameter." }));
      return;
    }

    const payload = await getLivePayload();
    const stats = payload?.stats ?? {};
    const minimumTokens = safeInteger(stats.holderMinTokens ?? 300000, 300000);
    const holders = payload?.holders ?? [];
    let result = buildWalletCheckResult(findHolderByWallet(holders, wallet), wallet, minimumTokens);
    if (!result.found) {
      try {
        const directResult = await buildDirectWalletCheck(wallet, minimumTokens, stats);
        if (directResult) {
          result = directResult;
        }
      } catch (error) {
        result = {
          found: false,
          wallet,
          message: `Wallet was not in the live holder snapshot, and the on-chain fallback could not complete: ${error?.message ?? "unknown error"}`,
        };
      }
    }
    result = attachPaymentDetails(result, payload, wallet);

    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ found: false, message: error?.message ?? "wallet_check_error" }));
  }
}
