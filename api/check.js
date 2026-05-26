import {
  buildWalletCheckResult,
  findHolderByWallet,
  getLivePayload,
  safeInteger,
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
    message: qualifiesNow
      ? "This wallet qualifies on-chain right now. Hold-time bonus details appear once the live tracker syncs it."
      : `This wallet is below the ${minimumTokens.toLocaleString("en-US")} BTCBANK reward line right now.`,
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

    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ found: false, message: error?.message ?? "wallet_check_error" }));
  }
}
