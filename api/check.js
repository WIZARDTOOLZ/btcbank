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
    paymentsReceived: 0,
    roundsQualified: 0,
    lastPaidAt: null,
    lastPaidWbtc: "0.00000000",
    lastPaidUsd: 0,
    lastPaidTx: null,
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
  const blockedNoWbtc = result?.qualifiesNow === true && result?.hasWbtcAccount === false;
  const underLine = result?.qualifiesNow === false;
  const paymentsReceived = Math.max(safeInteger(result?.paymentsReceived ?? 0, 0), payments.length);
  const lastPayment = payments[0] ?? null;
  const publishedLastPaidWbtc = Number(result?.lastPaidWbtc ?? 0);
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
  const paymentStatus = underLine ? "not-qualified" : blockedNoWbtc ? "blocked" : result?.payableNow ? "ready" : "waiting";
  const paymentStatusTitle = underLine
    ? "Not qualified yet"
    : blockedNoWbtc
      ? "Qualified, but WBTC unlock is needed"
      : result?.payableNow
        ? "Ready for automatic payouts"
        : "Qualified, waiting for the next payable pass";
  const paymentStatusCopy = underLine
    ? "This wallet is below the reward line, so it cannot receive holder payouts yet."
    : blockedNoWbtc
      ? "The wallet has enough BTCBANK, but it has never opened/held WBTC. Unlock WBTC once, then future payouts can land automatically."
      : result?.payableNow
        ? "This wallet is eligible and WBTC-ready. If a round is large enough, it can receive the next automatic payout."
        : "This wallet qualifies, but the live feed has not marked it payable yet. This usually updates on the next worker sync.";

  return {
    ...result,
    message: blockedNoWbtc
      ? "This wallet qualifies by BTCBANK balance, but it has not received payouts yet because WBTC is not unlocked in the wallet."
      : underLine
        ? result?.message
        : result?.message,
    totalWbtcUsd,
    nextEstimatedWbtc: nextEstimatedWbtc.toFixed(8),
    nextEstimatedUsd,
    paymentsReceived,
    lastPaidAt: result?.lastPaidAt ?? (lastPayment?.timestamp ? new Date(lastPayment.timestamp).toISOString() : null),
    lastPaidWbtc: publishedLastPaidWbtc > 0
      ? publishedLastPaidWbtc.toFixed(8)
      : (lastPayment ? Number(lastPayment.wbtcAmount || 0).toFixed(8) : "0.00000000"),
    lastPaidUsd: Number(result?.lastPaidUsd ?? 0) || Number(lastPayment?.wbtcUsd ?? 0),
    lastPaidTx: result?.lastPaidTx ?? lastPayment?.signature ?? null,
    paymentStatus,
    paymentStatusTitle,
    paymentStatusCopy,
    payments,
    paymentCountShown: payments.length,
    paymentNote: blockedNoWbtc
      ? "No-WBTC wallets cannot receive SPL token payouts until the wallet has a WBTC token account. BTCBANK is not skipping this wallet; it is blocked by wallet setup."
      : paymentsReceived === 0
        ? "No completed payouts are published for this wallet yet. If it is WBTC-ready, it should be watched through the next qualifying round."
        : "Recent payments below are real on-chain payout transactions. Approx next payment is an estimate and changes every round.",
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
